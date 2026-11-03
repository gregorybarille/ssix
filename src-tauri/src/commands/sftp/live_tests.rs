//! Against a real SSH server, so a plain `cargo test` skips them. Point them
//! at one the way `remote_script::live` is, one at a time:
//!
//! ```text
//! SSIX_LIVE_SSH=127.0.0.1:2201 SSIX_LIVE_USER=usera SSIX_LIVE_PASSWORD=passa \
//! SSIX_LIVE_PLATFORM=posix cargo test live_sftp -- --ignored --test-threads=1
//! ```
//!
//! CI's Linux job runs them with the script tests. They do nothing on its
//! Windows target, whose paths and permissions these checks do not cover.

use super::browse::{
    sftp_chmod, sftp_connect_sync, sftp_delete, sftp_disconnect, sftp_list, sftp_mkdir,
    sftp_rename, PaneTarget, TempDir,
};
use super::edit::{edit_close, edit_open, edit_save, edit_status, open_sftp, EditSaveOutcome};
use super::transfer::{
    sftp_cancel_transfer, start_transfer, Emit, TransferDirection, TransferEvent, TransferInput,
    LOGINS, MAX_ACTIVE,
};
use super::FileKind;
use crate::commands::ssh::{connect_session, find_connection};
use crate::models::{Connection, ConnectionKind, Credential, CredentialKind};
use crate::storage::test_support::with_isolated_data_dir;
use crate::storage::{data_dir, with_data_mut};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;
use tauri::async_runtime::block_on;

fn var(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{} is not set; see this module's doc", name))
}

/// Run `test` with a saved connection to the live server, or not at all on
/// a platform these tests do not cover.
pub(crate) fn with_connection(test: impl FnOnce(&str)) {
    if var("SSIX_LIVE_PLATFORM") != "posix" {
        return;
    }
    let addr = var("SSIX_LIVE_SSH");
    let (host, port) = addr.rsplit_once(':').expect("SSIX_LIVE_SSH is host:port");
    with_isolated_data_dir(|| {
        let cred = Credential::new(
            "live".to_string(),
            var("SSIX_LIVE_USER"),
            CredentialKind::Password {
                password: var("SSIX_LIVE_PASSWORD"),
            },
        );
        let conn = Connection::new(
            "live".to_string(),
            host.to_string(),
            port.parse().expect("SSIX_LIVE_SSH port"),
            Some(cred.id.clone()),
            ConnectionKind::Direct,
        );
        let id = conn.id.clone();
        with_data_mut(|data| {
            data.credentials.push(cred);
            data.connections.push(conn);
            Ok(())
        })
        .unwrap();
        test(&id);
    });
}

/// Run a command on the server, for what SFTP cannot set up itself.
pub(crate) fn sh(connection_id: &str, command: &str) -> String {
    let (data, conn) = find_connection(connection_id).unwrap();
    let ssh = connect_session(&data, &conn, "the live test").unwrap();
    let mut channel = ssh.session.channel_session().unwrap();
    channel.exec(command).unwrap();
    let mut output = String::new();
    channel.read_to_string(&mut output).unwrap();
    channel.wait_close().unwrap();
    assert_eq!(channel.exit_status().unwrap(), 0, "{}: {}", command, output);
    output
}

/// A fresh folder on the server, removed when the test ends.
pub(crate) struct RemoteDir {
    connection_id: String,
    pub(crate) path: String,
}

impl RemoteDir {
    pub(crate) fn new(connection_id: &str) -> Self {
        let path = format!("/tmp/ssix-live-{}", uuid::Uuid::new_v4().simple());
        sh(connection_id, &format!("mkdir {}", path));
        Self {
            connection_id: connection_id.to_string(),
            path,
        }
    }

    pub(crate) fn child(&self, name: &str) -> String {
        format!("{}/{}", self.path, name)
    }
}

impl Drop for RemoteDir {
    fn drop(&mut self) {
        sh(&self.connection_id, &format!("rm -rf {}", self.path));
    }
}

