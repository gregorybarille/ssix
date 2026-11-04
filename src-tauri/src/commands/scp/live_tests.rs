//! The SCP dialog's copies against a real SSH server. `sftp::live_tests` says
//! how to point them at one; run these with `cargo test live_scp -- --ignored
//! --test-threads=1`. The peak-memory test only means something on its own
//! thread, and the shaped links are a relay in this process.

use super::*;
use crate::commands::sftp::browse::TempDir;
use crate::commands::sftp::live_tests::{sh, with_connection, RemoteDir};
use crate::models::ConnectionKind;
use crate::storage::with_data_mut;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::thread;
use std::time::{Duration, Instant};

const MIB: usize = 1024 * 1024;

fn upload(connection_id: &str, local: &Path, remote_dir: &str) -> Result<ScpResult, String> {
    scp_upload_sync(ScpUploadInput {
        connection_id: connection_id.to_string(),
        local_path: local.to_str().unwrap().to_string(),
        remote_path: Some(remote_dir.to_string()),
        recursive: true,
    })
}

fn download(connection_id: &str, remote: &str, local: &Path) -> Result<ScpResult, String> {
    scp_download_sync(ScpDownloadInput {
        connection_id: connection_id.to_string(),
        remote_path: remote.to_string(),
        local_path: local.to_str().unwrap().to_string(),
        recursive: true,
    })
}

/// Bytes no chunk boundary can hide a mistake in.
fn payload(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

fn write_local(path: &Path, bytes: &[u8], mode: u32) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn local_mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn remote_mode(connection_id: &str, path: &str) -> String {
    sh(connection_id, &format!("stat -c %a {}", path))
        .trim()
        .to_string()
}

fn write_remote(connection_id: &str, path: &str, bytes: &[u8], mode: i32) {
    let (data, conn) = find_connection(connection_id).unwrap();
    let ssh = connect_session(&data, &conn, "the live test").unwrap();
    let sftp = ssh.session.sftp().unwrap();
    let mut file = sftp
        .open_mode(
            Path::new(path),
            ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::TRUNCATE,
            mode,
            ssh2::OpenType::File,
        )
        .unwrap();
    file.write_all(bytes).unwrap();
}

fn read_remote(connection_id: &str, path: &str) -> Vec<u8> {
    let (data, conn) = find_connection(connection_id).unwrap();
    let ssh = connect_session(&data, &conn, "the live test").unwrap();
    let sftp = ssh.session.sftp().unwrap();
    let mut bytes = Vec::new();
    sftp.open(Path::new(path))
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    bytes
}

/// Names in a folder, hidden ones too: a temporary file left behind shows here.
fn remote_names(connection_id: &str, dir: &str) -> Vec<String> {
    let mut names: Vec<String> = sh(connection_id, &format!("ls -A {}", dir))
        .lines()
        .map(str::to_string)
        .collect();
    names.sort();
    names
}

fn local_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_str().unwrap().to_string())
        .collect();
    names.sort();
    names
}

/// The bad link a test wants, per direction of a relayed connection.
#[derive(Clone, Copy)]
enum Link {
    /// At most this many bytes a second.
    Slow(usize),
    /// After this many bytes, close the connection.
    CutAfter(usize),
    /// After this many bytes nothing moves, yet the connection stays open.
    DeadAfter(usize),
}

fn pump(mut from: TcpStream, mut to: TcpStream, link: Link) {
    let mut buffer = [0u8; 16 * 1024];
    let mut total = 0;
    while let Ok(read) = from.read(&mut buffer) {
        if read == 0 {
            break;
        }
        total += read;
        match link {
            Link::Slow(rate) => {
                thread::sleep(Duration::from_secs_f64(read as f64 / rate as f64));
            }
            Link::CutAfter(limit) if total > limit => break,
            Link::DeadAfter(limit) if total > limit => {
                // Outlives any test, holding both sockets open.
                thread::sleep(Duration::from_secs(600));
            }
            _ => {}
        }
        if to.write_all(&buffer[..read]).is_err() {
            break;
        }
    }
    let _ = from.shutdown(Shutdown::Both);
    let _ = to.shutdown(Shutdown::Both);
}

