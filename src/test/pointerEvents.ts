import { afterEach, beforeEach, vi } from "vitest";

/**
 * jsdom's PointerEvent drops the coordinates `fireEvent` sets, which a drag
 * needs, so give them back for the tests of the enclosing `describe`.
 */
export function withPointerCoordinates(): void {
  beforeEach(() => {
    class TestPointerEvent extends MouseEvent {}
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      writable: true,
      value: TestPointerEvent,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