/// Run a transfer to its end and return its last event.
fn transfer(input: TransferInput) -> TransferEvent {
    transfer_with(input, |_, _| {})
}

/// As `transfer`, calling `on_progress` with the bytes copied so far.
fn transfer_with(
    input: TransferInput,
    on_progress: impl Fn(&str, u64) + Send + Sync + 'static,
) -> TransferEvent {
    let (sender, events) = mpsc::channel();
    let emit: Emit = Arc::new(move |event| {
        if let TransferEvent::Progress { id, bytes_done, .. } = &event {
            on_progress(id, *bytes_done);
        } else {
            let _ = sender.send(event);
        }
    });
    start_transfer(input, emit).expect("the transfer should start");
    events
        .recv_timeout(Duration::from_secs(120))
        .expect("the transfer should end")
}

/// Run a transfer and cancel it as soon as bytes have moved.
fn cancel_at_first_bytes(input: TransferInput) -> TransferEvent {
    let cancelled = AtomicBool::new(false);
    transfer_with(input, move |transfer_id, bytes| {
        if bytes > 0 && !cancelled.swap(true, Ordering::SeqCst) {
            sftp_cancel_transfer(transfer_id.to_string());
        }
    })
}

fn upload(connection_id: &str, source: &Path, target_dir: &str, overwrite: bool) -> TransferEvent {
    transfer(TransferInput {
        connection_id: connection_id.to_string(),
        direction: TransferDirection::Upload,
        source: source.to_str().unwrap().to_string(),
        target_dir: target_dir.to_string(),
        overwrite,
    })
}

fn download(
    connection_id: &str,
    source: &str,
    target_dir: &Path,
    overwrite: bool,
) -> TransferEvent {
    transfer(TransferInput {
        connection_id: connection_id.to_string(),
        direction: TransferDirection::Download,
        source: source.to_string(),
        target_dir: target_dir.to_str().unwrap().to_string(),
        overwrite,
    })
}

fn assert_done(event: TransferEvent) -> (u64, u64, u64) {
    match event {
        TransferEvent::Done {
            bytes,
            files,
            skipped,
            ..
        } => (bytes, files, skipped),
        other => panic!("expected the transfer to finish, got {:?}", other),
    }
}

fn remote(session_id: &str) -> PaneTarget {
    PaneTarget::Remote {
        session_id: session_id.to_string(),
    }
}

/// Names in a remote folder, hidden ones included: temporary files show here.
fn remote_names(connection_id: &str, dir: &str) -> Vec<String> {
    let session = sftp_connect_sync(connection_id).unwrap();
    let listing = block_on(sftp_list(remote(&session.session_id), dir.to_string())).unwrap();
    sftp_disconnect(session.session_id);
    listing.entries.into_iter().map(|e| e.name).collect()
}

