/**
 * What the page saw of focus, keys and dialogs, for a test whose failure a
 * screenshot cannot explain. Start it before the steps in question and read it
 * back when they fail, so the failure says where a key press went.
 */
interface TracedWindow {
  __ssixFocusTrace?: { events: string[]; start: number };
}

export async function startFocusTrace(): Promise<void> {
  await browser.execute(() => {
    const page = window as unknown as TracedWindow;
    if (page.__ssixFocusTrace) {
      page.__ssixFocusTrace.events.length = 0;
      page.__ssixFocusTrace.start = performance.now();
      return;
    }
    const trace = { events: [] as string[], start: performance.now() };
    page.__ssixFocusTrace = trace;
    const describe = (target: EventTarget | null): string => {
      if (!(target instanceof HTMLElement)) return target === null ? "nothing" : "not an element";
      const id = target.dataset.testid ? `#${target.dataset.testid}` : "";
      const role = target.getAttribute("role");
      return `${target.tagName}${id}${role ? `[${role}]` : ""}`;
    };
    const note = (what: string) =>
      trace.events.push(`${Math.round(performance.now() - trace.start)} ms ${what}`);
    for (const type of ["focusin", "focusout"]) {
      document.addEventListener(
        type,
        (event) =>
          note(
            `${type} ${describe(event.target)}, other side ${describe((event as FocusEvent).relatedTarget)}`,
          ),
        true,
      );
    }
    document.addEventListener(
      "keydown",
      (event) => note(`keydown ${event.key} on ${describe(event.target)}`),
      true,
    );
    document.addEventListener("pointerdown", (event) => note(`pointerdown ${describe(event.target)}`), true);
    new MutationObserver((records) => {
      for (const record of records) {
        const element = record.target as Element;
        const name = element.getAttribute("data-slot") ?? element.getAttribute("role");
        if (name) {
          const kind = element.getAttribute("data-kind");
          note(`${name}${kind ? ` (${kind})` : ""} is ${element.getAttribute("data-state")}`);
        }
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
  });
}

export async function readFocusTrace(): Promise<string> {
  return browser.execute(() => {
    const trace = (window as unknown as TracedWindow).__ssixFocusTrace;
    const active = document.activeElement;
    const now = `focus is now on ${active?.tagName ?? "nothing"} ${active?.getAttribute("data-testid") ?? ""}`;
    return [...(trace?.events ?? ["no trace was started"]), now].join("\n");
  });
}
