import "@testing-library/jest-dom";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

// Default mock for the Tauri window API. Spies are stashed on globalThis
// so tests can both reset their behaviour (mockResolvedValue, etc.) and
// assert that they were called from inside the component's dynamic
// `import("@tauri-apps/api/window")` chain. This avoids the Vitest quirk
// where file-scoped vi.mock factories produce a different spy instance
// from the one the dynamic import resolves to.
const __windowMocks = {
  isMaximized: vi.fn(async () => false),
  toggleMaximize: vi.fn(async () => {}),
  minimize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  onResized: vi.fn(async (_cb: (...args: unknown[]) => void) => () => {}),
};
(globalThis as unknown as { __windowMocks: typeof __windowMocks }).__windowMocks =
  __windowMocks;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => __windowMocks,
}));
