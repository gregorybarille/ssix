import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  fillVariables,
  NO_TERMINAL_MESSAGE,
  planPaste,
  preparePaste,
  SEVERAL_LINES_MESSAGE,
  snippetMatches,
  snippetVariables,
} from "@/lib/snippets";
import { tokenize } from "@/lib/search";
import {
  acceptsBracketedPaste,
  focusSession,
  registerTerminal,
  unregisterTerminal,
} from "@/lib/terminalRegistry";
import { useTerminalsStore } from "@/store/useTerminalsStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const BEGIN = "\x1b[200~";
const END = "\x1b[201~";

describe("snippetVariables", () => {
  it("finds no variable in a plain command", () => {
    expect(snippetVariables("uptime")).toEqual([]);
  });

  it("asks for a repeated variable once, in order of first appearance", () => {
    expect(snippetVariables("{{b}} {{a}} {{b}} {{a}} {{c}}")).toEqual(["b", "a", "c"]);
  });

  it("reads spaces inside the braces as the same variable", () => {
    expect(snippetVariables("{{ host }} {{host}} {{\thost\t}}")).toEqual(["host"]);
  });

  it("is case-sensitive", () => {
    expect(snippetVariables("{{Host}} {{host}}")).toEqual(["Host", "host"]);
  });

  it("accepts digits, dashes, underscores and non-ASCII letters", () => {
    expect(snippetVariables("{{a1}} {{log-file}} {{_x}} {{hôte}}")).toEqual([
      "a1",
      "log-file",
      "_x",
      "hôte",
    ]);
  });

  it.each([
    ["an unclosed {{", "echo {{name"],
    ["an unclosed {{ at the end", "echo {{"],
    ["a lone }}", "echo name}}"],
    ["one closing brace", "echo {{name}"],
    ["empty braces", "echo {{}}"],
    ["blank braces", "echo {{  }}"],
    ["spaced opening braces", "echo { {name}}"],
    ["a line break inside", "echo {{\nname\n}}"],
    ["a Go template field", "docker ps --format '{{.Names}}'"],
    ["a Go template call", "docker inspect -f '{{json .State}}' web"],
    ["a dotted name", "echo {{a.b}}"],
    ["a name with a space", "echo {{a b}}"],
    ["a name starting with a digit", "echo {{1a}}"],
    ["shell brace expansion", "echo {{a,b},c}"],
  ])("treats %s as literal text", (_label, command) => {
    expect(snippetVariables(command)).toEqual([]);
    expect(fillVariables(command, new Map())).toBe(command);
  });

  it("still finds a variable after an unclosed {{", () => {
    const command = "echo {{oops {{name}}";
    expect(snippetVariables(command)).toEqual(["name"]);
    expect(fillVariables(command, new Map([["name", "x"]]))).toBe("echo {{oops x");
  });

  it("reads triple braces as a variable inside literal braces", () => {
    const command = "{{{name}}}";
    expect(snippetVariables(command)).toEqual(["name"]);
    expect(fillVariables(command, new Map([["name", "x"]]))).toBe("{x}");
  });

  it("does not ask for an escaped variable", () => {
    expect(snippetVariables("\\{{end}} {{name}}")).toEqual(["name"]);
  });

  it("finds variables on every line", () => {
    expect(snippetVariables("a {{x}}\nb {{y}}")).toEqual(["x", "y"]);
  });

  it("gives the same answer when called again (no regex state carried over)", () => {
    expect(snippetVariables("{{a}}")).toEqual(["a"]);
    expect(snippetVariables("{{a}}")).toEqual(["a"]);
  });
});

describe("fillVariables", () => {
  it("replaces every occurrence, spaced or not", () => {
    expect(fillVariables("{{a}}-{{ a }}-{{b}}", new Map([["a", "1"], ["b", "2"]]))).toBe("1-1-2");
  });

  it("inserts a value literally, even one that looks like a replacement pattern", () => {
    expect(fillVariables("x{{a}}y", new Map([["a", "$& $1 $$"]]))).toBe("x$& $1 $$y");
  });

  it("does not expand a variable inside a value", () => {
    const values = new Map([["a", "{{b}}"], ["b", "no"]]);
    expect(fillVariables("{{a}}", values)).toBe("{{b}}");
  });

  it("leaves a variable with no value or an empty one as written", () => {
    expect(fillVariables("{{a}} {{b}}", new Map([["b", ""]]))).toBe("{{a}} {{b}}");
  });

  it("drops the backslash of an escaped variable", () => {
    const command = "go-template='{{range .items}}{{.name}}\\{{end}}' {{ns}}";
    expect(fillVariables(command, new Map([["ns", "x"]]))).toBe(
      "go-template='{{range .items}}{{.name}}{{end}}' x",
    );
  });

  it("does not confuse a name with something on Object.prototype", () => {
    expect(snippetVariables("{{constructor}} {{__proto__}}")).toEqual([
      "constructor",
      "__proto__",
    ]);
    expect(fillVariables("{{constructor}}", new Map())).toBe("{{constructor}}");
    expect(fillVariables("{{__proto__}}", new Map([["__proto__", "x"]]))).toBe("x");
  });
});

describe("preparePaste", () => {
  it("never appends a newline", () => {
    expect(preparePaste("uptime", false)).toBe("uptime");
    expect(preparePaste("uptime", true)).toBe(`${BEGIN}uptime${END}`);
  });

  it.each([
    ["LF", "uptime\n"],
    ["CRLF", "uptime\r\n"],
    ["CR", "uptime\r"],
    ["several", "uptime\n\n\n"],
    ["blank lines with spaces", "uptime\n  \n\t\n"],
    ["before and after", "\n\n  \nuptime\n\n"],
  ])("drops the line breaks around a command: %s", (_label, command) => {
    expect(preparePaste(command, false)).toBe("uptime");
  });

  it("keeps spaces at the end of the command, to go on typing after them", () => {
    expect(preparePaste("kubectl logs ", false)).toBe("kubectl logs ");
    expect(preparePaste("kubectl logs \n", false)).toBe("kubectl logs ");
  });

  it("keeps leading spaces, which keep a command out of the shell's history", () => {
    expect(preparePaste(" secret-thing", false)).toBe(" secret-thing");
  });

  it.each([
    ["LF", "a\nb"],
    ["CRLF", "a\r\nb"],
    ["CR", "a\rb"],
    ["a blank line between", "a\n\nb"],
  ])("refuses several lines without bracketed paste: %s", (_label, command) => {
    expect(preparePaste(command, false)).toBeNull();
  });

  it("sends several lines between the markers, with CR as a terminal paste does", () => {
    expect(preparePaste("a\nb", true)).toBe(`${BEGIN}a\rb${END}`);
    expect(preparePaste("a\r\nb", true)).toBe(`${BEGIN}a\rb${END}`);
    expect(preparePaste("a\rb", true)).toBe(`${BEGIN}a\rb${END}`);
  });

  it("keeps blank lines inside and drops the ones around, between the markers too", () => {
    expect(preparePaste("\na\n\nb\n", true)).toBe(`${BEGIN}a\r\rb${END}`);
  });

  it("keeps a snippet from closing the bracketed paste early", () => {
    const text = preparePaste(`a${END}\nrm -rf /\n`, true);
    expect(text).toBe(`${BEGIN}a[201~\rrm -rf /${END}`);
    // One opening and one closing marker, the ones this function added.
    expect(text?.split("\x1b")).toHaveLength(3);
  });

  it("strips control characters that would act on the shell", () => {
    expect(preparePaste("a\x03b\x04c\x1bd\x7fe\x9bf", false)).toBe("abcdef");
    expect(preparePaste("a\x00b", false)).toBe("ab");
  });

  it("does not hide a line break behind a stripped control character", () => {
    expect(preparePaste("a\x0b\nb", false)).toBeNull();
  });

  it("keeps tabs and non-ASCII text", () => {
    expect(preparePaste("a\tb é 日本", false)).toBe("a\tb é 日本");
  });
});

describe("planPaste and the registry", () => {
  const sessions = ["s1", "s2"];

  function live(sessionId: string, bracketedPasteMode = false) {
    const textarea = document.createElement("textarea");
    const focus = vi.fn();
    registerTerminal(sessionId, {
      textarea,
      focus,
      modes: { bracketedPasteMode },
    } as unknown as XTerm);
    return { focus };
  }

  function activate(...sessionIds: string[]) {
    useTerminalsStore.setState({
      tabs: [
        {
          id: "t1",
          mode: "single",
          panes: sessionIds.map((sessionId) => ({ sessionId, connectionName: sessionId })),
        },
      ],
      activeTabId: "t1",
    });
  }

  afterEach(() => {
    sessions.forEach(unregisterTerminal);
    useTerminalsStore.setState({ tabs: [], activeTabId: null });
  });

  it("explains that there is no terminal", () => {
    expect(planPaste("uptime")).toEqual({ error: NO_TERMINAL_MESSAGE });
  });

  it("explains a tab whose panes all failed", () => {
    activate("failed");
    expect(planPaste("uptime")).toEqual({ error: NO_TERMINAL_MESSAGE });
  });

  it("targets the active pane", () => {
    live("s1");
    activate("s1");
    expect(planPaste("uptime\n")).toEqual({ sessionId: "s1", text: "uptime" });
  });

  it("follows what the program in that pane asked for", () => {
    live("s1", true);
    activate("s1");
    expect(acceptsBracketedPaste("s1")).toBe(true);
    expect(planPaste("a\nb")).toEqual({ sessionId: "s1", text: `${BEGIN}a\rb${END}` });
  });

  it("explains why several lines are refused", () => {
    live("s1");
    activate("s1");
    expect(acceptsBracketedPaste("s1")).toBe(false);
    expect(planPaste("a\nb")).toEqual({ error: SEVERAL_LINES_MESSAGE });
  });

  it("knows nothing about a session with no terminal", () => {
    expect(acceptsBracketedPaste("unknown")).toBe(false);
    expect(() => focusSession("unknown")).not.toThrow();
  });

  it("gives a session's terminal the keyboard", () => {
    const { focus } = live("s1");
    focusSession("s1");
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe("snippetMatches", () => {
  const snippet = { id: "1", name: "Tail logs", command: "tail -f /var/log/app", tags: ["Ops"] };
  const matches = (query: string) => snippetMatches(snippet, tokenize(query));

  it("matches everything on an empty query", () => {
    expect(matches("")).toBe(true);
  });

  it("searches name, command and tags, ignoring case", () => {
    expect(matches("tail")).toBe(true);
    expect(matches("VAR/LOG")).toBe(true);
    expect(matches("ops")).toBe(true);
  });

  it("requires every term", () => {
    expect(matches("tail ops")).toBe(true);
    expect(matches("tail prod")).toBe(false);
  });

  it("copes with a snippet with no tags", () => {
    expect(snippetMatches({ id: "2", name: "a", command: "b" }, ["a"])).toBe(true);
  });
});
