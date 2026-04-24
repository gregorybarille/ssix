import React from "react";
import { Search, X } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  placeholder?: string;
  className?: string;
}

export function SearchBar({
  value,
  onChange,
  onSearch,
  placeholder = "Search connections...",
  className,
}: SearchBarProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange(v);
    onSearch(v);
  };

  const handleClear = () => {
    onChange("");
    onSearch("");
  };

  return (
    <div className={cn("relative", className)}>
      <Search
        className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        className="pl-9 pr-9"
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        aria-label={placeholder}
      />
      {value && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
          onClick={handleClear}
          title="Clear search"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