/// A saved connection to the live server through a relay with this link.
fn connection_over(connection_id: &str, link: Link) -> String {
    let (_, live) = find_connection(connection_id).unwrap();
    let server = format!("{}:{}", live.host, live.port);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for client in listener.incoming() {
            let client = client.unwrap();
            let upstream = TcpStream::connect(&server).unwrap();
            let (client_out, upstream_out) =
                (client.try_clone().unwrap(), upstream.try_clone().unwrap());
            thread::spawn(move || pump(client_out, upstream_out, link));
            thread::spawn(move || pump(upstream, client, link));
        }
    });
    let relayed = Connection::new(
        "relayed".to_string(),
        "127.0.0.1".to_string(),
        port,
        live.credential_id.clone(),
        ConnectionKind::Direct,
    );
    let id = relayed.id.clone();
    with_data_mut(|data| {
        data.connections.push(relayed);
        Ok(())
    })
    .unwrap();
    id
}

/// The most memory this process has held, in bytes.
fn peak_memory() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) }, 0);
    let peak = usage.ru_maxrss as u64;
    if cfg!(target_os = "macos") {
        peak
    } else {
        peak * 1024
    }
}

#[test]
#[ignore]
fn live_scp_upload_of_many_chunks_arrives_whole_with_the_sources_mode() {
    with_connection(|id| {
        let local = TempDir::new("scp-up");
        let remote = RemoteDir::new(id);
        let source = local.0.join("private.bin");
        let bytes = payload(3 * 128 * 1024 + 5);
        write_local(&source, &bytes, 0o600);

        let result = upload(id, &source, &remote.path).unwrap();

        let target = remote.child("private.bin");
        assert_eq!(result.remote_path, target);
        assert_eq!(result.bytes, bytes.len() as u64);
        assert_eq!(result.entries, Some(1));
        assert_eq!(read_remote(id, &target), bytes);
        assert_eq!(remote_mode(id, &target), "600");
        assert_eq!(remote_names(id, &remote.path), ["private.bin"]);
    });
}

#[test]
#[ignore]
fn live_scp_upload_over_a_file_keeps_that_files_mode() {
    with_connection(|id| {
        let local = TempDir::new("scp-over");
        let remote = RemoteDir::new(id);
        let source = local.0.join("config");
        write_local(&source, b"new", 0o644);
        let target = remote.child("config");
        write_remote(id, &target, b"old", 0o640);
        sh(id, &format!("chmod 640 {}", target));

        upload(id, &source, &remote.path).unwrap();

        assert_eq!(read_remote(id, &target), b"new");
        assert_eq!(remote_mode(id, &target), "640");
        assert_eq!(remote_names(id, &remote.path), ["config"]);
    });
}

#[test]
#[ignore]
fn live_scp_download_takes_the_servers_mode_and_keeps_a_local_files() {
    with_connection(|id| {
        let local = TempDir::new("scp-down");
        let remote = RemoteDir::new(id);
        let bytes = payload(3 * 128 * 1024 + 5);

        let private = remote.child("private.bin");
        write_remote(id, &private, &bytes, 0o600);
        let fresh = local.0.join("fresh.bin");
        let result = download(id, &private, &fresh).unwrap();
        assert_eq!(result.bytes, bytes.len() as u64);
        assert_eq!(result.entries, Some(1));
        assert_eq!(fs::read(&fresh).unwrap(), bytes);
        assert_eq!(local_mode(&fresh), 0o600);

        // The `.env` case: the server's copy is more open than the local one.
        let open = remote.child("env");
        write_remote(id, &open, b"new", 0o644);
        sh(id, &format!("chmod 644 {}", open));
        let env = local.0.join(".env");
        write_local(&env, b"old", 0o600);
        download(id, &open, &env).unwrap();
        assert_eq!(fs::read(&env).unwrap(), b"new");
        assert_eq!(local_mode(&env), 0o600);

        assert_eq!(local_names(&local.0), [".env", "fresh.bin"]);
    });
}

