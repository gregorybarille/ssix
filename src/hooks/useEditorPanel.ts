import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { useLeaveViewGuard } from "@/hooks/useLeaveViewGuard";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { errorMessage } from "@/lib/errors";
import type { FormSwitchGuard } from "@/store/useDialogsStore";

/**
 * The list view's side of an editor in the side panel. `editing` is the item
 * on show (`null` inside it for a new one); mount the form with `editing.key`
 * so its state starts fresh, and pass it `setFormGuard`. Opening another item
 * while the form has unsaved changes asks first.
 */
export function useEditorPanel<T>() {
  const [editing, setEditing] = useState<{ item: T | null; key: number } | null>(null);
  const editKey = useRef(0);
  const formGuard = useRef<FormSwitchGuard | null>(null);
  const setFormGuard = useCallback((guard: FormSwitchGuard | null) => {
    formGuard.current = guard;
  }, []);
  const openEditor = (item: T | null) => {
    const open = () => setEditing({ item, key: ++editKey.current });
    if (formGuard.current) formGuard.current(open);
    else open();
  };
  const closeEditor = () => setEditing(null);
  return { editing, openEditor, closeEditor, setFormGuard };
}

/**
 * The form's side: the unsaved-changes guard, compared against the first
 * `snapshot` (any JSON value holding the fields), which also guards replacing
 * the form from the list and leaving the view. Pass the result to `EditorPanel`.
 */
export function useEditorFormGuard(
  snapshot: unknown,
  onClose: () => void,
  onGuardChange: (guard: FormSwitchGuard | null) => void,
) {
  const current = JSON.stringify(snapshot);
  const baseline = useRef(current);
  const guard = useUnsavedChangesGuard(current !== baseline.current);
  const { requestClose } = guard;
  useEffect(() => {
    onGuardChange((proceed) => requestClose(proceed));
    return () => onGuardChange(null);
  }, [requestClose, onGuardChange]);
  useLeaveViewGuard(true, requestClose, onClose);
  return { ...guard, closeForm: () => requestClose(onClose) };
}

export type EditorFormGuard = ReturnType<typeof useEditorFormGuard>;

interface EditorSubmitOptions<K extends string> {
  /** The inline errors of the current fields; empty when they can be saved. */
  validate: () => Partial<Record<K, string>>;
  setFieldErrors: (errors: Partial<Record<K, string>>) => void;
  save: () => Promise<unknown>;
  guard: EditorFormGuard;
  onClose: () => void;
}

/**
 * The form's save, as the `useActionState` triple: stop at inline errors, save,
 * and close without the discard prompt, or stay open with the reason it failed.
 */
export function useEditorSubmit<K extends string>({
  validate,
  setFieldErrors,
  save,
  guard,
  onClose,
}: EditorSubmitOptions<K>) {
  return useActionState<{ error: string | null }>(
    async () => {
      const errors = validate();
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        return { error: "Please fix the highlighted fields" };
      }
      try {
        await save();
        guard.markSaved();
        onClose();
        return { error: null };
      } catch (err) {
        return { error: errorMessage(err) };
      }
    },
    { error: null },
  );
}