#[test]
#[ignore]
fn live_sftp_browses_and_changes_files() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        let session = sftp_connect_sync(id).unwrap();
        let sid = || remote(&session.session_id);
        assert!(session.label.contains('@'), "{}", session.label);

        let made = block_on(sftp_mkdir(sid(), dir.path.clone(), "sub".to_string())).unwrap();
        assert_eq!(made, dir.child("sub"));
        let err = block_on(sftp_mkdir(sid(), dir.path.clone(), "sub".to_string())).unwrap_err();
        assert!(err.contains("already exists"), "{}", err);
        let err = block_on(sftp_mkdir(sid(), dir.path.clone(), "../up".to_string())).unwrap_err();
        assert!(err.contains("cannot contain"), "{}", err);

        sh(id, &format!("printf hello > {}", dir.child("a.txt")));
        sh(id, &format!("ln -s sub {}", dir.child("link")));

        let listing = block_on(sftp_list(sid(), dir.path.clone())).unwrap();
        let find = |name: &str| listing.entries.iter().find(|e| e.name == name).unwrap();
        assert_eq!(listing.path, dir.path);
        assert_eq!(listing.parent.as_deref(), Some("/tmp"));
        assert_eq!(find("sub").kind, FileKind::Dir);
        assert_eq!(find("a.txt").kind, FileKind::File);
        assert_eq!(find("a.txt").size, Some(5));
        assert_eq!(find("link").kind, FileKind::Symlink);
        assert!(find("link").target_is_dir);

        let renamed =
            block_on(sftp_rename(sid(), dir.child("a.txt"), "b.txt".to_string())).unwrap();
        assert_eq!(renamed, dir.child("b.txt"));
        let err = block_on(sftp_rename(sid(), dir.child("b.txt"), "sub".to_string())).unwrap_err();
        assert!(err.contains("already exists"), "{}", err);

        block_on(sftp_chmod(sid(), dir.child("b.txt"), 0o640)).unwrap();
        let listing = block_on(sftp_list(sid(), dir.path.clone())).unwrap();
        let file = listing.entries.iter().find(|e| e.name == "b.txt").unwrap();
        assert_eq!(file.mode, Some(0o640));
        let err = block_on(sftp_chmod(sid(), dir.child("link"), 0o600)).unwrap_err();
        assert!(err.contains("symbolic link"), "{}", err);
        let err = block_on(sftp_chmod(sid(), dir.child("b.txt"), 0o10000)).unwrap_err();
        assert!(err.contains("not a valid file mode"), "{}", err);

        let err = block_on(sftp_list(sid(), dir.child("missing"))).unwrap_err();
        assert!(err.contains("Could not open"), "{}", err);
        assert!(!err.contains(super::SESSION_LOST), "{}", err);
        // A failed call leaves the session usable.
        assert!(block_on(sftp_list(sid(), dir.path.clone())).is_ok());

        sftp_disconnect(session.session_id.clone());
        let err = block_on(sftp_list(sid(), dir.path.clone())).unwrap_err();
        assert!(err.starts_with(super::SESSION_LOST), "{}", err);
    });
}

#[test]
#[ignore]
fn live_sftp_delete_removes_links_and_keeps_what_they_point_to() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        sh(
            id,
            &format!(
                "mkdir -p {keep} {victim}/deep && printf stay > {keep}/sentinel && \
                 printf gone > {victim}/deep/file && ln -s {keep} {victim}/link && \
                 ln -s {keep}/sentinel {victim}/deep/file-link && ln -s {keep} {direct}",
                keep = dir.child("keep"),
                victim = dir.child("victim"),
                direct = dir.child("direct"),
            ),
        );
        let session = sftp_connect_sync(id).unwrap();
        let sid = || remote(&session.session_id);

        block_on(sftp_delete(sid(), dir.child("victim"))).unwrap();
        block_on(sftp_delete(sid(), dir.child("direct"))).unwrap();
        assert_eq!(remote_names(id, &dir.path), ["keep"]);
        let sentinel = sh(id, &format!("cat {}/sentinel", dir.child("keep")));
        assert_eq!(sentinel, "stay", "a symlink's target must survive");

        for refused in ["/", "/tmp/../etc", "relative"] {
            assert!(
                block_on(sftp_delete(sid(), refused.to_string())).is_err(),
                "{}",
                refused
            );
        }
        let home = sh(id, "pwd").trim_end().to_string();
        let above = super::remote_parent(&home).unwrap();
        let name = super::remote_name(&home).unwrap();
        let sentinel = format!("{}/.ssix-live-{}", home, uuid::Uuid::new_v4().simple());
        sh(id, &format!("touch {}", sentinel));
        // The same folders reached through a link, as a listing could.
        sh(id, &format!("ln -s {} {}", above, dir.child("alias")));
        for refused in [
            home.clone(),
            above.clone(),
            format!("{}/{}", dir.child("alias"), name),
        ] {
            let err = block_on(sftp_delete(sid(), refused.clone())).unwrap_err();
            assert!(err.contains("login folder"), "{}: {}", refused, err);
        }
        sh(id, &format!("test -e {sentinel} && rm {sentinel}"));
        sftp_disconnect(session.session_id);
    });
}