#[test]
#[ignore]
fn live_scp_folders_keep_their_modes_both_ways() {
    with_connection(|id| {
        let local = TempDir::new("scp-tree");
        let remote = RemoteDir::new(id);
        let tree = local.0.join("tree");
        fs::create_dir(&tree).unwrap();
        fs::create_dir(tree.join("sub")).unwrap();
        write_local(&tree.join("sub/key"), b"secret", 0o600);
        fs::set_permissions(tree.join("sub"), fs::Permissions::from_mode(0o750)).unwrap();
        fs::set_permissions(&tree, fs::Permissions::from_mode(0o700)).unwrap();

        let up = upload(id, &tree, &remote.path).unwrap();
        assert_eq!(up.entries, Some(1));
        assert_eq!(up.bytes, 6);
        let remote_tree = remote.child("tree");
        assert_eq!(remote_mode(id, &remote_tree), "700");
        assert_eq!(remote_mode(id, &format!("{}/sub", remote_tree)), "750");
        assert_eq!(remote_mode(id, &format!("{}/sub/key", remote_tree)), "600");

        let back = local.0.join("deep/back");
        let down = download(id, &remote_tree, &back).unwrap();
        assert_eq!(down.entries, Some(1));
        assert_eq!(down.bytes, 6);
        assert_eq!(fs::read(back.join("sub/key")).unwrap(), b"secret");
        assert_eq!(local_mode(&back), 0o700);
        assert_eq!(local_mode(&back.join("sub")), 0o750);
        assert_eq!(local_mode(&back.join("sub/key")), 0o600);
    });
}

#[test]
#[ignore]
fn live_scp_cut_connection_leaves_the_old_file_on_both_sides() {
    with_connection(|id| {
        let local = TempDir::new("scp-cut");
        let remote = RemoteDir::new(id);
        let cut = connection_over(id, Link::CutAfter(MIB));

        let source = local.0.join("big.bin");
        write_local(&source, &payload(8 * MIB), 0o644);
        let target = remote.child("big.bin");
        write_remote(id, &target, b"old", 0o644);
        assert!(upload(&cut, &source, &remote.path).is_err());
        assert_eq!(read_remote(id, &target), b"old");

        let big = remote.child("for-download.bin");
        write_remote(id, &big, &payload(8 * MIB), 0o644);
        let kept = local.0.join("kept.bin");
        write_local(&kept, b"old", 0o644);
        assert!(download(&cut, &big, &kept).is_err());
        assert_eq!(fs::read(&kept).unwrap(), b"old");
        assert_eq!(local_names(&local.0), ["big.bin", "kept.bin"]);
    });
}

/// 100 MB on a 20 Mbit uplink failed at 15 s with "API timeout expired".
#[test]
#[ignore]
fn live_scp_slow_upload_outlasts_the_session_timeout() {
    with_connection(|id| {
        let local = TempDir::new("scp-slow");
        let remote = RemoteDir::new(id);
        let slow = connection_over(id, Link::Slow(MIB));
        let source = local.0.join("slow.bin");
        let bytes = payload(20 * MIB);
        write_local(&source, &bytes, 0o644);
        let target = remote.child("slow.bin");
        write_remote(id, &target, b"old", 0o644);

        let started = Instant::now();
        let result = upload(&slow, &source, &remote.path);
        let took = started.elapsed();
        eprintln!(
            "20 MiB through a 1 MiB/s link took {:?}: {:?}",
            took, result
        );

        result.unwrap();
        assert!(took > Duration::from_secs(16), "too quick: {:?}", took);
        assert_eq!(read_remote(id, &target), bytes);
    });
}

