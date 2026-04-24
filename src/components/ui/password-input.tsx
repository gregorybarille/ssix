import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "./input";
import { Button } from "./button";
import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  className?: string;
};

/*
 * P2-A7: default `autoComplete="current-password"` so password managers
 * (1Password, Bitwarden, Keychain) recognize the field. Callers creating
 * a new credential should pass `autoComplete="new-password"`. The
 * visibility toggle exposes its state via `aria-pressed` so screen
 * readers announce "Show password, toggle button, not pressed" /
 * "pressed" — the visual icon swap is not enough on its own.
 */
export function PasswordInput({ className, autoComplete, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        autoComplete={autoComplete ?? "current-password"}
        type={visible ? "text" : "password"}
        className={cn("pr-10", className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-0 top-0 h-full w-10 px-0 text-muted-foreground hover:text-foreground"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  );
}
