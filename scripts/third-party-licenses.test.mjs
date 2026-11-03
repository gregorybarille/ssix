import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { npmPackages, renderList, rustPackages } from "./third-party-licenses.mjs";

const pkg = (id, name, license, extra = {}) => ({ id, name, version: "1.0.0", license, ...extra });
const dep = (id, ...kinds) => ({ pkg: id, dep_kinds: kinds.map((kind) => ({ kind })) });

describe("third-party licence list", () => {
  it("leaves dev packages and the root of the lock file out of the npm side", () => {
    const found = npmPackages({
      packages: {
        "": { name: "ssix", license: "MIT" },
        "node_modules/react": { version: "19.0.0", license: "MIT" },
        "node_modules/@scope/nested/node_modules/inner": { version: "2.0.0" },
        "node_modules/vitest": { version: "4.0.0", license: "MIT", dev: true },
        "node_modules/maybe": { version: "1.0.0", license: "MIT", devOptional: true },
      },
    });
    expect(found).toEqual([
      { name: "react", version: "19.0.0", license: "MIT", source: "npm" },
      { name: "inner", version: "2.0.0", license: "Not stated", source: "npm" },
    ]);
  });

  it("follows only normal dependencies on the Rust side, and leaves the root out", () => {
    const found = rustPackages({
      packages: [
        pkg("root", "ssix", "MIT"),
        pkg("shipped", "shipped", "MIT"),
        pkg("deep", "deep", null, { license_file: "LICENSE.txt" }),
        pkg("mixed", "mixed", "Apache-2.0"),
        pkg("build", "build-tool", "MIT"),
        pkg("test", "test-tool", "MIT"),
        pkg("under-build", "under-build", "MIT"),
      ],
      resolve: {
        root: "root",
        nodes: [
          {
            id: "root",
            deps: [
              dep("shipped", null),
              dep("mixed", "dev", null),
              dep("build", "build"),
              dep("test", "dev"),
            ],
          },
          { id: "shipped", deps: [dep("deep", null), dep("root", null)] },
          { id: "deep", deps: [] },
          { id: "mixed", deps: [] },
          { id: "build", deps: [dep("under-build", null)] },
          { id: "test", deps: [] },
          { id: "under-build", deps: [] },
        ],
      },
    });
    expect(found.map((entry) => entry.name).sort()).toEqual(["deep", "mixed", "shipped"]);
    expect(found.find((entry) => entry.name === "deep")?.license).toBe("See LICENSE.txt");
  });

  it("writes the list sorted, without repeats, one package per line", () => {
    const b = { name: "b", version: "1.0.0", license: "MIT", source: "npm" };
    const a = { name: "A", version: "1.0.0", license: "MIT", source: "rust" };
    expect(renderList([b, a, b])).toBe(`[\n  ${JSON.stringify(a)},\n  ${JSON.stringify(b)}\n]\n`);
  });

  // Catches a dependency added without regenerating. The exact comparison needs
  // cargo, so CI runs it as `third-party-licenses.mjs --check` in the Rust job.
  it("lists every direct dependency of the checked-in manifests", () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
    const list = JSON.parse(read("../src/lib/thirdPartyLicenses.json"));
    const names = new Set(list.map((entry) => entry.name));
    const npm = Object.keys(JSON.parse(read("../package.json")).dependencies);
    expect(npm.filter((name) => !names.has(name))).toEqual([]);

    const manifest = read("../src-tauri/Cargo.toml");
    const sections = manifest.split(/^(?=\[)/m).filter((part) => /^\[(.*\.)?dependencies\]/.test(part));
    const rust = sections.flatMap((part) =>
      [...part.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((match) => match[1]),
    );
    expect(rust.length).toBeGreaterThan(5);
    expect(rust.filter((name) => !names.has(name))).toEqual([]);
  });
});
