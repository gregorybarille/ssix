//! Port forwards on top of the session helpers in `crate::ssh`.
//!
//! Today this is the local forward (`ssh -L`): a listener on
//! `127.0.0.1:<local_port>` whose every accepted connection is forwarded
//! through the SSH server over a `direct-tcpip` channel. Remote (`-R`) and
//! dynamic SOCKS (`-D`) forwards are the forwards stream's job (see
//! `docs/roadmap.md`); their connection kinds already exist in
//! `crate::models::ConnectionKind` and `commands::ssh::ssh_connect` refuses
//! them until then.
//!
//! A forward is a session like any other: it registers a [`SessionHandle`]
//! in `SshState`, only `SessionMsg::Disconnect` means anything to it, and it
//! reports state changes to the frontend on `ssix:forward:status:{id}`
//! (see [`forward_status_event`], mirrored in `src/lib/events.ts`).

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use ssh2::Session;
use tauri::Emitter;

use crate::ssh::{
    control_channel, forward_bidi, is_eagain, open_hop_session, wake, Endpoint, SessionContext,
    SessionHandle, SessionMsg, SESSION_TIMEOUT_MS,
};
use crate::ssh_debug::SshDebug;

/// Status payload a local forward emits on `ssix:forward:status:{id}`.
#[derive(Serialize, Clone)]
pub struct ForwardStatus {
    pub state: &'static str, // "listening" | "client_connected" | "client_closed" | "error"
    pub local_port: u16,
    pub destination: String,
    pub message: Option<String>,
    pub active_clients: usize,
}

/// Event names are namespaced under `ssix:` and mirrored in
/// `src/lib/events.ts`; both sides MUST go through these helpers.
pub(crate) fn forward_status_event(session_id: &str) -> String {
    format!("ssix:forward:status:{}", session_id)
}

/// Emit a status change for the forward `ctx` runs.
fn emit_status(ctx: &SessionContext, status: ForwardStatus) {
    let _ = ctx
        .app
        .emit(&forward_status_event(&ctx.session_id), status);
}

/// Open a `direct-tcpip` channel on a non-blocking session, waiting for the
/// socket whenever libssh2 asks to be called again.
pub(crate) fn open_direct_tcpip(
    session: &Session,
    destination_host: &str,
    destination_port: u16,
    peer: SocketAddr,
) -> Result<ssh2::Channel, String> {
    let deadline = Instant::now() + Duration::from_millis(SESSION_TIMEOUT_MS as u64);
    let fds = [wake::fd_of(session)];
    let peer_ip = peer.ip().to_string();
    loop {
        match session.channel_direct_tcpip(
            destination_host,
            destination_port,
            Some((&peer_ip, peer.port())),
        ) {
            Ok(channel) => return Ok(channel),
            Err(e) if is_eagain(&e) => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "timed out opening a channel to {}:{}",
                        destination_host, destination_port
                    ));
                }
                wake::wait_readable(&fds, Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Listen on `127.0.0.1:local_port` and forward every accepted connection
/// through the SSH server `gateway` to `destination_host:destination_port`
/// (`ssh -L`).
///
/// Only `SessionMsg::Disconnect` is meaningful for a port forward; `Write`
/// and `Resize` are ignored. Bind and SSH server errors are returned
/// synchronously.
pub fn start_port_forward(
    gateway: Endpoint,
    local_port: u16,
    destination_host: String,
    destination_port: u16,
    verbosity: u8,
    ctx: SessionContext,
) -> Result<SessionHandle, String> {
    let bind_addr = SocketAddr::from(([127, 0, 0, 1], local_port));
    let listener = TcpListener::bind(bind_addr)
        .map_err(|e| format!("Failed to bind 127.0.0.1:{}: {}", local_port, e))?;

    let session = open_hop_session(&gateway, "SSH server", verbosity)?;
    let debug = SshDebug::new(verbosity, gateway.addr());
    debug.at(1, || {
        format!(
            "Local forwarding listening on 127.0.0.1 port {}.",
            local_port
        )
    });
    // Non-blocking so one slow client can never stall the others: libssh2
    // serialises every call made on a session.
    session.set_blocking(false);

    let (handle, control) = control_channel()?;
    ctx.register(handle.clone())?;
    let stop = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicUsize::new(0));
    let destination = format!("{}:{}", destination_host, destination_port);
    let ctx = Arc::new(ctx);

    let status = {
        let ctx = Arc::clone(&ctx);
        let destination = destination.clone();
        let active = Arc::clone(&active);
        move |state: &'static str, message: Option<String>| {
            emit_status(&ctx, ForwardStatus {
                state,
                local_port,
                destination: destination.clone(),
                message,
                active_clients: active.load(Ordering::SeqCst),
            });
        }
    };
    status("listening", None);

    // Control thread: block on the queue; on Disconnect (or when the handle
    // is dropped) raise the stop flag and poke the listener so accept()
    // returns.
    {
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            loop {
                match control.rx.recv() {
                    Ok(SessionMsg::Disconnect) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect_timeout(&bind_addr, Duration::from_secs(1));
        });
    }

    thread::spawn(move || {
        loop {
            let (local_stream, peer) = match listener.accept() {
                Ok(accepted) => accepted,
                Err(e) => {
                    ctx.log(
                        "error",
                        "forward",
                        format!("session {}: accept failed: {}", ctx.session_id, e),
                    );
                    status("error", Some(format!("accept failed: {}", e)));
                    break;
                }
            };
            if stop.load(Ordering::SeqCst) {
                break;
            }

            let session = session.clone();
            let destination_host = destination_host.clone();
            let active = Arc::clone(&active);
            let status = status.clone();
            let debug = debug.clone();
            thread::spawn(move || {
                debug.at(1, || {
                    format!(
                        "Connection to port {} forwarding to {} port {} requested.",
                        local_port, destination_host, destination_port
                    )
                });
                let channel =
                    match open_direct_tcpip(&session, &destination_host, destination_port, peer) {
                        Ok(channel) => channel,
                        Err(e) => {
                            status("error", Some(format!("channel_direct_tcpip failed: {}", e)));
                            return;
                        }
                    };
                active.fetch_add(1, Ordering::SeqCst);
                status("client_connected", Some(format!("from {}", peer)));
                forward_bidi(local_stream, channel, &session, &active);
                active.fetch_sub(1, Ordering::SeqCst);
                status("client_closed", Some(format!("from {}", peer)));
                debug.at(2, || format!("Forwarded connection from {} closed.", peer));
            });
        }
        drop(listener);
        ctx.finish();
    });

    Ok(handle)
}
