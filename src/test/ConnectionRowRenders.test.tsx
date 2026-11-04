import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ConnectionList } from "@/components/ConnectionList";
import type { Connection, Credential } from "@/types";

// Each row draws exactly one chevron, so this counts row renders.
const rowRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("lucide-react", async (importOriginal) => {
  const icons = await importOriginal<typeof import("lucide-react")>();
  const Chevron = icons.ChevronRight;
  return {
    ...icons,
    ChevronRight: (props: React.ComponentProps<typeof Chevron>) => {
      rowRenders.count += 1;
      return <Chevron {...props} />;
    },
  };
});

const connections = Array.from({ length: 50 }, (_, i) => ({
  id: `c${i}`,
  name: `host-${i}`,
  host: "h",
  port: 22,
  type: "direct",
  verbosity: 0,
})) as unknown as Connection[];

const NO_CREDENTIALS: Credential[] = [];

/** A parent passing new handlers on each render, as the app's views do. */
function Parent({ onConnect }: { onConnect: (c: Connection) => void }) {
  const [, setTick] = useState(0);
  return (
    <>
      <button onClick={() => setTick((n) => n + 1)}>rerender parent</button>
      <ConnectionList
        connections={connections}
        credentials={NO_CREDENTIALS}
        onEdit={() => {}}
        onDelete={() => {}}
        onClone={() => {}}
        onConnect={(c) => onConnect(c)}
      />
    </>
  );
}

const row = (i: number) => screen.getByTestId(`connection-row-c${i}`);

describe("connection rows re-render only when they change", () => {
  const onConnect = vi.fn();

  beforeEach(() => {
    onConnect.mockReset();
    render(<Parent onConnect={onConnect} />);
    expect(rowRenders.count).toBeGreaterThanOrEqual(50);
    rowRenders.count = 0;
  });

  it("a right click draws no row again", () => {
    fireEvent.contextMenu(row(10), { clientX: 5, clientY: 5 });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(rowRenders.count).toBe(0);
  });

  it("a focus move draws only the two rows whose tab stop changes", async () => {
    row(0).focus();
    fireEvent.keyDown(row(0), { key: "ArrowDown" });
    await act(async () => {});
    expect(document.activeElement).toBe(row(1));
    expect(rowRenders.count).toBeLessThanOrEqual(2);
    expect(row(1).tabIndex).toBe(0);
    expect(row(0).tabIndex).toBe(-1);
  });

  it("a parent's new handlers draw no row, and the row runs the newest one", () => {
    fireEvent.click(screen.getByText("rerender parent"));
    expect(rowRenders.count).toBe(0);
    fireEvent.click(row(3));
    expect(onConnect).toHaveBeenCalledWith(connections[3]);
  });
});