#[test]
#[ignore]
fn live_sftp_round_trips_a_file_and_asks_before_replacing() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        let local = TempDir::new("live-file");
        let payload: Vec<u8> = (0..1_000_000u32).flat_map(|i| i.to_le_bytes()).collect();
        let source = local.0.join("data.bin");
        fs::write(&source, &payload).unwrap();

        let (bytes, files, _) = assert_done(upload(id, &source, &dir.path, false));
        assert_eq!(bytes, payload.len() as u64);
        assert_eq!(files, 1);
        assert_eq!(
            remote_names(id, &dir.path),
            ["data.bin"],
            "no temporary left"
        );

        // A second upload stops at the existing file and writes nothing.
        fs::write(&source, b"replacement").unwrap();
        match upload(id, &source, &dir.path, false) {
            TransferEvent::Conflict {
                target,
                target_is_dir,
                ..
            } => {
                assert_eq!(target, dir.child("data.bin"));
                assert!(!target_is_dir);
            }
            other => panic!("expected a conflict, got {:?}", other),
        }
        sh(id, &format!("chmod 640 {}", dir.child("data.bin")));

        let down = TempDir::new("live-down");
        assert_done(download(id, &dir.child("data.bin"), &down.0, false));
        assert_eq!(fs::read(down.0.join("data.bin")).unwrap(), payload);

        // Asked and answered: the file is replaced, and keeps its mode.
        assert_done(upload(id, &source, &dir.path, true));
        assert_eq!(
            remote_names(id, &dir.path),
            ["data.bin"],
            "no old copy left"
        );
        assert_eq!(
            sh(id, &format!("cat {}", dir.child("data.bin"))),
            "replacement"
        );
        let mode = sh(id, &format!("stat -c %a {}", dir.child("data.bin")));
        assert_eq!(mode.trim(), "640");

        // The local side asks too, then replaces.
        assert!(matches!(
            download(id, &dir.child("data.bin"), &down.0, false),
            TransferEvent::Conflict { .. }
        ));
        assert_eq!(fs::read(down.0.join("data.bin")).unwrap(), payload);
        assert_done(download(id, &dir.child("data.bin"), &down.0, true));
        assert_eq!(fs::read(down.0.join("data.bin")).unwrap(), b"replacement");
    });
}

#[test]
#[ignore]
fn live_sftp_writes_through_a_symlink_instead_of_replacing_it() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        sh(
            id,
            &format!(
                "printf old > {real} && ln -s real.txt {link}",
                real = dir.child("real.txt"),
                link = dir.child("link.txt"),
            ),
        );
        let local = TempDir::new("live-link");
        let source = local.0.join("link.txt");
        fs::write(&source, b"new").unwrap();
        assert_done(upload(id, &source, &dir.path, true));
        assert_eq!(sh(id, &format!("cat {}", dir.child("real.txt"))), "new");
        let kind = sh(id, &format!("stat -c %F {}", dir.child("link.txt")));
        assert!(kind.contains("symbolic link"), "{}", kind);
    });
}

#[test]
#[ignore]
fn live_sftp_round_trips_a_folder_without_following_links() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        let local = TempDir::new("live-tree");
        let tree = local.0.join("tree");
        fs::create_dir_all(tree.join("sub/deep")).unwrap();
        fs::write(tree.join("top.txt"), "top").unwrap();
        fs::write(tree.join("sub/deep/low.txt"), "low").unwrap();
        fs::write(local.0.join("outside.txt"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(local.0.join("outside.txt"), tree.join("escape")).unwrap();

        let (bytes, files, skipped) = assert_done(upload(id, &tree, &dir.path, false));
        assert_eq!((bytes, files), (6, 2));
        assert_eq!(skipped, 1, "the symlink");
        assert_eq!(
            sh(id, &format!("cat {}/sub/deep/low.txt", dir.child("tree"))),
            "low"
        );
        assert!(matches!(
            upload(id, &tree, &dir.path, false),
            TransferEvent::Conflict {
                target_is_dir: true,
                ..
            }
        ));

        sh(
            id,
            &format!("ln -s /etc/passwd {}/passwd-link", dir.child("tree")),
        );
        let down = TempDir::new("live-tree-down");
        let (_, files, skipped) = assert_done(download(id, &dir.child("tree"), &down.0, false));
        assert_eq!((files, skipped), (2, 1));
        let got = down.0.join("tree");
        assert_eq!(fs::read_to_string(got.join("top.txt")).unwrap(), "top");
        assert_eq!(
            fs::read_to_string(got.join("sub/deep/low.txt")).unwrap(),
            "low"
        );
        assert!(!got.join("passwd-link").exists());
    });
}

