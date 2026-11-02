import { ConnectionLayout, FONT_FAMILIES, FONT_SIZES, OPEN_COLORS, OpenMode } from "@/types";
import { COLOR_VALUES } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Separator } from "../ui/separator";
import type { SettingsSectionProps } from "./section";

/** Font, colour scheme, theme, list layouts and the default open mode. */
export function AppearanceSection({ form, applySettings }: SettingsSectionProps) {
  return (
    <>
      <div
        className="space-y-4"
        role="group"
        aria-labelledby="settings-font-heading"
      >
        <h3 id="settings-font-heading" className="text-sm font-medium">Font</h3>

        <div className="space-y-2">
          <Label htmlFor="font-family">Font Family</Label>
          <Select
            value={form.font_family}
            onValueChange={(v) => applySettings({ font_family: v })}
          >
            <SelectTrigger id="font-family">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_FAMILIES.map((f) => (
                <SelectItem key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="font-size">Font Size</Label>
          <Select
            value={String(form.font_size)}
            onValueChange={(v) => applySettings({ font_size: Number(v) })}
          >
            <SelectTrigger id="font-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_SIZES.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Separator />

      <div className="space-y-4">
        {/*
          Audit-3 P1#5: Color swatches were a hand-rolled <button> grid
          which screen readers announce as N unrelated buttons rather
          than as a single radio group with one selected option, and
          which gives keyboard users no arrow-key navigation. The
          shared <RadioGroup> primitive (Radix-backed) wires
          role=radiogroup + role=radio + aria-checked + arrow keys +
          roving tabindex automatically. The visible swatch is just
          the styled child of <RadioGroupItem>; data-state=checked
          drives the selected ring.
        */}
        <h3 id="settings-color-scheme-heading" className="text-sm font-medium">
          Color Scheme (Open Colors)
        </h3>
        <RadioGroup
          aria-labelledby="settings-color-scheme-heading"
          /*
            Audit-3 follow-up P1#2: NO `orientation` prop here. The
            swatches lay out in a 4-column grid (`grid-cols-4`), so
            keyboard users need BOTH ArrowLeft/Right (across a row)
            AND ArrowUp/Down (between rows). Radix RadioGroup's
            default omits the orientation context value, which makes
            its RovingFocusGroup accept all four arrow keys. Setting
            `orientation="horizontal"` would lock arrow nav to L/R
            only — fine for the theme picker (single row, line ~199)
            but broken for this 4-column grid. The connection-form
            color picker (ConnectionForm.tsx ~970) uses `flex-wrap`
            so visual rows are unpredictable; it also omits the
            orientation prop for the same reason.
          */
          value={form.color_scheme}
          onValueChange={(v) => applySettings({ color_scheme: v })}
          className="grid grid-cols-4 gap-2"
        >
          {OPEN_COLORS.map((color) => (
            <RadioGroupItem
              key={color}
              value={color}
              aria-label={color}
              className={cn(
                "flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all",
                "data-[state=checked]:border-primary data-[state=checked]:bg-accent",
                "data-[state=unchecked]:border-transparent data-[state=unchecked]:hover:border-border",
              )}
            >
              <div
                className="w-6 h-6 rounded-full"
                style={{ backgroundColor: COLOR_VALUES[color] }}
                aria-hidden="true"
              />
              <span className="text-xs capitalize">{color}</span>
            </RadioGroupItem>
          ))}
        </RadioGroup>
      </div>
      <Separator />

      <div className="space-y-4">
        <h3 id="settings-theme-heading" className="text-sm font-medium">Theme</h3>
        <RadioGroup
          aria-labelledby="settings-theme-heading"
          orientation="horizontal"
          value={form.theme}
          onValueChange={(v) => {
            applySettings({ theme: v as "dark" | "light" });
          }}
          className="flex gap-3"
        >
          {(["dark", "light"] as const).map((theme) => (
            <RadioGroupItem
              key={theme}
              value={theme}
              className={cn(
                "flex-1 py-2 px-4 rounded-lg border text-sm font-medium capitalize transition-all",
                "data-[state=checked]:border-primary data-[state=checked]:bg-accent data-[state=checked]:text-foreground",
                "data-[state=unchecked]:border-border data-[state=unchecked]:text-muted-foreground data-[state=unchecked]:hover:text-foreground",
              )}
            >
              {theme}
            </RadioGroupItem>
          ))}
        </RadioGroup>
      </div>
      <Separator />

      <div
        className="space-y-4"
        role="group"
        aria-labelledby="settings-layout-heading"
        aria-describedby="settings-layout-desc"
      >
        <h3 id="settings-layout-heading" className="text-sm font-medium">Layout</h3>
        <p
          id="settings-layout-desc"
          className="text-xs text-muted-foreground"
        >
          Choose how each list is displayed.
        </p>
        {([
          ["connection_layout", "Connections"],
          ["credential_layout", "Credentials"],
          ["tunnel_layout", "Port forwards"],
        ] as const).map(([key, label]) => (
          <div className="space-y-2" key={key}>
            <Label htmlFor={key}>{label}</Label>
            <Select
              value={form[key]}
              onValueChange={(v) => applySettings({ [key]: v as ConnectionLayout })}
            >
              <SelectTrigger id={key}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="list">List</SelectItem>
                <SelectItem value="tile">Tiles</SelectItem>
                {/*
                 * "Tag groups" and "Folders" are connections-only modes —
                 * neither makes sense for credentials or port forwards.
                 * Hiding them elsewhere keeps the user from picking a
                 * setting that would silently fall back to "tile" at render
                 * time, or that `save_settings` would refuse.
                 */}
                {key === "connection_layout" && (
                  <SelectItem value="tags">Tag groups</SelectItem>
                )}
                {key === "connection_layout" && (
                  <SelectItem value="folders">Folders</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        ))}

        <div className="space-y-2">
          <Label htmlFor="default-open-mode">Default open mode</Label>
          <Select
            value={form.default_open_mode}
            onValueChange={(v) =>
              applySettings({ default_open_mode: v as OpenMode })
            }
          >
            <SelectTrigger id="default-open-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tab">New tab</SelectItem>
              <SelectItem value="split_right">Split right</SelectItem>
              <SelectItem value="split_down">Split down</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </>
  );
}
