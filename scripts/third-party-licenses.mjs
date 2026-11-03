#!/usr/bin/env node
/**
 * Writes `src/lib/thirdPartyLicenses.json`, the list the About section shows:
 * what ships inside SSIX, and the licence each part declares.
 *
 *   node scripts/third-party-licenses.mjs          rewrite the list
 *   node scripts/third-party-licenses.mjs --check  fail if it is out of date
 *
 * Only what ships counts: dev packages and Rust dev or build dependencies are
 * left out. Rust crates for every platform are in, since the list is the same
 * in every build.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "src/lib/thirdPartyLicenses.json");

/** C libraries the Rust crates build in, which no lock file gives a licence for. */
const NATIVE = [
  { name: "libssh2", license: "BSD-3-Clause" },
  { name: "OpenSSL", license: "Apache-2.0" },
  { name: "zlib", license: "Zlib" },
];

const NO_LICENSE = "Not stated";

/** Production packages in a parsed `package-lock.json`. */
export function npmPackages(lock) {
  const found = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes("node_modules/") || entry.dev || entry.devOptional) continue;
    found.push({
      name: entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
      version: entry.version,
      license: entry.license ?? NO_LICENSE,
      source: "npm",
    });
  }
  return found;
}

/**
 * Crates reached from the root crate of parsed `cargo metadata` through normal
 * dependencies only. The root itself is not third party.
 */
export function rustPackages(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const root = metadata.resolve.root;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const dep of nodes.get(queue.pop())?.deps ?? []) {
      const normal = dep.dep_kinds.some((kind) => kind.kind === null);
      if (!normal || seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  seen.delete(root);
  return [...seen].map((id) => {
    const pkg = packages.get(id);
    return {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? (pkg.license_file ? `See ${pkg.license_file}` : NO_LICENSE),
      source: "rust",
    };
  });
}

/** The file's text: sorted, no repeats, one package per line so diffs stay readable. */
export function renderList(packages) {
  const key = (pkg) => `${pkg.name.toLowerCase()}\0${pkg.version ?? ""}\0${pkg.source}`;
  const unique = new Map(packages.map((pkg) => [key(pkg), pkg]));
  const sorted = [...unique.keys()].sort().map((k) => unique.get(k));
  return `[\n${sorted.map((pkg) => `  ${JSON.stringify(pkg)}`).join(",\n")}\n]\n`;
}

function currentList() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--locked", "--manifest-path", "src-tauri/Cargo.toml"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  return renderList([
    ...npmPackages(lock),
    ...rustPackages(metadata),
    ...NATIVE.map((pkg) => ({ ...pkg, source: "native" })),
  ]);
}

function main() {
  const list = currentList();
  if (process.argv.includes("--check")) {
    if (readFileSync(OUTPUT, "utf8") !== list) {
      console.error("src/lib/thirdPartyLicenses.json is out of date. Run: npm run licenses");
      process.exit(1);
    }
    return;
  }
  writeFileSync(OUTPUT, list);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
