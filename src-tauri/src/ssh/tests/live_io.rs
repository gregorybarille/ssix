//! A shell's I/O and a tunnel's against a real server, under load. Ignored by a
//! plain `cargo test`: see `remote_script::live` for how to run them. Each one
//! prints what it measured; `-- --nocapture` shows it. Not on Windows, whose
//! test container is about scripts.

use super::*;
use crate::remote_script::live::Target;
use crate::storage::test_support::with_isolated_data_dir;
use std::sync::mpsc::Receiver;
use std::sync::Mutex;

/// What a shell printed: all of it counted, the end of it kept.
#[derive(Default)]
struct Printed {
    total: AtomicUsize,
    tail: Mutex<Vec<u8>>,
    warnings: Mutex<Vec<String>>,
}

const TAIL_BYTES: usize = 256 * 1024;

impl ShellOutput for Arc<Printed> {
    fn output(&mut self, bytes: &[u8]) {
        self.total.fetch_add(bytes.len(), Ordering::SeqCst);
        let mut tail = self.tail.lock().unwrap();
        tail.extend_from_slice(bytes);
        let excess = tail.len().saturating_sub(TAIL_BYTES);
        tail.drain(..excess);
    }

    fn warn(&self, message: String) {
        self.warnings.lock().unwrap().push(message);
    }
}

/// [`run_io_loop`] on its own thread, as a shell worker runs it.
struct LiveShell {
    handle: SessionHandle,
    printed: Arc<Printed>,
    ended: Receiver<ShellEnd>,
    fd: wake::Fd,
}

impl LiveShell {
    fn start(shell: OpenShell) -> Self {
        let fd = wake::fd_of(&shell.session);
        let (handle, control) = control_channel().unwrap();
        let printed = Arc::new(Printed::default());
        let (ended_tx, ended) = mpsc::channel();
        let out = Arc::clone(&printed);
        thread::spawn(move || {
            let mut io = ShellIo {
                out,
                control,
                pty_size: None,
            };
            let _ = ended_tx.send(run_io_loop(shell, &mut io));
        });
        Self {
            handle,
            printed,
            ended,
            fd,
        }
    }

    fn open(target: &Target, keepalive_interval: u16) -> Self {
        let opts = ShellOptions {
            keepalive_interval,
            ..ShellOptions::default()
        };
        Self::start(open_shell(&target.endpoint, &opts).unwrap())
    }

    fn send(&self, bytes: &[u8]) {
        self.handle.send(SessionMsg::Write(bytes.to_vec())).unwrap();
    }

    fn total(&self) -> usize {
        self.printed.total.load(Ordering::SeqCst)
    }

    fn contains(&self, needle: &str) -> bool {
        let tail = self.printed.tail.lock().unwrap();
        String::from_utf8_lossy(&tail).contains(needle)
    }

