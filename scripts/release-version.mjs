/**
 * Give a release build the version of its tag, so that installers see each
 * release as newer than the last. The release workflow runs this on a fresh
 * checkout; the files stay at their plain number in the repository.
 *
 *   RELEASE_TAG=v1.0.0-beta.19 node scripts/release-version.mjs
 *
 * A beta becomes `1.0.0+beta.19`: rpm refuses the `-` in `1.0.0-beta.19`, and
 * both rpm and dpkg sort this form above an installed `1.0.0`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TAURI_CONFIG = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const CARGO_MANIFEST = new URL("../src-tauri/Cargo.toml", import.meta.url);

export function packageVersion(tag) {
  const match = /^v(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.]+))?$/.exec(tag ?? "");
  if (!match) throw new Error(`"${tag}" is not a release tag like v1.0.0-beta.19`);
  return match[2] ? `${match[1]}+${match[2]}` : match[1];
}

/** Replace the package's own version, the first one in the manifest. */
export function withCargoVersion(manifest, version) {
  return manifest.replace(/^version = ".*"$/m, `version = "${version}"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = packageVersion(process.env.RELEASE_TAG);
  const config = JSON.parse(readFileSync(TAURI_CONFIG, "utf8"));
  config.version = version;
  writeFileSync(TAURI_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(CARGO_MANIFEST, withCargoVersion(readFileSync(CARGO_MANIFEST, "utf8"), version));
  console.log(`Building version ${version}`);
}
