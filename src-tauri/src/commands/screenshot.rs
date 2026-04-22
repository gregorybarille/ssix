use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};

#[tauri::command]
pub fn take_screenshot(image_data: String) -> Result<String, String> {
    // Strip the data-URL prefix if the caller included it.
    let b64 = image_data
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&image_data);

    let bytes = STANDARD
        .decode(b64)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let desktop = dirs_next::desktop_dir()
        .ok_or_else(|| "Could not locate Desktop directory".to_string())?;

    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let millis = duration.subsec_millis();

    // Format as YYYYMMDD-HHMMSS using integer arithmetic (no chrono dep needed).
    let ts = format_timestamp(secs);
    let filename = format!("ssx-screenshot-{}-{:03}.png", ts, millis);
    let path = desktop.join(&filename);

    std::fs::write(&path, &bytes)
        .map_err(|e| format!("Failed to write screenshot: {}", e))?;

    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Screenshot path contains invalid UTF-8".to_string())
}

/// Convert a Unix timestamp (seconds) into a `YYYYMMDD-HHMMSS` string without
/// pulling in `chrono`.
fn format_timestamp(secs: u64) -> String {
    // Days since Unix epoch → Gregorian date via Julian Day Number algorithm.
    let days = secs / 86400;
    let time = secs % 86400;
    let h = time / 3600;
    let m = (time % 3600) / 60;
    let s = time % 60;

    // Richards' algorithm for Gregorian calendar.
    let jdn = days + 2440588; // Unix epoch is JDN 2440588
    let f = jdn + 1401 + (((4 * jdn + 274277) / 146097) * 3) / 4 - 38;
    let e = 4 * f + 3;
    let g = (e % 1461) / 4;
    let h2 = 5 * g + 2;
    let day = (h2 % 153) / 5 + 1;
    let month = (h2 / 153 + 2) % 12 + 1;
    let year = e / 1461 - 4716 + (14 - month) / 12;

    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        year, month, day, h, m, s
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::fs;

    #[test]
    fn test_decode_base64_and_write_png_bytes() {
        let tmp = std::env::temp_dir().join("ssx_screenshot_test");
        fs::create_dir_all(&tmp).unwrap();

        // Minimal 1×1 white PNG (hardcoded bytes).
        let png_bytes: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
            0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        let b64 = STANDARD.encode(png_bytes);

        let path_str = tmp.join("test.png");

        // Override dirs_next is not straightforward, so test the decode + write
        // logic directly using a temp file rather than invoking the command.
        let decoded = STANDARD.decode(&b64).unwrap();
        fs::write(&path_str, &decoded).unwrap();
        let on_disk = fs::read(&path_str).unwrap();
        assert_eq!(on_disk, png_bytes);
        fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn test_format_timestamp_unix_epoch() {
        // Unix epoch (1970-01-01T00:00:00) → "19700101-000000"
        assert_eq!(format_timestamp(0), "19700101-000000");
    }

    #[test]
    fn test_format_timestamp_known_date() {
        // 2024-04-22 09:00:00 UTC = 1713776400 seconds
        assert_eq!(format_timestamp(1713776400), "20240422-090000");
    }
}
