import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { PanelSlot, PanelSlotProvider } from "@/components/ui/panel-slot";

/** Render `ui` inside the app's panel column, as `App` does. */
export function renderInPanel(ui: ReactElement) {
  const result = render(
    <PanelSlotProvider>
      <main data-testid="view">{ui}</main>
      <PanelSlot />
    </PanelSlotProvider>,
  );
  return { ...result, slot: () => result.getByTestId("app-panel-slot") };
}
