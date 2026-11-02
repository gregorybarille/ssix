import React, { useEffect } from "react";
import { AppSettings } from "@/types";
import { Separator } from "./ui/separator";
import { Check } from "lucide-react";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { errorMessage } from "@/lib/errors";
import { AppearanceSection } from "./settings/AppearanceSection";
import { BackupsSection } from "./settings/BackupsSection";
import { GitSyncSection } from "./settings/GitSyncSection";
import { SessionSection } from "./settings/SessionSection";
import { TerminalSection } from "./settings/TerminalSection";
import type { SettingsSectionProps } from "./settings/section";

/**
 * How long the panel waits after the last edit before writing to disk.
 * Rapid edits (toggling several switches, clicking through swatches,
 * blurring a text field and picking a select) coalesce into a single
 * `save_settings` call carrying the final form state.
 */
const SETTINGS_SAVE_DEBOUNCE_MS = 300;

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
  onPreview?: (settings: AppSettings) => void;
}

export function SettingsPanel({ settings, onSave, onPreview }: SettingsPanelProps) {
  const [form, setForm] = React.useState(settings);
  const [savedAt, setSavedAt] = React.useState(0);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const latestSaveVersionRef = React.useRef(0);
  const pendingSaveRef = React.useRef<AppSettings | null>(null);
  const isSavingRef = React.useRef(false);
  // Keys the user changed since the last successful save, and the latest
  // settings seen from the store. A save sends the store's current values
  // plus only our dirty keys, so a change made elsewhere during the
  // debounce window (a shortcut toggling the theme) is never overwritten
  // by our stale snapshot of the whole form.
  const dirtyKeysRef = React.useRef<Set<keyof AppSettings>>(new Set());
  const storeSettingsRef = React.useRef(settings);
  storeSettingsRef.current = settings;

  // Adopt settings from the store only while nothing of ours is in
  // flight or waiting on the debounce timer: each saved value echoes
  // back through this prop, and taking it while a newer edit is queued
  // would clobber what the user typed.
  useEffect(() => {
    if (isSavingRef.current || pendingSaveRef.current) return;
    setForm(settings);
  }, [settings]);

  const [savedVisible, setSavedVisible] = React.useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setSavedVisible(true);
    const id = setTimeout(() => setSavedVisible(false), 2000);
    return () => clearTimeout(id);
  }, [savedAt]);

  const processSaveQueue = React.useCallback(async () => {
    while (pendingSaveRef.current) {
      const pending = pendingSaveRef.current;
      const saveVersion = latestSaveVersionRef.current;
      pendingSaveRef.current = null;
      const toSave = { ...storeSettingsRef.current };
      for (const key of dirtyKeysRef.current) {
        (toSave as Record<string, unknown>)[key] = pending[key];
      }
      try {
        await onSave(toSave);
        if (saveVersion === latestSaveVersionRef.current) {
          dirtyKeysRef.current.clear();
          setSavedAt(Date.now());
        }
      } catch (error) {
        if (saveVersion !== latestSaveVersionRef.current) continue;
        setSaveError(errorMessage(error).trim() || "Failed to save settings.");
      }
    }
    isSavingRef.current = false;
  }, [onSave]);

  // Kick the queue. While a save is in flight the loop in
  // processSaveQueue picks up pendingSaveRef by itself, so this is a
  // no-op; only the version check decides whose result is shown.
  const startSave = React.useCallback(() => {
    if (isSavingRef.current || !pendingSaveRef.current) return;
    isSavingRef.current = true;
    void processSaveQueue();
  }, [processSaveQueue]);

  // Debounced start. pendingSaveRef always holds the full, latest form
  // state, so whichever edit ends the burst is what gets persisted —
  // including a git remote/branch that fails backend validation, whose
  // error then surfaces for that final state. Unmount (closing the
  // panel) flushes synchronously so the last value is never lost.
  const scheduleSave = useDebouncedCallback(startSave, SETTINGS_SAVE_DEBOUNCE_MS, {
    onUnmount: "flush",
  });

  // Losing the window (another app, hide, quit) is a natural "I'm
  // done editing" point and cheap to hook; flush rather than wait.
  useEffect(() => {
    const flush = () => scheduleSave.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("blur", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [scheduleSave]);

  const queueSave = (next: AppSettings) => {
    latestSaveVersionRef.current += 1;
    for (const key of Object.keys(next) as (keyof AppSettings)[]) {
      if (next[key] !== storeSettingsRef.current[key]) dirtyKeysRef.current.add(key);
    }
    pendingSaveRef.current = next;
    setSaveError(null);
    scheduleSave();
  };

  // What every section under `settings/` edits the form through. Each takes
  // only the keys it changes; `form` here is the state of the current render.
  const section: SettingsSectionProps = {
    form,
    applySettings: (partial) => {
      const next = { ...form, ...partial };
      setForm(next);
      onPreview?.(next);
      queueSave(next);
    },
    updateLocalSettings: (partial) => {
      setForm({ ...form, ...partial });
    },
    commitTextSettings: (partial) => {
      const next = { ...form, ...partial };
      setForm(next);
      queueSave(next);
    },
  };

  return (
    <div className="space-y-6 p-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Customize the appearance of SSIX
        </p>
      </div>
      <Separator />

      <AppearanceSection {...section} />

      <Separator />

      <TerminalSection {...section} />

      <SessionSection {...section} />

      <Separator />

      <GitSyncSection {...section} />

      <Separator />

      <BackupsSection {...section} />

      {/*
        P2-A11: announce save success to screen readers. role=status
        + aria-live=polite is the standard "transient confirmation"
        pattern; visual color alone is invisible to AT and to color-
        blind users on this background.
      */}
      <span
        role="status"
        aria-live="polite"
        className="text-sm text-green-600 dark:text-green-400 inline-flex items-center gap-1.5"
        data-testid="settings-saved-status"
      >
        {savedVisible && (
          <>
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
            Settings saved!
          </>
        )}
      </span>
      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}
    </div>
  );
}