#[test]
#[ignore]
fn live_scp_copies_do_not_hold_the_file_in_memory() {
    with_connection(|id| {
        let local = TempDir::new("scp-memory");
        let remote = RemoteDir::new(id);
        let size = 256 * MIB as u64;
        let source = local.0.join("sparse.bin");
        fs::File::create(&source).unwrap().set_len(size).unwrap();

        let before = peak_memory();
        let up = upload(id, &source, &remote.path).unwrap();
        assert_eq!(up.bytes, size);
        let after_upload = peak_memory();
        let back = local.0.join("back.bin");
        let down = download(id, &remote.child("sparse.bin"), &back).unwrap();
        assert_eq!(down.bytes, size);
        let after_download = peak_memory();
        eprintln!(
            "peak memory grew by {} KiB on a 256 MiB upload, then {} KiB on its download",
            (after_upload - before) / 1024,
            (after_download - after_upload) / 1024
        );

        assert_eq!(fs::metadata(&back).unwrap().len(), size);
        assert!(after_upload - before < 64 * MIB as u64);
        assert!(after_download - after_upload < 64 * MIB as u64);

        let (data, conn) = find_connection(id).unwrap();
        let ssh = connect_session(&data, &conn, "the live test").unwrap();
        let legacy = local.0.join("legacy.bin");
        let target = remote.child("legacy.bin");
        fs::File::create(&legacy).unwrap().set_len(size).unwrap();
        assert_eq!(upload_file_scp(&ssh, &legacy, &target).unwrap(), size);
        let back = local.0.join("legacy-back.bin");
        assert_eq!(download_file_scp(&ssh, &target, &back).unwrap(), size);
        let after_legacy = peak_memory();
        eprintln!(
            "and by {} KiB on the same both ways over legacy scp",
            (after_legacy - after_download) / 1024
        );
        assert!(after_legacy - after_download < 64 * MIB as u64);
    });
}

/// Runs on any server: `scp_upload` takes this path when `sftp()` is refused.
#[test]
#[ignore]
fn live_scp_legacy_copies_many_chunks_with_modes_and_nothing_left_over() {
    with_connection(|id| {
        let (data, conn) = find_connection(id).unwrap();
        let ssh = connect_session(&data, &conn, "the live test").unwrap();
        let local = TempDir::new("scp-legacy");
        let remote = RemoteDir::new(id);
        let bytes = payload(3 * 128 * 1024 + 5);

        // A new file takes the source's mode.
        let source = local.0.join("private.bin");
        write_local(&source, &bytes, 0o600);
        let target = remote.child("private.bin");
        assert_eq!(
            upload_file_scp(&ssh, &source, &target).unwrap(),
            bytes.len() as u64
        );
        assert_eq!(read_remote(id, &target), bytes);
        assert_eq!(remote_mode(id, &target), "600");

        // A replaced file keeps its own, even one the umask would narrow, and
        // an old file too big to fit in a channel's window is no trouble.
        let open = remote.child("group-writable");
        write_remote(id, &open, &payload(8 * MIB), 0o664);
        sh(id, &format!("chmod 664 {}", open));
        let replacement = local.0.join("group-writable");
        write_local(&replacement, b"new", 0o600);
        upload_file_scp(&ssh, &replacement, &open).unwrap();
        assert_eq!(read_remote(id, &open), b"new");
        assert_eq!(remote_mode(id, &open), "664");

        let empty = local.0.join("empty");
        write_local(&empty, b"", 0o644);
        assert_eq!(
            upload_file_scp(&ssh, &empty, &remote.child("empty")).unwrap(),
            0
        );
        assert!(read_remote(id, &remote.child("empty")).is_empty());

        assert_eq!(
            remote_names(id, &remote.path),
            ["empty", "group-writable", "private.bin"]
        );

        // Downloads: the exact bytes, no status byte after them, and the modes.
        let fresh = local.0.join("fresh.bin");
        assert_eq!(
            download_file_scp(&ssh, &target, &fresh).unwrap(),
            bytes.len() as u64
        );
        assert_eq!(fs::read(&fresh).unwrap(), bytes);
        assert_eq!(local_mode(&fresh), 0o600);

        let env = local.0.join(".env");
        write_local(&env, b"old", 0o600);
        download_file_scp(&ssh, &open, &env).unwrap();
        assert_eq!(fs::read(&env).unwrap(), b"new");
        assert_eq!(local_mode(&env), 0o600);

        let nothing = local.0.join("nothing");
        assert_eq!(
            download_file_scp(&ssh, &remote.child("empty"), &nothing).unwrap(),
            0
        );
        assert!(fs::read(&nothing).unwrap().is_empty());
    });
}