#[cfg(unix)]
#[test]
#[ignore]
fn live_sftp_carries_folder_modes_both_ways() {
    use std::os::unix::fs::PermissionsExt;
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        let local = TempDir::new("live-modes");
        let tree = local.0.join("tree");
        fs::create_dir_all(tree.join("private")).unwrap();
        fs::create_dir(tree.join("sealed")).unwrap();
        fs::write(tree.join("private/f.txt"), "x").unwrap();
        fs::write(tree.join("sealed/f.txt"), "y").unwrap();
        let set_mode = |path: &Path, mode: u32| {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap()
        };
        let local_mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        set_mode(&tree, 0o750);
        set_mode(&tree.join("private"), 0o700);
        set_mode(&tree.join("sealed"), 0o500);

        assert_done(upload(id, &tree, &dir.path, false));
        let up = dir.child("tree");
        let remote_mode = |path: &str| {
            sh(id, &format!("stat -c %a {}", path))
                .trim_end()
                .to_string()
        };
        assert_eq!(remote_mode(&up), "750");
        assert_eq!(remote_mode(&format!("{}/private", up)), "700");
        assert_eq!(remote_mode(&format!("{}/sealed", up)), "500");
        assert_eq!(sh(id, &format!("cat {}/sealed/f.txt", up)), "y");

        let down = TempDir::new("live-modes-down");
        assert_done(download(id, &up, &down.0, false));
        let got = down.0.join("tree");
        assert_eq!(local_mode(&got), 0o750);
        assert_eq!(local_mode(&got.join("private")), 0o700);
        assert_eq!(local_mode(&got.join("sealed")), 0o500);
        assert_eq!(fs::read_to_string(got.join("sealed/f.txt")).unwrap(), "y");

        // Into folders that exist, each keeps its own mode.
        sh(id, &format!("chmod -R u+w {up} && chmod 755 {up}/private"));
        set_mode(&got.join("sealed"), 0o700);
        set_mode(&got.join("private"), 0o755);
        assert_done(upload(id, &tree, &dir.path, true));
        assert_eq!(remote_mode(&format!("{}/private", up)), "755");
        assert_done(download(id, &up, &down.0, true));
        assert_eq!(local_mode(&got.join("private")), 0o755);

        // Both temporary folders can be removed again.
        sh(id, &format!("chmod -R u+w {}", up));
        set_mode(&tree.join("sealed"), 0o700);
    });
}

