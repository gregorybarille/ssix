import type { AppSettings } from "@/types";

/**
 * What `SettingsPanel` gives each section file in this directory. A section
 * passes only the keys it changes; the panel merges them into the form and
 * owns the debounce, the save queue and the "Settings saved!" status.
 */
export interface SettingsSectionProps {
  form: AppSettings;
  /**
   * Preview and save (debounced). For controls that change in one step:
   * switches, selects, swatches.
   */
  applySettings: (partial: Partial<AppSettings>) => void;
  /** Hold typed text in the form without saving. Pair with `commitTextSettings` on blur. */
  updateLocalSettings: (partial: Partial<AppSettings>) => void;
  /** Save (debounced) without a preview, when a text field is done being edited. */
  commitTextSettings: (partial: Partial<AppSettings>) => void;
}