/// The file is sent first and refused at the end, as on a real failure late on.
#[test]
#[ignore]
fn live_scp_legacy_failed_upload_keeps_what_was_there() {
    with_connection(|id| {
        let (data, conn) = find_connection(id).unwrap();
        let ssh = connect_session(&data, &conn, "the live test").unwrap();
        let local = TempDir::new("scp-legacy-fail");
        let remote = RemoteDir::new(id);
        let source = local.0.join("f");
        write_local(&source, b"new", 0o644);

        let folder = remote.child("folder");
        sh(id, &format!("mkdir {}", folder));
        let err = upload_file_scp(&ssh, &source, &folder).unwrap_err();
        assert!(err.contains("in place"), "{}", err);
        assert_eq!(remote_names(id, &folder), Vec::<String>::new());

        let real = remote.child("real");
        write_remote(id, &real, b"old", 0o644);
        let link = remote.child("link");
        sh(id, &format!("ln -s {} {}", real, link));
        assert!(upload_file_scp(&ssh, &source, &link).is_err());
        assert_eq!(read_remote(id, &real), b"old");

        assert_eq!(remote_names(id, &remote.path), ["folder", "link", "real"]);

        // A folder that does not exist gives no temporary name to keep either.
        let missing = remote.child("not-here/f");
        assert!(upload_file_scp(&ssh, &source, &missing).is_err());
        assert_eq!(remote_names(id, &remote.path), ["folder", "link", "real"]);

        let kept = local.0.join("kept");
        write_local(&kept, b"old", 0o644);
        assert!(download_file_scp(&ssh, &remote.child("not-here"), &kept).is_err());
        assert_eq!(fs::read(&kept).unwrap(), b"old");
        assert_eq!(local_names(&local.0), ["f", "kept"]);
    });
}

/// Only bites on a server with `Subsystem sftp` turned off, which the fixtures
/// are not: `scp_upload` and `scp_download` end up in the functions above there.
#[test]
#[ignore]
fn live_scp_commands_fall_back_on_a_server_without_sftp() {
    with_connection(|id| {
        let (data, conn) = find_connection(id).unwrap();
        let ssh = connect_session(&data, &conn, "the live test").unwrap();
        if ssh.session.sftp().is_ok() {
            eprintln!("this server offers SFTP, so there is nothing to fall back from");
            return;
        }
        let local = TempDir::new("scp-no-sftp");
        let remote = RemoteDir::new(id);
        let source = local.0.join("private.bin");
        let bytes = payload(3 * 128 * 1024 + 5);
        write_local(&source, &bytes, 0o600);

        let up = upload(id, &source, &remote.path).unwrap();
        assert_eq!(up.bytes, bytes.len() as u64);
        assert_eq!(up.entries, Some(1));
        let target = remote.child("private.bin");
        assert_eq!(remote_mode(id, &target), "600");
        assert_eq!(remote_names(id, &remote.path), ["private.bin"]);

        let back = local.0.join("deep/back.bin");
        let down = download(id, &target, &back).unwrap();
        assert_eq!(down.bytes, bytes.len() as u64);
        assert_eq!(down.entries, Some(1));
        assert_eq!(fs::read(&back).unwrap(), bytes);
        assert_eq!(local_mode(&back), 0o600);

        // Nothing can ask where `~` is, but `scp` starts there anyway.
        let name = format!("ssix-live-{}", uuid::Uuid::new_v4().simple());
        let in_home = local.0.join(&name);
        write_local(&in_home, b"tilde", 0o644);
        let up = upload(id, &in_home, "~").unwrap();
        assert_eq!(up.remote_path, format!("./{}", name));
        assert_eq!(sh(id, &format!("cat {}", name)), "tilde");
        let tilde_back = local.0.join("tilde-back");
        download(id, &format!("~/{}", name), &tilde_back).unwrap();
        assert_eq!(fs::read(&tilde_back).unwrap(), b"tilde");
        sh(id, &format!("rm {}", name));
        eprintln!("copied both ways over legacy scp");
    });
}