/// Many transfers queued at once log in no more often than there are workers,
/// including when some of them stop to ask about a file that exists.
#[test]
#[ignore]
fn live_sftp_queued_transfers_share_their_logins() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        let local = TempDir::new("live-queue");
        let count = 24;
        let (sender, ends) = mpsc::channel();
        let emit: Emit = Arc::new(move |event| {
            if !matches!(event, TransferEvent::Progress { .. }) {
                let _ = sender.send(event);
            }
        });
        let upload_all_expecting = |wanted: fn(&TransferEvent) -> bool| {
            let logins = LOGINS.load(Ordering::SeqCst);
            for i in 0..count {
                let source = local.0.join(format!("f{}.txt", i));
                fs::write(&source, format!("file {}", i)).unwrap();
                let input = TransferInput {
                    connection_id: id.to_string(),
                    direction: TransferDirection::Upload,
                    source: source.to_str().unwrap().to_string(),
                    target_dir: dir.path.clone(),
                    overwrite: false,
                };
                start_transfer(input, emit.clone()).unwrap();
            }
            for _ in 0..count {
                let end = ends.recv_timeout(Duration::from_secs(60)).unwrap();
                assert!(wanted(&end), "{:?}", end);
            }
            let used = LOGINS.load(Ordering::SeqCst) - logins;
            assert!(used <= MAX_ACTIVE, "{} logins for {} files", used, count);
        };

        upload_all_expecting(|end| matches!(end, TransferEvent::Done { .. }));
        assert_eq!(remote_names(id, &dir.path).len(), count);
        assert_eq!(sh(id, &format!("cat {}", dir.child("f7.txt"))), "file 7");

        upload_all_expecting(|end| matches!(end, TransferEvent::Conflict { .. }));
    });
}

/// libssh2 sessions are not safe to share between threads. Here each worker
/// and the browsing pane have a session of their own, so running them all at
/// once must not disturb any of them.
#[test]
#[ignore]
fn live_sftp_transfers_and_browsing_at_once_keep_every_byte() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        let up = TempDir::new("live-together-up");
        let down = TempDir::new("live-together-down");
        // Different lengths and bytes, so a mix-up cannot pass.
        let files: Vec<(String, Vec<u8>)> = (0..6usize)
            .map(|i| {
                let name = format!("f{}.bin", i);
                let content: Vec<u8> = (0..4 * 1024 * 1024 + i * 4099)
                    .map(|b| (b % 251) as u8 ^ i as u8)
                    .collect();
                fs::write(up.0.join(&name), &content).unwrap();
                (name, content)
            })
            .collect();

        let session = sftp_connect_sync(id).unwrap();
        let session_id = session.session_id.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let browsing = {
            let (session_id, path, stop) = (session_id.clone(), dir.path.clone(), stop.clone());
            thread::spawn(move || {
                let mut listings = 0;
                while !stop.load(Ordering::SeqCst) {
                    block_on(sftp_list(remote(&session_id), path.clone()))
                        .expect("listing while transfers run");
                    listings += 1;
                }
                listings
            })
        };

        let uploads: Vec<_> = files
            .iter()
            .map(|(name, _)| {
                let (id, source, target) = (id.to_string(), up.0.join(name), dir.path.clone());
                thread::spawn(move || upload(&id, &source, &target, false))
            })
            .collect();
        for running in uploads {
            assert_done(running.join().unwrap());
        }
        let downloads: Vec<_> = files
            .iter()
            .map(|(name, _)| {
                let (id, source, target) = (id.to_string(), dir.child(name), down.0.clone());
                thread::spawn(move || download(&id, &source, &target, false))
            })
            .collect();
        for running in downloads {
            assert_done(running.join().unwrap());
        }

        stop.store(true, Ordering::SeqCst);
        assert!(browsing.join().unwrap() > 0, "the pane never listed");
        // The session that browsed through all of it still answers.
        let names = block_on(sftp_list(remote(&session_id), dir.path.clone()))
            .unwrap()
            .entries
            .len();
        assert_eq!(names, files.len());
        sftp_disconnect(session_id);
        for (name, content) in &files {
            assert!(
                fs::read(down.0.join(name)).unwrap() == *content,
                "{} changed on the way",
                name
            );
        }
    });
}

