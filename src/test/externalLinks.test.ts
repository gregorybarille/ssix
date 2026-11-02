import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLinkOpenClick,
  linkModifierLabel,
  openExternalUrl,
  parseExternalUrl,
} from "@/lib/externalLinks";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => {}),
  platform: "linux",
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@/lib/platform", () => ({ detectPlatform: () => mocks.platform }));

const REFUSED = [
  "file:///etc/passwd",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "mailto:someone@example.com",
  "tel:+33100000000",
  "ssh://example.com",
  "ftp://example.com/file",
  "smb://example.com/share",
  "x-custom-app://do-something",
  "//example.com/no-scheme",
  "example.com",
  "",
  "not a url",
];

/** The URL parser drops tabs and line breaks, so these would parse as another address. */
const DISGUISED = [
  "https://example.com/\tpath",
  "https://exam\nple.com/",
  "https://example.com/\r",
  "https://example.com/ path",
  " https://example.com/",
  "ht\ntps://example.com/",
  "https://example.com/\u0000",
  "https://example.com/\u007f",
  "https://example.com/\u009b",
];

describe("parseExternalUrl", () => {
  it("accepts http and https", () => {
    expect(parseExternalUrl("http://example.com/a?b=c#d")?.href).toBe("http://example.com/a?b=c#d");
    expect(parseExternalUrl("https://example.com/")?.href).toBe("https://example.com/");
    expect(parseExternalUrl("HTTPS://EXAMPLE.COM/")?.href).toBe("https://example.com/");
    expect(parseExternalUrl("https://[2001:db8::1]:8443/")?.hostname).toBe("[2001:db8::1]");
  });

  it.each(REFUSED)("refuses %j", (raw) => {
    expect(parseExternalUrl(raw)).toBeNull();
  });

  it.each(DISGUISED)("refuses %j, whitespace or a control character included", (raw) => {
    expect(parseExternalUrl(raw)).toBeNull();
  });
});

describe("openExternalUrl", () => {
  beforeEach(() => mocks.open.mockClear());

  it("hands an http or https URL to the shell plugin", async () => {
    await openExternalUrl("https://example.com/path");
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.com/path");
  });

  it.each([...REFUSED, ...DISGUISED])("never reaches the shell plugin with %j", async (raw) => {
    await expect(openExternalUrl(raw)).rejects.toThrow("Only http and https");
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe("isLinkOpenClick", () => {
  const click = (init: MouseEventInit) => new MouseEvent("click", init);

  it("takes Ctrl outside macOS", () => {
    mocks.platform = "linux";
    expect(isLinkOpenClick(click({ ctrlKey: true }))).toBe(true);
    expect(isLinkOpenClick(click({ metaKey: true }))).toBe(false);
    expect(isLinkOpenClick(click({}))).toBe(false);
    expect(linkModifierLabel()).toBe("Ctrl");
  });

  it("takes Cmd on macOS, where Ctrl+click is a right-click", () => {
    mocks.platform = "macos";
    expect(isLinkOpenClick(click({ metaKey: true }))).toBe(true);
    expect(isLinkOpenClick(click({ ctrlKey: true }))).toBe(false);
    expect(isLinkOpenClick(click({}))).toBe(false);
    expect(linkModifierLabel()).toBe("Cmd");
  });
});

/**
 * The plugin's own check behind the one above. The plugin wraps this in
 * `^...$`, and its default also lets `mailto:` and `tel:` through.
 */
describe("the shell plugin's open scope", () => {
  const config = JSON.parse(
    readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
  ) as { plugins: { shell: { open: string } } };
  const scope = new RegExp(`^${config.plugins.shell.open}$`);

  it("lets http and https through, IPv6 hosts too", () => {
    expect(scope.test("http://example.com/")).toBe(true);
    expect(scope.test("https://example.com/a?b=c")).toBe(true);
    expect(scope.test("https://[2001:db8::1]:8443/")).toBe(true);
  });

  it.each(REFUSED)("refuses %j", (raw) => {
    expect(scope.test(raw)).toBe(false);
  });
});
