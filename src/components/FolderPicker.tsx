import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { useListboxNavigation } from "@/hooks/useListboxNavigation";
import { cn } from "@/lib/utils";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import type { SingleFieldInputProps } from "./ui/single-field-dialog";

interface FolderPickerProps extends SingleFieldInputProps {
  /** Existing folders to choose from. */
  folders: string[];
}

/**
 * A folder path: type a new one, or pick an existing one from the list that
 * opens under the field (ARIA combobox with a list popup). The list sits in
 * the flow of the form rather than floating over it, so a side panel's
 * scroll area can never clip it.
 *
 * Enter takes the option the arrow keys reached; with none reached it submits
 * the form with the typed path, so a new folder that merely resembles an
 * existing one stays what was typed.
 */
export function FolderPicker({
  folders,
  value,
  onChange,
  onKeyDown,
  onBlur,
  onClick,
  className,
  ...inputProps
}: FolderPickerProps) {
  const listboxId = `${useId()}-folders`;
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [navigated, setNavigated] = useState(false);

  const matches = useMemo(() => {
    if (showAll) return folders;
    const text = value.trim().toLowerCase();
    return folders.filter((path) => path !== value.trim() && path.toLowerCase().includes(text));
  }, [folders, value, showAll]);

  const close = () => {
    setOpen(false);
    setShowAll(false);
    setNavigated(false);
  };
  const choose = (index: number) => {
    onChange(matches[index]);
    close();
  };
  const nav = useListboxNavigation({ count: matches.length, onChoose: choose });
  const shown = open && matches.length > 0;

  // Radix hears Escape on the document while it is on its way down, so a
  // handler on the input would be too late to keep the panel open.
  useEffect(() => {
    if (!shown) return;
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [shown]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (folders.length === 0) return;
      if (shown && navigated) {
        nav.onKeyDown(e);
      } else {
        e.preventDefault();
        // With nothing matching what is typed, the arrows offer them all.
        if (matches.length === 0) setShowAll(true);
        setOpen(true);
        setNavigated(true);
        nav.setActiveIndex(e.key === "ArrowDown" ? 0 : (matches.length || folders.length) - 1);
      }
    } else if (e.key === "Enter" && shown && navigated) {
      nav.onKeyDown(e);
    }
  };

  const active = shown && navigated ? nav.activeIndex : -1;

  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          {...inputProps}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={listboxId}
          aria-activedescendant={active >= 0 ? `${listboxId}-${active}` : undefined}
          className={cn("pr-9", className)}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setShowAll(false);
            setNavigated(false);
            nav.setActiveIndex(0);
          }}
          onClick={(e) => {
            onClick?.(e);
            setOpen(true);
          }}
          onBlur={(e) => {
            onBlur?.(e);
            close();
          }}
          onKeyDown={handleKeyDown}
        />
        {folders.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            tabIndex={-1}
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
            aria-label="Show existing folders"
            data-testid="folder-picker-toggle"
            // Keep focus in the field, or its blur would close the list again.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (shown && showAll) {
                close();
              } else {
                setOpen(true);
                setShowAll(true);
              }
            }}
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>
      <div
        {...nav.listProps}
        id={listboxId}
        role="listbox"
        aria-label="Existing folders"
        hidden={!shown}
        className="max-h-40 overflow-y-auto rounded-md border border-input bg-background py-1 text-sm"
      >
        {shown &&
          matches.map((path, index) => (
            <div
              {...nav.rowProps(index)}
              key={path}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-testid="folder-picker-option"
              data-name={path}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(index)}
              className={cn(
                "cursor-pointer truncate px-3 py-1.5 transition-colors",
                index === active ? "bg-accent" : "hover:bg-accent/60",
              )}
              title={path}
            >
              {path}
            </div>
          ))}
      </div>
    </div>
  );
}
