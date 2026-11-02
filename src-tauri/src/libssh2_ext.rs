//! The libssh2 calls the `ssh2` crate does not wrap, and nothing else.
//!
//! `libssh2-sys` is the copy `ssh2` links, so these run on the same sessions.
//! `libssh2_session_callback_set2` and `libssh2_userauth_publickey` are public
//! libssh2 API that `libssh2-sys` does not declare; they are declared here.
//! Nothing reaches into a private libssh2 struct.
//!
//! Two rules keep this sound, and every wrapper below relies on them:
//!
//! - A session is not thread-safe; `ssh2` serialises it with a mutex.
//!   [`with_session`] holds that mutex, and each call that needs it takes the
//!   [`Locked`] token only that function can create.
//! - libssh2 owns a [`RawChannel`] until [`RawChannel::free`] finishes or the
//!   session is freed, whichever comes first, so whoever holds one must also
//!   hold a clone of its `Session`.

use std::ffi::{c_char, c_int, c_uchar, c_ulong, c_void, CString};
use std::io;
use std::marker::PhantomData;
use std::mem;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;
use std::sync::Arc;

use libssh2_sys as raw;
use ssh2::Session;

/// `LIBSSH2_CALLBACK_AUTHAGENT` in `libssh2.h`.
const CALLBACK_AUTHAGENT: c_int = 7;

/// `LIBSSH2_AUTHAGENT_FUNC` in `libssh2.h`.
type AgentChannelFn =
    extern "C" fn(*mut raw::LIBSSH2_SESSION, *mut raw::LIBSSH2_CHANNEL, *mut *mut c_void);

/// `LIBSSH2_USERAUTH_PUBLICKEY_SIGN_FUNC` in `libssh2.h`.
type SignFn = extern "C" fn(
    *mut raw::LIBSSH2_SESSION,
    *mut *mut c_uchar,
    *mut usize,
    *const c_uchar,
    usize,
    *mut *mut c_void,
) -> c_int;

/// `libssh2_cb_generic` in `libssh2.h`: libssh2 casts it back by callback type.
type GenericCallback = unsafe extern "C" fn();

extern "C" {
    fn libssh2_session_callback_set2(
        session: *mut raw::LIBSSH2_SESSION,
        cbtype: c_int,
        callback: Option<GenericCallback>,
    ) -> Option<GenericCallback>;

    fn libssh2_userauth_publickey(
        session: *mut raw::LIBSSH2_SESSION,
        username: *const c_char,
        pubkeydata: *const c_uchar,
        pubkeydata_len: usize,
        sign_callback: Option<SignFn>,
        abstract_: *mut *mut c_void,
    ) -> c_int;
}

/// Proof that the session's mutex is held. Only [`with_session`] makes one,
/// and it cannot outlive the closure it is given.
pub(crate) struct Locked<'a> {
    raw: *mut raw::LIBSSH2_SESSION,
    _lock: PhantomData<&'a mut raw::LIBSSH2_SESSION>,
}

/// Run `f` holding the session's mutex. `f` must not call `ssh2` methods on
/// this session (they would deadlock), and should not block: every other user
/// of the session waits for it.
pub(crate) fn with_session<R>(session: &Session, f: impl for<'a> FnOnce(&Locked<'a>) -> R) -> R {
    let mut guard = session.raw();
    let raw: *mut raw::LIBSSH2_SESSION = &mut *guard;
    f(&Locked {
        raw,
        _lock: PhantomData,
    })
}

/// A channel the server opened towards us, which `ssh2` cannot represent.
pub(crate) struct RawChannel {
    raw: *mut raw::LIBSSH2_CHANNEL,
    session: *mut raw::LIBSSH2_SESSION,
}

// SAFETY: a libssh2 channel has no thread affinity; it needs its session's
// lock, which every method below requires through `Locked`.
unsafe impl Send for RawChannel {}

impl RawChannel {
    fn check(&self, locked: &Locked<'_>) {
        debug_assert_eq!(
            self.session, locked.raw,
            "channel used with another session"
        );
    }

    /// Whether data for this channel already sits in libssh2's queue. Unlike
    /// [`Self::read`] this leaves the socket alone, so it never pulls another
    /// channel's packets out from under the thread that sleeps on the socket.
    ///
    /// Not `libssh2_poll_channel_read`: that gives up at the first queued packet
    /// under five bytes, and libssh2 keeps a one-byte answer to each keepalive
    /// queued until the session ends. After the first one it would say no for
    /// the rest of the session, and the agent's clients would hang.
    pub(crate) fn has_data(&self, locked: &Locked<'_>) -> bool {
        self.check(locked);
        let mut queued: c_ulong = 0;
        // SAFETY: `queued` outlives the call, the other output may be null, the
        // channel is live (module rules) and the session is locked.
        unsafe {
            raw::libssh2_channel_window_read_ex(self.raw, &mut queued, std::ptr::null_mut());
        }
        queued > 0
    }

