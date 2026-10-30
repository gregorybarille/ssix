import { describe, it, expect } from "vitest";
import { parseHostKeyMismatch } from "@/lib/hostKey";

describe("parseHostKeyMismatch", () => {
  const raw =
    "HOST_KEY_MISMATCH host=example.com port=2222 fingerprint=SHA256:abc/def+ghi\n" +
    "The host key for example.com:2222 has changed. If you expect this change, trust the new key.";

  it("extracts host, port, fingerprint and the explanation", () => {
    const m = parseHostKeyMismatch(raw);
    expect(m).toEqual({
      host: "example.com",
      port: 2222,
      fingerprint: "SHA256:abc/def+ghi",
      message:
        "The host key for example.com:2222 has changed. If you expect this change, trust the new key.",
    });
  });

  it("finds the marker when wrapped by an outer error (gateway / jump-shell)", () => {
    const m = parseHostKeyMismatch(`Destination connect via gateway failed: Gateway gw:22: ${raw}`);
    expect(m?.host).toBe("example.com");
    expect(m?.port).toBe(2222);
  });

  it("returns null for ordinary errors and empty input", () => {
    expect(parseHostKeyMismatch("Password auth failed: denied")).toBeNull();
    expect(parseHostKeyMismatch("")).toBeNull();
    expect(parseHostKeyMismatch(undefined)).toBeNull();
  });

  it("rejects an out-of-range port rather than offering to trust it", () => {
    expect(
      parseHostKeyMismatch("HOST_KEY_MISMATCH host=h port=70000 fingerprint=x\nmsg"),
    ).toBeNull();
  });

  it("falls back to a default message when the explanation is missing", () => {
    const m = parseHostKeyMismatch("HOST_KEY_MISMATCH host=h port=22 fingerprint=x");
    expect(m?.message).toBe("The host key for h:22 has changed.");
  });
});