#[test]
#[ignore]
fn live_sftp_cancelled_transfers_leave_no_partial_file() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        let local = TempDir::new("live-cancel");
        let big = local.0.join("big.bin");
        // Sparse, so the source takes no disk here.
        let file = fs::File::create(&big).unwrap();
        file.set_len(1024 * 1024 * 1024).unwrap();
        drop(file);

        // Cancelled from its own progress report, so it is mid-copy.
        let last = cancel_at_first_bytes(TransferInput {
            connection_id: id.to_string(),
            direction: TransferDirection::Upload,
            source: big.to_str().unwrap().to_string(),
            target_dir: dir.path.clone(),
            overwrite: false,
        });
        assert!(
            matches!(last, TransferEvent::Cancelled { .. }),
            "{:?}",
            last
        );
        assert!(
            remote_names(id, &dir.path).is_empty(),
            "the upload must leave nothing behind"
        );

        sh(
            id,
            &format!(
                "dd if=/dev/zero of={} bs=1M count=0 seek=1024 2>/dev/null",
                dir.child("big.remote")
            ),
        );
        let down = TempDir::new("live-cancel-down");
        fs::write(down.0.join("big.remote"), "previous").unwrap();
        let last = cancel_at_first_bytes(TransferInput {
            connection_id: id.to_string(),
            direction: TransferDirection::Download,
            source: dir.child("big.remote"),
            target_dir: down.0.to_str().unwrap().to_string(),
            overwrite: true,
        });
        assert!(
            matches!(last, TransferEvent::Cancelled { .. }),
            "{:?}",
            last
        );
        let names: Vec<_> = fs::read_dir(&down.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["big.remote"], "no partial file beside the target");
        assert_eq!(
            fs::read_to_string(down.0.join("big.remote")).unwrap(),
            "previous",
            "the old file must survive"
        );
    });
}

#[test]
#[ignore]
fn live_sftp_edit_detects_a_change_on_the_server_and_asks() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        let path = dir.child("conf.txt");
        sh(id, &format!("printf one > {} && chmod 640 {}", path, path));

        let edit = edit_open(id, &path).unwrap();
        assert_eq!(edit.name, "conf.txt");
        assert_eq!(edit.size, 3);
        let copy = Path::new(&edit.temp_path).to_path_buf();
        assert!(copy.starts_with(data_dir()), "{}", copy.display());
        assert_eq!(fs::read_to_string(&copy).unwrap(), "one");
        assert!(!edit_status(&edit.edit_id).unwrap().modified);

        // An ordinary save.
        fs::write(&copy, "two!").unwrap();
        assert!(edit_status(&edit.edit_id).unwrap().modified);
        assert_eq!(
            edit_save(&edit.edit_id, false).unwrap(),
            EditSaveOutcome::Saved { size: 4 }
        );
        assert_eq!(sh(id, &format!("cat {}", path)), "two!");
        assert_eq!(sh(id, &format!("stat -c %a {}", path)).trim(), "640");
        assert!(!edit_status(&edit.edit_id).unwrap().modified);
        assert_eq!(remote_names(id, &dir.path), ["conf.txt"]);

        // Someone else changes it: the save stops, whatever the copy says.
        sh(id, &format!("printf server-side > {}", path));
        fs::write(&copy, "three").unwrap();
        match edit_save(&edit.edit_id, false).unwrap() {
            EditSaveOutcome::RemoteChanged { deleted, size, .. } => {
                assert!(!deleted);
                assert_eq!(size, Some(11));
            }
            other => panic!("expected a detected change, got {:?}", other),
        }
        assert_eq!(sh(id, &format!("cat {}", path)), "server-side");
        assert_eq!(remote_names(id, &dir.path), ["conf.txt"], "nothing staged");

        // The user said overwrite.
        assert_eq!(
            edit_save(&edit.edit_id, true).unwrap(),
            EditSaveOutcome::Saved { size: 5 }
        );
        assert_eq!(sh(id, &format!("cat {}", path)), "three");
        // And what was just saved is what the next save compares with.
        assert!(matches!(
            edit_save(&edit.edit_id, false).unwrap(),
            EditSaveOutcome::Saved { .. }
        ));

        // A change the size and time do not show: same length, time put back.
        let stamp = sh(id, &format!("stat -c %Y {}", path));
        sh(
            id,
            &format!(
                "printf THREE > {path} && touch -d @{stamp} {path}",
                path = path,
                stamp = stamp.trim()
            ),
        );
        assert!(matches!(
            edit_save(&edit.edit_id, false).unwrap(),
            EditSaveOutcome::RemoteChanged { deleted: false, .. }
        ));

        // Deleted on the server: also asks, and saving brings it back.
        sh(id, &format!("rm {}", path));
        assert_eq!(
            edit_save(&edit.edit_id, false).unwrap(),
            EditSaveOutcome::RemoteChanged {
                deleted: true,
                size: None,
                modified: None,
            }
        );
        assert!(matches!(
            edit_save(&edit.edit_id, true).unwrap(),
            EditSaveOutcome::Saved { .. }
        ));
        assert_eq!(sh(id, &format!("cat {}", path)), "three");
        assert_eq!(sh(id, &format!("stat -c %a {}", path)).trim(), "640");

        let folder = copy.parent().unwrap().to_path_buf();
        assert!(folder.exists());
        edit_close(&edit.edit_id).unwrap();
        assert!(!folder.exists(), "closing removes the copy");
    });
}