    /// Fails at once if the shell ends first, saying why.
    fn wait_for(&self, needle: &str, within: Duration) {
        let start = Instant::now();
        while !self.contains(needle) {
            match self.ended.try_recv() {
                Ok(ShellEnd::Dropped(reason)) => panic!(
                    "the session dropped after {:?} waiting for {needle:?}: {reason}",
                    start.elapsed()
                ),
                Ok(ShellEnd::Closed) => panic!("the shell closed waiting for {needle:?}"),
                Err(_) => {}
            }
            assert!(
                start.elapsed() < within,
                "never saw {needle:?}; {} bytes printed, ending {:?}",
                self.total(),
                String::from_utf8_lossy(&self.printed.tail.lock().unwrap()),
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_for_prompt(&self) {
        self.send(b"echo ready$((6*7))\n");
        self.wait_for("ready42", Duration::from_secs(20));
    }
}

/// Lines of text, ending with an end of file for the program reading them.
fn paste_of(bytes: usize) -> Vec<u8> {
    let line = b"0123456789012345678901234567890123456789012345678901234567890\n";
    let mut paste = line.repeat(bytes / line.len() + 1);
    paste.push(4);
    paste
}

/// Keep a socket's buffers small, as on a link slower than the machines at its
/// ends, so that a side that stops reading is felt by the other at once.
fn shrink_buffers(socket: &TcpStream) {
    let size: libc::c_int = 16 * 1024;
    for option in [libc::SO_SNDBUF, libc::SO_RCVBUF] {
        // SAFETY: `size` outlives the call, and the length given is its size.
        let done = unsafe {
            libc::setsockopt(
                wake::fd_of(socket),
                libc::SOL_SOCKET,
                option,
                std::ptr::addr_of!(size).cast(),
                std::mem::size_of_val(&size) as libc::socklen_t,
            )
        };
        assert_eq!(done, 0, "{}", io::Error::last_os_error());
    }
}

/// CPU this process has used so far.
fn cpu_time() -> Duration {
    // SAFETY: `getrusage` fills in the zeroed struct it is given.
    let usage = unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut usage);
        usage
    };
    let of = |t: libc::timeval| {
        Duration::from_secs(t.tv_sec as u64) + Duration::from_micros(t.tv_usec as u64)
    };
    of(usage.ru_utime) + of(usage.ru_stime)
}

/// `what` must take under a fifth of one CPU over `over`.
fn assert_idle(what: &str, over: Duration) {
    let before = cpu_time();
    thread::sleep(over);
    let used = cpu_time() - before;
    eprintln!("{what}: {used:?} of CPU in {over:?}");
    assert!(used < over / 5, "{what} used {used:?} of CPU in {over:?}");
}

/// A paste bigger than sshd's 2 MB window, under a program that reads none of
/// it for longer than writes used to be given. The channel's window shuts, and
/// waiting for it must cost nothing.
#[test]
#[ignore]
fn live_a_paste_above_the_window_waits_for_a_sleeping_program() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let shell = LiveShell::open(&target, 3);
        shell.wait_for_prompt();
        shell.send(b"sleep 14; stty -echo; cat >/dev/null; stty echo; echo done$((6*7))\n");
        thread::sleep(Duration::from_millis(500));
        let start = Instant::now();
        shell.send(&paste_of(3 * 1024 * 1024));
        thread::sleep(Duration::from_secs(2));
        assert_idle("waiting on a shut window", Duration::from_secs(8));
        shell.wait_for("done42", Duration::from_secs(60));
        eprintln!("the paste went through in {:?}", start.elapsed());
    });
}

/// A paste that comes back as output: reading must go on during it, or sshd's
/// output backs up, it stops reading, and neither side moves. The relay does what
/// sshd does, taking nothing from the client while its output is backed up, and
/// its small buffers leave no slack that hides the problem.
#[test]
#[ignore]
fn live_a_paste_echoed_back_above_the_window_does_not_deadlock() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let relay = Relay::start_with(&target.endpoint, shrink_buffers);
        let tcp = relay.connect();
        shrink_buffers(&tcp);
        let opts = ShellOptions {
            keepalive_interval: 5,
            ..ShellOptions::default()
        };
        let shell = LiveShell::start(open_shell_over_stream(tcp, &target.endpoint, &opts).unwrap());
        shell.wait_for_prompt();
        shell.send(b"cat; echo done$((6*7))\n");
        thread::sleep(Duration::from_millis(300));
        let size = 6 * 1024 * 1024;
        let start = Instant::now();
        shell.send(&paste_of(size));
        shell.wait_for("done42", Duration::from_secs(180));
        eprintln!(
            "{size} bytes pasted, {} printed, in {:?}",
            shell.total(),
            start.elapsed()
        );
        assert!(shell.total() > size, "the output went missing");
    });
}

/// A slow link: the paste takes longer than writes used to be given, moving all
/// the while, and keepalives that starve must not count against the server.
#[test]
#[ignore]
fn live_a_slow_paste_outlasts_the_old_limit_and_the_watchdog() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let relay = Relay::start(&target.endpoint);
        let opts = ShellOptions {
            keepalive_interval: 2,
            ..ShellOptions::default()
        };
        let shell = LiveShell::start(
            open_shell_over_stream(relay.connect(), &target.endpoint, &opts).unwrap(),
        );
        shell.wait_for_prompt();
        shell.send(b"stty -echo; cat >/dev/null; stty echo; echo done$((6*7))\n");
        thread::sleep(Duration::from_millis(300));
        relay.set_mode(RELAY_TRICKLE_UP);
        let start = Instant::now();
        shell.send(&paste_of(5 * 1024 * 1024 / 2));
        shell.wait_for("done42", Duration::from_secs(120));
        let took = start.elapsed();
        eprintln!("the slow paste took {took:?}");
        assert!(
            took > Duration::from_secs(11),
            "the link was not slow enough to prove anything: {took:?}"
        );
    });
}

