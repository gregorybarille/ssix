import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { packageVersion, withCargoVersion } from "./release-version.mjs";

describe("release version", () => {
  it("takes the number from the tag", () => {
    expect(packageVersion("v1.0.1")).toBe("1.0.1");
  });

  it("refuses what is not a release tag, rather than building a wrong version", () => {
    for (const tag of [undefined, "", "1.0.0", "v1.0", "main", "v1.0.0-", "v1.0.0-beta.19"]) {
      expect(() => packageVersion(tag)).toThrow("is not a release tag");
    }
  });

  it("changes only the package's own version in the real manifest", () => {
    const manifest = readFileSync("src-tauri/Cargo.toml", "utf8");
    // Git checks the manifest out with CRLF on Windows.
    const before = manifest.split(/\r?\n/);
    const after = withCargoVersion(manifest, "9.8.7").split(/\r?\n/);
    const changed = after.filter((line, i) => line !== before[i]);
    expect(changed).toEqual(['version = "9.8.7"']);
    expect(after.slice(0, 5)).toContain('version = "9.8.7"');
  });
});
