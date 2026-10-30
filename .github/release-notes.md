Unsigned builds for personal use.

**Windows:** download `ssix.exe` and run it. SmartScreen will warn about an unknown publisher.

**macOS (Apple Silicon):** open the `.dmg` and drag SSIX to Applications. The app is not notarized, so the first launch is blocked. Open **System Settings → Privacy & Security**, click **Open Anyway** next to the SSIX message, and confirm. Alternatively, run `xattr -dr com.apple.quarantine /Applications/ssix.app` once.

**Linux (x86_64):**

- Debian 12+ / Ubuntu 22.04+: `sudo apt install ./ssix_*_amd64.deb`
- Fedora: `sudo dnf install ./ssix-*.x86_64.rpm`
- RHEL 10 and rebuilds (Alma, Rocky): WebKitGTK 4.1 comes from EPEL. Run `sudo dnf install epel-release`, then `sudo dnf install ./ssix-*.x86_64.rpm`
- Other distributions: `chmod +x ssix_*_amd64.AppImage` and run it

RHEL 9 is not supported: it has no WebKitGTK 4.1, which the app needs.