/// A half-sent packet stops a read that needs a bigger window from reading at
/// all, which is why a blocked sender takes in what is on the socket itself.
#[test]
#[ignore]
fn live_take_in_reads_what_a_read_held_up_by_a_half_sent_packet_cannot() {
    use std::mem::ManuallyDrop;
    use std::os::fd::FromRawFd;

    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let relay = Relay::start(&target.endpoint);
        let OpenShell {
            session,
            mut channel,
            ..
        } = open_shell_over_stream(relay.connect(), &target.endpoint, &ShellOptions::default())
            .unwrap();
        let fd = wake::fd_of(&session);
        wait_for_quiet(&mut channel, fd);

        // Read a flood until a read of `big` would want a bigger window: libssh2
        // asks when under 3/4 of the 2 MB window, plus what the read is for.
        write_all_nonblocking(&mut channel, b"yes\n", Some(fd)).unwrap();
        let mut buf = [0u8; 4096];
        let mut big = vec![0u8; 64 * 1024];
        let mut read = 0;
        let start = Instant::now();
        loop {
            let window = channel.read_window();
            if window.remaining + window.available < 3 * 512 * 1024 + 32 * 1024 {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "no flood: {read}"
            );
            match channel.read(&mut buf) {
                Ok(n) => read += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    wake::wait_readable(&[fd], Duration::from_millis(50));
                }
                Err(e) => panic!("{e}"),
            }
        }

        // Half send a packet on a full socket. The relay takes nothing up.
        relay.set_mode(RELAY_HOLD_UP);
        thread::sleep(Duration::from_millis(100));
        // SAFETY: `fd` is the session's open socket. `ManuallyDrop` keeps this
        // temporary view of it from closing the socket.
        let socket = ManuallyDrop::new(unsafe { TcpStream::from_raw_fd(fd) });
        let filled = fill_socket(&socket, fd);
        assert_eq!(
            channel.write(b"\x03").unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );

        // More of the flood on the socket, which no read can reach.
        let before = channel.read_window().available;
        thread::sleep(Duration::from_millis(200));
        assert!(wake::is_readable(fd));
        assert_eq!(
            channel.read(&mut big).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        assert!(wake::is_readable(fd), "the read read after all");
        assert_eq!(channel.read_window().available, before);

        take_in(&mut channel).unwrap();
        assert!(channel.read_window().available > before);
        relay.discard_up(filled);
        relay.set_mode(RELAY_FLOW);
    });
}

/// With nothing moving at all, the keepalive watchdog is what ends the wait.
#[test]
#[ignore]
fn live_a_server_gone_silent_under_a_paste_is_judged_by_the_watchdog() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let relay = Relay::start(&target.endpoint);
        let opts = ShellOptions {
            keepalive_interval: 2,
            ..ShellOptions::default()
        };
        let shell = LiveShell::start(
            open_shell_over_stream(relay.connect(), &target.endpoint, &opts).unwrap(),
        );
        shell.wait_for_prompt();
        relay.set_mode(RELAY_FROZEN);
        let start = Instant::now();
        shell.send(&paste_of(8 * 1024 * 1024));
        match shell.ended.recv_timeout(Duration::from_secs(30)) {
            Ok(ShellEnd::Dropped(reason)) => {
                eprintln!("dropped after {:?}: {reason}", start.elapsed());
                assert!(reason.contains("did not answer"), "{reason}");
            }
            Ok(ShellEnd::Closed) => panic!("a frozen server reads as a closed shell"),
            Err(e) => panic!("the watchdog never ended it: {e}"),
        }
    });
}

/// Closing the pane does not wait for a paste nobody takes.
#[test]
#[ignore]
fn live_closing_a_session_does_not_wait_for_a_stuck_paste() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let shell = LiveShell::open(&target, 0);
        shell.wait_for_prompt();
        shell.send(b"sleep 60\n");
        thread::sleep(Duration::from_millis(300));
        shell.send(&paste_of(3 * 1024 * 1024));
        thread::sleep(Duration::from_secs(1));
        shell.handle.send(SessionMsg::Disconnect).unwrap();
        assert!(matches!(
            shell.ended.recv_timeout(CLOSE_TIMEOUT * 2),
            Ok(ShellEnd::Closed)
        ));
    });
}

/// Fill the session's socket behind libssh2's back, with bytes the relay is told
/// to drop so that the encrypted stream it carries stays intact. Returns how many
/// to give [`Relay::discard_up`].
fn fill_session_socket(relay: &Relay, fd: wake::Fd) -> usize {
    use std::mem::ManuallyDrop;
    use std::os::fd::FromRawFd;

    relay.set_mode(RELAY_HOLD_UP);
    thread::sleep(Duration::from_millis(100));
    // SAFETY: `fd` is the session's open socket. `ManuallyDrop` keeps this
    // temporary view of it from closing the socket.
    let socket = ManuallyDrop::new(unsafe { TcpStream::from_raw_fd(fd) });
    let mut filled = fill_socket(&socket, fd);
    assert!(!wake::is_writable(fd));
    // A socket that reports no room can still take a small packet.
    while (&*socket).write(&[0]).is_ok() {
        filled += 1;
    }
    filled
}