/// The real limits on a link that stops moving, in every way a copy can go: the
/// error comes after about one chunk's limit, with nothing changed on either side.
#[test]
#[ignore]
fn live_scp_dead_link_ends_in_about_30_seconds_and_changes_nothing() {
    with_connection(|id| {
        let local = TempDir::new("scp-dead");
        let remote = RemoteDir::new(id);
        let dead = connection_over(id, Link::DeadAfter(MIB));
        let source = local.0.join("up.bin");
        write_local(&source, &payload(32 * MIB), 0o644);
        let target = remote.child("up.bin");
        write_remote(id, &target, b"old", 0o644);
        let big = remote.child("down.bin");
        write_remote(id, &big, &payload(32 * MIB), 0o644);
        let kept = local.0.join("kept.bin");
        write_local(&kept, b"old", 0o644);

        let timed = |what: &str, copy: &dyn Fn() -> bool| {
            let started = Instant::now();
            assert!(copy(), "{} should fail", what);
            let took = started.elapsed();
            eprintln!("{} on a dead link failed after {:?}", what, took);
            took
        };
        let times = [
            timed("SFTP upload", &|| {
                upload(&dead, &source, &remote.path).is_err()
            }),
            timed("SFTP download", &|| download(&dead, &big, &kept).is_err()),
            timed("scp upload", &|| {
                let (ssh, _) = connect_for_copy(&dead).unwrap();
                upload_file_scp(&ssh, &source, &target).is_err()
            }),
            timed("scp download", &|| {
                let (ssh, _) = connect_for_copy(&dead).unwrap();
                download_file_scp(&ssh, &big, &kept).is_err()
            }),
        ];

        assert_eq!(read_remote(id, &target), b"old");
        assert_eq!(fs::read(&kept).unwrap(), b"old");
        assert_eq!(local_names(&local.0), ["kept.bin", "up.bin"]);
        for took in times {
            assert!(took < Duration::from_secs(45), "took {:?}", took);
        }
    });
}

/// A connection can store `~/app`, as the Files view accepts, and SFTP does not
/// expand it.
#[test]
#[ignore]
fn live_scp_tilde_means_the_login_folder_both_ways() {
    with_connection(|id| {
        let local = TempDir::new("scp-tilde");
        let name = format!("ssix-live-{}", uuid::Uuid::new_v4().simple());
        let home = sh(id, "pwd").trim_end().to_string();
        let in_home = format!("{}/{}", home, name);
        sh(id, &format!("mkdir {}", in_home));
        let source = local.0.join("f.txt");
        write_local(&source, b"tilde", 0o644);
        let tree = local.0.join("tree");
        fs::create_dir(&tree).unwrap();
        write_local(&tree.join("g.txt"), b"tree", 0o644);

        let up = upload(id, &source, &format!("~/{}", name));
        let folder = upload(id, &tree, &format!("~/{}/new/deep/", name));
        let back = local.0.join("back.txt");
        let down = download(id, &format!("~/{}/f.txt", name), &back);

        let up = up.unwrap();
        assert_eq!(up.remote_path, format!("{}/f.txt", in_home));
        assert_eq!(read_remote(id, &up.remote_path), b"tilde");
        let folder = folder.unwrap();
        assert_eq!(folder.remote_path, format!("{}/new/deep/tree", in_home));
        assert_eq!(
            read_remote(id, &format!("{}/g.txt", folder.remote_path)),
            b"tree"
        );
        assert_eq!(down.unwrap().remote_path, up.remote_path);
        assert_eq!(fs::read(&back).unwrap(), b"tilde");
        sh(id, &format!("rm -rf {}", in_home));
    });
}
