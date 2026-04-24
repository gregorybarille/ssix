import React, { useState, KeyboardEvent } from "react";
import { Badge } from "./badge";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}

/**
 * Chip-style tag editor.
 *
 * Commit keys: Enter or Comma. Space is intentionally NOT a commit
 * key (P2-A9) — multi-word tags like "needs review" are valid and
 * the previous Space-as-commit behavior silently mangled them.
 * Backspace on an empty buffer removes the last chip. Duplicates
 * are deduped case-insensitively. The chip strip is exposed as a
 * `role="list"` so AT announces "list, 3 items" rather than a
 * shapeless run of badges.
 */
export function TagInput({
  value,
  onChange,
  placeholder,
  id,
  className,
}: TagInputProps) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (value.some((t) => t.toLowerCase() === lower)) {
      setDraft("");
      return;
    }
    onChange([...value, trimmed]);
    setDraft("");
  };

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className={cn(
        "flex flex-wrap gap-1.5 items-center rounded-md border border-input bg-background px-2 py-1.5 min-h-9 focus-within:ring-1 focus-within:ring-ring",
        className,
      )}
    >
      {value.length > 0 && (
        <ul role="list" aria-label="Tags" className="contents">
          {value.map((tag, i) => (
            <li role="listitem" key={`${tag}-${i}`} className="contents">
              <Badge variant="secondary" className="gap-1 pr-1">
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => removeAt(i)}
                  className="rounded-sm hover:bg-destructive/20 hover:text-destructive p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[80px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
      />
    </div>
  );
}
