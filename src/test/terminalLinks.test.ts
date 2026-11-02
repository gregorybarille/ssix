import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ILinkHandler, Terminal as XTerm } from "@xterm/xterm";
import { activateTerminalLink, terminalLinks } from "@/components/terminal/terminalLinks";
import type { TerminalExtensionContext } from "@/components/terminal/extensions";
import { useTerminalLinksStore } from "@/store/useTerminalLinksStore";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => {}),
  warn: vi.fn(),
  error: vi.fn(),
  webLinks: null as null | {
    handler: (event: MouseEvent, url: string) => void;
    options: {
      hover: (event: MouseEvent, url: string) => void;
      leave: () => void;
    };
  },
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@/lib/log", () => ({ log: { warn: mocks.warn, error: mocks.error } }));
vi.mock("@/lib/platform", () => ({ detectPlatform: () => "linux" }));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(
      handler: NonNullable<typeof mocks.webLinks>["handler"],
      options: NonNullable<typeof mocks.webLinks>["options"],
    ) {
      mocks.webLinks = { handler, options };
    }
  },
}));

const plainClick = () => new MouseEvent("click");
const modClick = () => new MouseEvent("click", { ctrlKey: true });
const store = () => useTerminalLinksStore.getState();

/** Let a call into the lazily imported shell plugin land. */
async function opened() {
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
  return mocks.open.mock.calls;
}

beforeEach(() => {
  mocks.open.mockClear();
  mocks.warn.mockClear();
  mocks.error.mockClear();
  useTerminalLinksStore.setState({ hover: null, confirming: null });
});

describe("activateTerminalLink", () => {
  it("does nothing on a click without the modifier", async () => {
    activateTerminalLink(plainClick(), "https://example.com/", false);
    activateTerminalLink(plainClick(), "https://example.com/", true);
    await new Promise((resolve) => setTimeout(resolve));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(store().confirming).toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("opens a URL read from the terminal's text directly", async () => {
    activateTerminalLink(modClick(), "https://example.com/", false);
    expect(await opened()).toEqual([["https://example.com/"]]);
    expect(store().confirming).toBeNull();
  });

  it("asks first for an OSC 8 hyperlink, whose text can name another site", () => {
    activateTerminalLink(modClick(), "https://evil.example/", true);
    expect(store().confirming?.href).toBe("https://evil.example/");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("asks first for a URL with a user name, which reads like another host", () => {
    activateTerminalLink(modClick(), "https://bank.example@evil.example/", false);
    expect(store().confirming?.hostname).toBe("evil.example");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("asks first for a URL with a password as well", () => {
    activateTerminalLink(modClick(), "https://:secret@evil.example/", false);
    expect(store().confirming?.hostname).toBe("evil.example");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    ["file:///etc/passwd", false],
    ["javascript:alert(1)", true],
    ["x-custom-app://do-something", true],
    ["https://example.com/\tpath", false],
  ])("refuses %j and logs it, with nothing to confirm", (raw, viaHyperlink) => {
    activateTerminalLink(modClick(), raw, viaHyperlink);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(store().confirming).toBeNull();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it("logs a browser that would not open", async () => {
    mocks.open.mockRejectedValueOnce(new Error("no browser"));
    activateTerminalLink(modClick(), "https://example.com/", false);
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(mocks.error.mock.calls[0][1]).toContain("no browser");
  });
});

describe("the terminal-links extension", () => {
  function create() {
    const term = {
      options: {} as { linkHandler?: ILinkHandler | null; allowNonHttpProtocols?: boolean },
      loadAddon: vi.fn(),
    };
    const ctx = { term: term as unknown as XTerm, sessionId: "s1" } as TerminalExtensionContext;
    const cleanup = terminalLinks.onCreate?.(ctx);
    const osc8 = term.options.linkHandler;
    if (!osc8) throw new Error("no linkHandler");
    return { term, osc8, cleanup };
  }
  const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };

  it("loads the web links addon and leaves xterm's non-http OSC 8 links off", () => {
    const { term } = create();
    expect(term.loadAddon).toHaveBeenCalledOnce();
    expect(term.options.allowNonHttpProtocols).toBeUndefined();
  });

  it("opens a found URL without asking, and an OSC 8 one only after asking", async () => {
    const { osc8 } = create();
    osc8.activate(modClick(), "https://spoof.example/", range);
    expect(store().confirming?.href).toBe("https://spoof.example/");
    expect(mocks.open).not.toHaveBeenCalled();

    useTerminalLinksStore.setState({ confirming: null });
    mocks.webLinks?.handler(modClick(), "https://example.com/");
    expect(store().confirming).toBeNull();
    expect(await opened()).toEqual([["https://example.com/"]]);
  });

  it("shows the real target while the mouse is over an OSC 8 link, then clears it", () => {
    const { osc8 } = create();
    osc8.hover?.(new MouseEvent("mouseover"), "https://evil.example/", range);
    expect(store().hover).toEqual({ sessionId: "s1", url: "https://evil.example/" });
    osc8.leave?.(new MouseEvent("mouseout"), "https://evil.example/", range);
    expect(store().hover).toBeNull();
  });

  it("shows the target of a found URL too", () => {
    create();
    mocks.webLinks?.options.hover(new MouseEvent("mouseover"), "https://example.com/");
    expect(store().hover?.url).toBe("https://example.com/");
    mocks.webLinks?.options.leave();
    expect(store().hover).toBeNull();
  });

  it("offers no hint for a link it would refuse", () => {
    const { osc8 } = create();
    osc8.hover?.(new MouseEvent("mouseover"), "file:///etc/passwd", range);
    expect(store().hover).toBeNull();
  });

  it("does not take another pane's hint away when it goes", () => {
    const { cleanup } = create();
    store().setHover({ sessionId: "other", url: "https://example.com/" });
    if (cleanup) cleanup();
    expect(store().hover?.sessionId).toBe("other");
  });

  it("clears its own hint when the terminal goes", () => {
    const { osc8, cleanup } = create();
    osc8.hover?.(new MouseEvent("mouseover"), "https://example.com/", range);
    if (cleanup) cleanup();
    expect(store().hover).toBeNull();
  });
});
