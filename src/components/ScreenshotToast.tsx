import { useDialogsStore } from "@/store/useDialogsStore";

/** Bottom-right toast for the screenshot result; excluded from captures. */
export function ScreenshotToast() {
  const toast = useDialogsStore((s) => s.screenshotToast);
  if (!toast) return null;
  const isError = toast.kind === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      data-screenshot-exclude="true"
      className={`fixed bottom-4 right-4 z-[9999] rounded-md border shadow-lg px-4 py-2 text-sm max-w-md break-all ${
        isError
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "bg-popover text-popover-foreground"
      }`}
    >
      {toast.message}
    </div>
  );
}
