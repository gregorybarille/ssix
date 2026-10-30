/**
 * Regenerate every icon in src-tauri/icons from the SVGs in
 * src-tauri/icons/source (run with `npm run icons`):
 *
 * - ssix.svg is the icon, full bleed: Windows, Linux, Android and iOS.
 * - ssix-small.svg replaces it at 16-32 px (icon.ico's small sizes and
 *   32x32.png), where the sketched wings blur.
 * - macOS gets ssix.svg on Apple's grid (an 824 px body centred in the
 *   1024 px canvas), so it is the size of every other Dock icon.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const icons = "src-tauri/icons";
const main = join(icons, "source", "ssix.svg");
const small = join(icons, "source", "ssix-small.svg");
const tmp = mkdtempSync(join(tmpdir(), "ssix-icons-"));
const tauriCli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");

function tauriIcon(input, ...args) {
  execFileSync(process.execPath, [tauriCli, "icon", input, ...args], { stdio: "inherit" });
}

/** Render `input` at each size into a fresh directory; map size to PNG bytes. */
function render(input, sizes) {
  const out = mkdtempSync(join(tmp, "png-"));
  tauriIcon(input, "-o", out, "--png", sizes.join(","));
  return new Map(sizes.map((s) => [s, readFileSync(join(out, `${s}x${s}.png`))]));
}

/** An .ico whose entries are PNGs, smallest first. */
function writeIco(path, pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.size);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.size, 4);
  let offset = header.length;
  [...pngs].forEach(([size, data], i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  writeFileSync(path, Buffer.concat([header, ...pngs.values()]));
}

try {
  tauriIcon(main);

  const smallPngs = render(small, [16, 24, 32]);
  writeIco(join(icons, "icon.ico"), new Map([...smallPngs, ...render(main, [48, 64, 256])]));
  writeFileSync(join(icons, "32x32.png"), smallPngs.get(32));

  const svg = readFileSync(main, "utf8");
  const body = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
  const mac = join(tmp, "macos.svg");
  writeFileSync(
    mac,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">` +
      `<g transform="translate(100 100) scale(${824 / 1024})">${body}</g></svg>`,
  );
  const macOut = mkdtempSync(join(tmp, "macos-"));
  tauriIcon(mac, "-o", macOut);
  copyFileSync(join(macOut, "icon.icns"), join(icons, "icon.icns"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