/// A resize that does not fit on the socket has to go out later, or it jams the
/// session: libssh2 refuses every other packet until it has been retried.
#[test]
#[ignore]
fn live_a_resize_on_a_full_socket_goes_out_later_and_jams_nothing() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let relay = Relay::start(&target.endpoint);
        let shell = LiveShell::start(
            open_shell_over_stream(relay.connect(), &target.endpoint, &ShellOptions::default())
                .unwrap(),
        );
        shell.wait_for_prompt();

        let filled = fill_session_socket(&relay, shell.fd);
        shell
            .handle
            .send(SessionMsg::Resize {
                cols: 123,
                rows: 45,
            })
            .unwrap();
        thread::sleep(Duration::from_millis(300));
        relay.discard_up(filled);
        relay.set_mode(RELAY_FLOW);

        shell.send(b"stty size\n");
        shell.wait_for("45 123", Duration::from_secs(10));
        assert!(shell.printed.warnings.lock().unwrap().is_empty());
    });
}

/// A client leaving while the socket is full: the channel's EOF has to be retried
/// by the call that started it. libssh2 knows a half-sent packet by its address,
/// and the EOF's is on the stack.
#[test]
#[ignore]
fn live_a_tunnel_ending_on_a_full_socket_leaves_the_session_usable() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let relay = Relay::start(&target.endpoint);
        let OpenShell {
            session,
            mut channel,
            ..
        } = open_shell_over_stream(relay.connect(), &target.endpoint, &ShellOptions::default())
            .unwrap();
        session.set_blocking(true);
        let tunnel = session.channel_direct_tcpip("127.0.0.1", 22, None).unwrap();
        session.set_blocking(false);
        let fd = wake::fd_of(&session);
        wait_for_quiet(&mut channel, fd);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (far, _) = listener.accept().unwrap();
        let forwarder = {
            let session = session.clone();
            thread::spawn(move || {
                forward_bidi(
                    far,
                    tunnel,
                    &session,
                    &AtomicUsize::new(1),
                    &Traffic::default(),
                );
            })
        };

        // All of sshd's banner read, or closing would be a reset, not an EOF.
        let mut banner = [0u8; 64];
        let mut got = (&client).read(&mut banner).unwrap();
        while !banner[..got].contains(&b'\n') {
            got += (&client).read(&mut banner[got..]).unwrap();
        }

        let filled = fill_session_socket(&relay, fd);
        drop(client);
        thread::sleep(Duration::from_millis(300));
        relay.discard_up(filled);
        relay.set_mode(RELAY_FLOW);
        forwarder.join().unwrap();

        write_all_nonblocking(&mut channel, b"echo alive$((6*7))\n", Some(fd))
            .expect("the session is jammed");
        let mut printed = Vec::new();
        let mut buf = [0u8; 4096];
        let start = Instant::now();
        while !String::from_utf8_lossy(&printed).contains("alive42") {
            assert!(start.elapsed() < Duration::from_secs(10), "no answer");
            match channel.read(&mut buf) {
                Ok(n) => printed.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    wake::wait_readable(&[fd], Duration::from_millis(50));
                }
                Err(e) => panic!("{e}"),
            }
        }
    });
}

/// A program on the server, for as long as this lives.
struct Service {
    _session: Session,
    _channel: ssh2::Channel,
}

/// Run `command`, which should listen on a port of the server's loopback.
fn run_service(target: &Target, command: &str) -> Service {
    let session = open_authenticated_session(&target.endpoint, 0, None).unwrap();
    let mut channel = session.channel_session().unwrap();
    channel.exec(command).unwrap();
    session.set_blocking(false);
    thread::sleep(Duration::from_millis(500));
    Service {
        _session: session,
        _channel: channel,
    }
}

fn free_service_port() -> u16 {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    31_000 + (std::process::id() % 1_000) as u16 + NEXT.fetch_add(1, Ordering::SeqCst) as u16
}

