import { Radio } from "lucide-react";
import type { TerminalTab } from "@/components/TerminalTabs";
import { isLiveShell } from "@/lib/terminalRegistry";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { Button } from "../ui/button";

/**
 * Turns broadcast input on and off for the active tab. Off by default, and it
 * takes two panes. While on it says so in words, and how many panes are
 * actually receiving: a pane that lost its connection gets nothing. Sticky, so
 * that it stays in view when many tabs make the tab bar scroll.
 */
export function BroadcastToggle({ tab }: { tab: TerminalTab }) {
  const toggleBroadcast = useTerminalsStore((s) => s.toggleBroadcast);
  const on = !!tab.broadcast;
  const canBroadcast = tab.panes.length >= 2;
  const live = tab.panes.filter(isLiveShell).length;
  const label = on ? `Broadcasting to ${live} of ${tab.panes.length} panes` : "Broadcast input";
  return (
    <div className="sticky right-0 ml-auto flex shrink-0 items-center bg-card px-1">
      <Button
        type="button"
        size="sm"
        variant={on ? "destructive" : "ghost"}
        className="h-7 px-2 text-xs"
        aria-pressed={on}
        disabled={!canBroadcast}
        title={
          canBroadcast
            ? "Send what you type in one pane of this tab to all of them"
            : "Split this tab to broadcast input to its panes"
        }
        onClick={() => toggleBroadcast(tab.id)}
        data-testid="broadcast-toggle"
      >
        <Radio aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
        {label}
      </Button>
    </div>
  );
}