#[test]
#[ignore]
fn live_sftp_edit_refuses_folders_and_a_missing_file_and_saves_through_a_link() {
    with_connection(|id| {
        let dir = RemoteDir::new(id);
        let err = edit_open(id, &dir.path).unwrap_err();
        assert!(err.contains("not a file"), "{}", err);
        assert!(edit_open(id, &dir.child("missing")).is_err());

        sh(
            id,
            &format!(
                "printf x > {real} && ln -s real {link}",
                real = dir.child("real"),
                link = dir.child("link"),
            ),
        );
        let edit = edit_open(id, &dir.child("link")).unwrap();
        assert_eq!(edit.remote_path, dir.child("real"));
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&edit.temp_path)
            .unwrap();
        file.write_all(b"y").unwrap();
        drop(file);
        edit_save(&edit.edit_id, false).unwrap();
        assert_eq!(sh(id, &format!("cat {}", dir.child("real"))), "xy");
        let kind = sh(id, &format!("stat -c %F {}", dir.child("link")));
        assert!(kind.contains("symbolic link"), "{}", kind);
        edit_close(&edit.edit_id).unwrap();
    });
}

/// Every path into the server goes through host-key verification.
#[test]
#[ignore]
fn live_sftp_refuses_a_changed_host_key_on_every_path() {
    with_connection(|id| {
        // One entry per algorithm, so whichever the server presents differs.
        let addr = var("SSIX_LIVE_SSH");
        let (host, port) = addr.rsplit_once(':').unwrap();
        let body = base64_blob();
        let planted: String = [
            "ssh-ed25519",
            "ssh-rsa",
            "ecdsa-sha2-nistp256",
            "ecdsa-sha2-nistp384",
            "ecdsa-sha2-nistp521",
        ]
        .iter()
        .map(|algorithm| format!("[{}]:{} {} {}\n", host, port, algorithm, body(algorithm)))
        .collect();
        fs::write(data_dir().join("known_hosts"), planted).unwrap();

        let marker = "HOST_KEY_MISMATCH";
        let err = sftp_connect_sync(id).unwrap_err();
        assert!(err.contains(marker), "{}", err);
        let err = open_sftp(id).err().unwrap();
        assert!(err.contains(marker), "{}", err);
        let err = edit_open(id, "/etc/hostname").unwrap_err();
        assert!(err.contains(marker), "{}", err);
        let local = TempDir::new("live-hostkey");
        match download(id, "/etc/hostname", &local.0, false) {
            TransferEvent::Failed { error, .. } => assert!(error.contains(marker), "{}", error),
            other => panic!("expected a refusal, got {:?}", other),
        }
    });
}

/// A syntactically valid key blob no real server has.
fn base64_blob() -> impl Fn(&str) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    |algorithm: &str| {
        let mut blob = (algorithm.len() as u32).to_be_bytes().to_vec();
        blob.extend_from_slice(algorithm.as_bytes());
        blob.extend_from_slice(&[0x42; 32]);
        STANDARD.encode(blob)
    }
}
