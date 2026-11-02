import { vi } from "vitest";

/** The callbacks `<TerminalTabs>` requires, for a test that looks at none of them. */
export const terminalTabsCallbacks = () => ({
  onSelectTab: vi.fn(),
  onCloseTab: vi.fn(),
  onClosePane: vi.fn(),
  onNewTab: vi.fn(),
  onRetry: vi.fn(),
  onEdit: vi.fn(),
});
