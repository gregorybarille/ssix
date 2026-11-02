import { cn } from "@/lib/utils";

interface DragChipProps {
  chip: { x: number; y: number; label: string; overTarget: boolean };
  testId: string;
}

/** The label that follows the pointer during a drag; faint while nothing would take it. */
export function DragChip({ chip, testId }: DragChipProps) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed z-50 max-w-60 truncate rounded border border-border bg-popover px-2 py-1 text-xs shadow-md",
        !chip.overTarget && "opacity-60",
      )}
      style={{ left: chip.x + 12, top: chip.y + 12 }}
      data-testid={testId}
    >
      {chip.label}
    </div>
  );
}