    /// Whether the server sent EOF and everything before it has been read.
    pub(crate) fn eof(&self, locked: &Locked<'_>) -> bool {
        self.check(locked);
        // SAFETY: the channel is live (module rules) and the session is locked.
        unsafe { raw::libssh2_channel_eof(self.raw) != 0 }
    }

    /// Non-blocking read. `Ok(0)` is EOF, `WouldBlock` means nothing is there.
    pub(crate) fn read(&mut self, locked: &Locked<'_>, buf: &mut [u8]) -> io::Result<usize> {
        self.check(locked);
        // SAFETY: `buf` is valid for `buf.len()` bytes for the whole call, the
        // channel is live (module rules) and the session is locked.
        let n = unsafe {
            raw::libssh2_channel_read_ex(
                self.raw,
                0,
                buf.as_mut_ptr() as *mut c_char,
                buf.len() as _,
            )
        };
        io_result(n as isize)
    }

    /// Non-blocking write. On `WouldBlock`, call again with the same bytes.
    pub(crate) fn write(&mut self, locked: &Locked<'_>, data: &[u8]) -> io::Result<usize> {
        self.check(locked);
        // SAFETY: `data` is valid for `data.len()` bytes for the whole call,
        // the channel is live (module rules) and the session is locked.
        let n = unsafe {
            raw::libssh2_channel_write_ex(
                self.raw,
                0,
                data.as_ptr() as *const c_char,
                data.len() as _,
            )
        };
        io_result(n as isize)
    }

    /// Close and free the channel. A non-blocking session may not be able to
    /// finish in one call; it then hands the channel back to try again.
    pub(crate) fn free(self, locked: &Locked<'_>) -> Option<Self> {
        self.check(locked);
        // SAFETY: the channel is live (module rules) and the session is
        // locked. `self` is consumed, so nothing uses the pointer once this
        // call has freed it; on EAGAIN libssh2 has freed nothing yet.
        let rc = unsafe { raw::libssh2_channel_free(self.raw) };
        (rc == raw::LIBSSH2_ERROR_EAGAIN).then_some(self)
    }
}

fn io_result(n: isize) -> io::Result<usize> {
    if n >= 0 {
        Ok(n as usize)
    } else if n as c_int == raw::LIBSSH2_ERROR_EAGAIN {
        Err(io::ErrorKind::WouldBlock.into())
    } else {
        Err(io::Error::other(format!("libssh2 error {}", n)))
    }
}

/// Receives the agent channels a server opens.
pub(crate) trait AgentChannelSink: Send + Sync + 'static {
    /// Runs inside libssh2, on whichever thread is reading the session and
    /// with its lock held: it must not touch the session, and must not block.
    fn channel_opened(&self, channel: RawChannel);
}

extern "C" fn on_agent_channel<T: AgentChannelSink>(
    session: *mut raw::LIBSSH2_SESSION,
    channel: *mut raw::LIBSSH2_CHANNEL,
    abstract_: *mut *mut c_void,
) {
    // A panic must not unwind into C. The channel is then left to the
    // session, which frees it when it ends.
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if channel.is_null() || abstract_.is_null() {
            return;
        }
        // SAFETY: libssh2 passes the address of the session's abstract
        // pointer, which `listen_for_agent_channels::<T>` set to a live
        // `Arc<T>`. `stop_agent_channels` clears this callback and the pointer
        // together, under the lock this callback runs with.
        let sink = unsafe { *abstract_ } as *const T;
        if let Some(sink) = unsafe { sink.as_ref() } {
            sink.channel_opened(RawChannel {
                raw: channel,
                session,
            });
        }
    }));
}

/// Accept the agent channels the server opens, and hand them to `sink`. A
/// session without this refuses them: libssh2 answers `CHANNEL_OPEN_FAILURE`
/// when no callback is set, so a server can only reach the agent after this.
///
/// Stores `sink` in the session's abstract pointer until
/// [`stop_agent_channels`]. `ssh2` only borrows that pointer for the length
/// of a keyboard-interactive call, which is over once a session has channels.
pub(crate) fn listen_for_agent_channels<T: AgentChannelSink>(locked: &Locked<'_>, sink: Arc<T>) {
    let callback: AgentChannelFn = on_agent_channel::<T>;
    // SAFETY: the session is locked and the pointer `libssh2_session_abstract`
    // returns is valid for as long as the session. The transmute only changes
    // a function pointer's type: libssh2 takes `libssh2_cb_generic` and casts
    // it back to `LIBSSH2_AUTHAGENT_FUNC`, the signature of `AgentChannelFn`.
    unsafe {
        *raw::libssh2_session_abstract(locked.raw) = Arc::into_raw(sink) as *mut c_void;
        libssh2_session_callback_set2(
            locked.raw,
            CALLBACK_AUTHAGENT,
            Some(mem::transmute::<AgentChannelFn, GenericCallback>(callback)),
        );
    }
}