/// A tunnel to `port` on the server's loopback: the client's end and the thread
/// forwarding it.
fn open_tunnel(target: &Target, port: u16) -> (TcpStream, thread::JoinHandle<()>) {
    let session = open_authenticated_session(&target.endpoint, 0, None).unwrap();
    let channel = session
        .channel_direct_tcpip("127.0.0.1", port, None)
        .unwrap();
    session.set_blocking(false);
    let (client, far) = crate::proxy::loopback_pair().unwrap();
    let forwarder = thread::spawn(move || {
        forward_bidi(
            far,
            channel,
            &session,
            &AtomicUsize::new(1),
            &Traffic::default(),
        );
    });
    (client, forwarder)
}

fn assert_ends(forwarder: thread::JoinHandle<()>) {
    let start = Instant::now();
    while !forwarder.is_finished() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the forwarder is still running"
        );
        thread::sleep(Duration::from_millis(20));
    }
    forwarder.join().unwrap();
}

/// A paused download: the client reads nothing for longer than a write used to be
/// given. Everything still has to arrive, and waiting has to cost nothing.
#[test]
#[ignore]
fn live_a_client_that_stops_reading_keeps_its_tunnel() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let port = free_service_port();
        let size = 30_000_000;
        let _service = run_service(
            &target,
            &format!("head -c {size} /dev/zero | nc -l -p {port}"),
        );
        let (mut client, forwarder) = open_tunnel(&target, port);
        client
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut buf = vec![0u8; 64 * 1024];
        client.read_exact(&mut buf).unwrap();

        thread::sleep(Duration::from_secs(3));
        assert_idle("a tunnel its client left unread", Duration::from_secs(10));

        let mut total = buf.len();
        while total < size {
            let n = client.read(&mut buf).unwrap();
            assert!(n > 0, "the tunnel closed after {total} bytes");
            total += n;
        }
        eprintln!("all {total} bytes arrived after the stall");

        drop(client);
        assert_ends(forwarder);
    });
}

/// A client that reads nothing until it has written everything, to an echo: both
/// directions stall at once, and neither may stop the other for good.
#[test]
#[ignore]
fn live_a_full_duplex_peer_gets_everything_back_when_the_client_reads_late() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let port = free_service_port();
        let _service = run_service(&target, &format!("nc -l -p {port} -e /bin/cat"));
        let (mut client, forwarder) = open_tunnel(&target, port);
        let size = 8 * 1024 * 1024;
        let sent: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();

        let writer = {
            let mut client = client.try_clone().unwrap();
            let sent = sent.clone();
            thread::spawn(move || client.write_all(&sent))
        };
        thread::sleep(Duration::from_secs(12));
        client
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let mut got = vec![0u8; size];
        client.read_exact(&mut got).unwrap();
        writer.join().unwrap().unwrap();
        assert!(got == sent, "the bytes came back changed");

        drop(client);
        assert_ends(forwarder);
    });
}

/// Nothing on the server reads: the channel's window shuts under the client's
/// bytes. That costs no CPU, and a client that aborts still ends the tunnel.
#[test]
#[ignore]
fn live_a_shut_window_costs_nothing_and_a_client_that_aborts_ends_it() {
    let target = Target::from_env();
    with_isolated_data_dir(|| {
        let port = free_service_port();
        let _service = run_service(&target, &format!("nc -l -p {port} | sleep 600"));
        let (client, forwarder) = open_tunnel(&target, port);
        client.set_nonblocking(true).unwrap();
        let chunk = vec![0u8; 64 * 1024];
        let mut moved = Instant::now();
        let mut written = 0;
        // Until the far side has stopped taking anything at all.
        while moved.elapsed() < Duration::from_secs(2) {
            match (&client).write(&chunk) {
                Ok(n) => {
                    written += n;
                    moved = Instant::now();
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(e) => panic!("the tunnel failed after {written} bytes: {e}"),
            }
        }
        eprintln!("the window shut after {written} bytes");

        assert_idle("a tunnel on a shut window", Duration::from_secs(12));
        assert!(!forwarder.is_finished(), "the tunnel gave up on its client");

        let linger = libc::linger {
            l_onoff: 1,
            l_linger: 0,
        };
        // SAFETY: `linger` outlives the call, and the length given is its size.
        let done = unsafe {
            libc::setsockopt(
                wake::fd_of(&client),
                libc::SOL_SOCKET,
                libc::SO_LINGER,
                std::ptr::addr_of!(linger).cast(),
                std::mem::size_of_val(&linger) as libc::socklen_t,
            )
        };
        assert_eq!(done, 0, "{}", io::Error::last_os_error());
        drop(client);
        assert_ends(forwarder);
    });
}