/// The sink [`listen_for_agent_channels`] stored, when there is one.
pub(crate) fn agent_channel_sink<T: AgentChannelSink>(locked: &Locked<'_>) -> Option<Arc<T>> {
    // SAFETY: the session is locked. A non-null abstract pointer came from
    // `Arc::into_raw` in `listen_for_agent_channels` (sessions are created
    // with a null one), and that reference is still counted: it is only given
    // up in `stop_agent_channels`, under this same lock.
    unsafe {
        let stored = *raw::libssh2_session_abstract(locked.raw) as *const T;
        if stored.is_null() {
            return None;
        }
        Arc::increment_strong_count(stored);
        Some(Arc::from_raw(stored))
    }
}

/// Refuse agent channels again, and give back the stored sink. The callback
/// cannot run after this: it only runs under the lock held here.
pub(crate) fn stop_agent_channels<T: AgentChannelSink>(locked: &Locked<'_>) -> Option<Arc<T>> {
    // SAFETY: as in `agent_channel_sink`; this takes over the reference that
    // `listen_for_agent_channels` left behind and clears the pointer to it.
    unsafe {
        libssh2_session_callback_set2(locked.raw, CALLBACK_AUTHAGENT, None);
        let slot = raw::libssh2_session_abstract(locked.raw);
        let stored = mem::replace(&mut *slot, std::ptr::null_mut()) as *const T;
        (!stored.is_null()).then(|| Arc::from_raw(stored))
    }
}

extern "C" fn on_sign<F: FnMut(&[u8]) -> Option<Vec<u8>>>(
    _session: *mut raw::LIBSSH2_SESSION,
    sig: *mut *mut c_uchar,
    sig_len: *mut usize,
    data: *const c_uchar,
    data_len: usize,
    abstract_: *mut *mut c_void,
) -> c_int {
    const FAILED: c_int = -1;
    catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: `abstract_` is the pointer `userauth_publickey` passed in,
        // which libssh2 hands over untouched. It holds a `*mut F` to a closure
        // on that function's stack, alive until libssh2 returns, and nothing
        // else uses the closure meanwhile. `data` is libssh2's own buffer,
        // valid for `data_len` bytes during this call.
        let (sign, data) = unsafe {
            (
                &mut *(*abstract_ as *mut F),
                slice::from_raw_parts(data, data_len),
            )
        };
        let Some(signature) = sign(data) else {
            return FAILED;
        };
        // SAFETY: libssh2 releases `*sig` with its allocator, which is
        // `free(3)` here: `ssh2` creates sessions without a custom one. The
        // copy stays inside the allocation, and `sig` and `sig_len` are
        // libssh2's out-parameters.
        unsafe {
            let copy = libc::malloc(signature.len().max(1)) as *mut c_uchar;
            if copy.is_null() {
                return FAILED;
            }
            std::ptr::copy_nonoverlapping(signature.as_ptr(), copy, signature.len());
            *sig = copy;
            *sig_len = signature.len();
        }
        0
    }))
    .unwrap_or(FAILED)
}

/// `publickey` authentication with `key_blob`, signing through `sign`, which
/// returns the bytes libssh2 puts after the method name in the signature.
pub(crate) fn userauth_publickey<F>(
    session: &Session,
    username: &str,
    key_blob: &[u8],
    mut sign: F,
) -> Result<(), ssh2::Error>
where
    F: FnMut(&[u8]) -> Option<Vec<u8>>,
{
    let username = CString::new(username).map_err(|_| {
        ssh2::Error::new(
            ssh2::ErrorCode::Session(raw::LIBSSH2_ERROR_INVAL),
            "the username contains a NUL byte",
        )
    })?;
    let mut closure = &mut sign as *mut F as *mut c_void;
    let rc = with_session(session, |locked| {
        // SAFETY: the session is locked; the username and key are valid for
        // the call, and libssh2 copies what it keeps. `on_sign::<F>` gets
        // `closure`, whose target `sign` outlives this call.
        unsafe {
            libssh2_userauth_publickey(
                locked.raw,
                username.as_ptr(),
                key_blob.as_ptr(),
                key_blob.len(),
                Some(on_sign::<F>),
                &mut closure,
            )
        }
    });
    if rc == 0 {
        return Ok(());
    }
    Err(ssh2::Error::last_session_error(session).unwrap_or_else(|| {
        ssh2::Error::new(
            ssh2::ErrorCode::Session(rc),
            "public key authentication failed",
        )
    }))
}
