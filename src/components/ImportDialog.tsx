import React from "react";
import { FolderOpen, Import } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ErrorBanner } from "./ui/error-banner";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { pickFile } from "@/lib/dialog";
import { errorMessage } from "@/lib/errors";
import { submitWithoutReset } from "@/lib/formSubmit";
import { KIND_LABELS } from "@/lib/sshTerms";
import { useImportStore } from "@/store/useImportStore";
import type {
  ImportCredentialPlan,
  ImportItem,
  ImportPreview,
  ImportResult,
  ImportSkip,
  ImportSkipCategory,
} from "@/types";

const DEFAULT_CONFIG_PATH = "~/.ssh/config";

const SKIP_LABELS: Record<ImportSkipCategory, string> = {
  pattern: "Pattern",
  already_imported: "Already imported",
  name_clash: "Name clash",
  duplicate: "Duplicate",
  unsupported: "Not supported",
  invalid: "Invalid",
};

/** Name clashes come first: they are the one skip that may need action. */
const SKIP_ORDER: ImportSkipCategory[] = [
  "name_clash",
  "invalid",
  "unsupported",
  "duplicate",
  "already_imported",
  "pattern",
];

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function resultMessage(result: ImportResult): string {
  const connections = pluralize(result.connections.length, "connection");
  const credentials = result.credentials.length;
  return credentials > 0
    ? `Imported ${connections} and ${pluralize(credentials, "credential")}.`
    : `Imported ${connections}.`;
}

function credentialLine(credential: ImportCredentialPlan): string {
  const auth = credential.private_key_path ?? "keys from the SSH agent";
  const origin = credential.exists ? "existing" : "new";
  return `${credential.role}: ${credential.name} (${origin}), ${auth}`;
}

function ImportItemRow({
  item,
  checked,
  onToggle,
}: {
  item: ImportItem;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const checkboxId = `import-item-${item.key}`;
  return (
    <li
      className="flex items-start gap-3 rounded-md border border-border p-3"
      data-testid="import-item"
      data-name={item.name}
    >
      <Checkbox
        id={checkboxId}
        checked={checked}
        onCheckedChange={(value) => onToggle(value === true)}
        className="mt-0.5"
        data-testid="import-item-checkbox"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={checkboxId} className="break-all font-medium">
            {item.name}
          </Label>
          <Badge variant="secondary">{KIND_LABELS[item.type]}</Badge>
        </div>
        <p className="break-words text-sm text-muted-foreground">{item.target}</p>
        {item.credentials.map((credential) => (
          <p key={credential.role} className="break-all text-xs text-muted-foreground">
            {credentialLine(credential)}
          </p>
        ))}
        {item.proxy_command && (
          <p className="break-all text-xs text-muted-foreground">
            Runs this local command on connect:{" "}
            <code className="font-mono text-foreground">{item.proxy_command}</code>
          </p>
        )}
        {item.notes.map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
        <p className="text-xs text-muted-foreground-soft">{item.source}</p>
      </div>
    </li>
  );
}

function SkipRow({ skip }: { skip: ImportSkip }) {
  return (
    <li
      className="space-y-1 rounded-md border border-border p-3"
      data-testid="import-skip"
      data-name={skip.name}
      data-category={skip.category}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all text-sm font-medium">{skip.name}</span>
        <Badge variant={skip.category === "name_clash" ? "destructive" : "outline"}>
          {SKIP_LABELS[skip.category]}
        </Badge>
      </div>
      <p className="break-words text-xs text-muted-foreground">{skip.reason}</p>
      <p className="text-xs text-muted-foreground-soft">{skip.source}</p>
    </li>
  );
}

function PreviewSections({
  preview,
  isPicked,
  onToggle,
  onToggleAll,
}: {
  preview: ImportPreview;
  isPicked: (item: ImportItem) => boolean;
  onToggle: (item: ImportItem, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}) {
  const pickedCount = preview.items.filter(isPicked).length;
  const allState =
    pickedCount === preview.items.length ? true : pickedCount === 0 ? false : "indeterminate";
  const skipped = SKIP_ORDER.flatMap((category) =>
    preview.skipped.filter((skip) => skip.category === category),
  );
  return (
    <>
      <p className="break-all text-xs text-muted-foreground-soft" data-testid="import-files">
        Read: {preview.files.join(", ")}
      </p>
      <section className="space-y-2" aria-labelledby="import-items-heading">
        <div className="flex items-center gap-2">
          {preview.items.length > 0 && (
            <Checkbox
              checked={allState}
              onCheckedChange={(value) => onToggleAll(value === true)}
              aria-label="Select every host"
              data-testid="import-select-all"
            />
          )}
          <h3 id="import-items-heading" className="text-sm font-semibold">
            Can be created ({preview.items.length})
          </h3>
        </div>
        {preview.items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="import-nothing">
            Nothing new to import from this file.
          </p>
        ) : (
          <ul className="space-y-2">
            {preview.items.map((item) => (
              <ImportItemRow
                key={item.key}
                item={item}
                checked={isPicked(item)}
                onToggle={(checked) => onToggle(item, checked)}
              />
            ))}
          </ul>
        )}
      </section>
      {skipped.length > 0 && (
        <section className="space-y-2" aria-labelledby="import-skipped-heading">
          <h3 id="import-skipped-heading" className="text-sm font-semibold">
            Skipped ({skipped.length})
          </h3>
          <ul className="space-y-2">
            {skipped.map((skip) => (
              <SkipRow key={`${skip.category}:${skip.name}:${skip.source}`} skip={skip} />
            ))}
          </ul>
        </section>
      )}
      {preview.notices.length > 0 && (
        <section className="space-y-2" aria-labelledby="import-notices-heading">
          <h3 id="import-notices-heading" className="text-sm font-semibold">
            Passed over ({preview.notices.length})
          </h3>
          <ul className="space-y-1">
            {preview.notices.map((notice, index) => (
              <li
                key={index}
                className="break-words text-xs text-muted-foreground"
                data-testid="import-notice"
              >
                <span className="text-muted-foreground-soft">{notice.source}</span>{" "}
                {notice.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Preview of an import from an OpenSSH config, in the side panel: what would
 * be created, what was skipped and why. Reading the file writes nothing; only
 * the Import button stores anything, and only the rows left ticked.
 */
export function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const { preview, isLoading, error, loadPreview, applyImport, reset } = useImportStore(
    useShallow((s) => ({
      preview: s.preview,
      isLoading: s.isLoading,
      error: s.error,
      loadPreview: s.loadPreview,
      applyImport: s.applyImport,
      reset: s.reset,
    })),
  );
  const [path, setPath] = React.useState(DEFAULT_CONFIG_PATH);
  // Only what the user changed: every other row keeps the backend's default,
  // and a preview loaded again keeps these.
  const [ticks, setTicks] = React.useState<ReadonlyMap<string, boolean>>(new Map());
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setPath(DEFAULT_CONFIG_PATH);
    setTicks(new Map());
    setApplyError(null);
    setResult(null);
    void loadPreview(DEFAULT_CONFIG_PATH);
    return reset;
  }, [open, loadPreview, reset]);

  const load = (nextPath: string) => {
    setApplyError(null);
    setResult(null);
    void loadPreview(nextPath);
  };

  const isPicked = (item: ImportItem) => ticks.get(item.key) ?? item.preselected;
  const picked = preview?.items.filter(isPicked) ?? [];

  const setChecked = (items: ImportItem[], checked: boolean) => {
    setTicks((current) => {
      const next = new Map(current);
      for (const item of items) next.set(item.key, checked);
      return next;
    });
  };

  const confirm = async () => {
    if (!preview) return;
    setApplyError(null);
    setResult(null);
    // The file on screen, even if the path box has been edited since.
    const shownPath = preview.path;
    try {
      const imported = await applyImport(
        shownPath,
        picked.map((item) => item.key),
      );
      setResult(imported);
    } catch (err) {
      setApplyError(errorMessage(err));
    }
    // Either way the preview is out of date: what was imported now shows as
    // already imported, and a refused import shows what changed.
    await loadPreview(shownPath);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden" data-testid="import-dialog">
        <DialogHeader>
          <DialogTitle>Import from SSH config</DialogTitle>
          <DialogDescription>
            Hosts from an OpenSSH config file become connections. Nothing is saved until you
            choose Import, and existing connections are never changed.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={submitWithoutReset(() => load(path))}
        >
          <Label htmlFor="import-path">Config file</Label>
          <div className="flex gap-2">
            <Input
              id="import-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={DEFAULT_CONFIG_PATH}
              spellCheck={false}
              data-testid="import-path"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Browse for an SSH config file"
              title="Browse for an SSH config file"
              onClick={async () => {
                const chosen = await pickFile({ title: "Select an SSH config file" });
                if (chosen) {
                  setPath(chosen);
                  load(chosen);
                }
              }}
            >
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button type="submit" variant="outline" disabled={isLoading} data-testid="import-load">
              Read file
            </Button>
          </div>
        </form>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto" data-testid="import-preview">
          {error && (
            <ErrorBanner
              message={`Could not read the config: ${error}`}
              onRetry={() => load(path)}
              testId="import-load-error"
            />
          )}
          {applyError && <ErrorBanner message={applyError} testId="import-apply-error" />}
          {result && (
            <p
              role="status"
              aria-live="polite"
              className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600"
              data-testid="import-result"
            >
              {resultMessage(result)}
            </p>
          )}
          {isLoading && !preview && (
            <p role="status" className="text-sm text-muted-foreground">
              Reading the config…
            </p>
          )}
          {preview && (
            <PreviewSections
              preview={preview}
              isPicked={isPicked}
              onToggle={(item, checked) => setChecked([item], checked)}
              onToggleAll={(checked) => setChecked(preview.items, checked)}
            />
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="import-close"
          >
            {result ? "Done" : "Cancel"}
          </Button>
          <Button
            type="button"
            disabled={isLoading || picked.length === 0}
            aria-busy={isLoading}
            onClick={() => void confirm()}
            data-testid="import-confirm"
          >
            Import {pluralize(picked.length, "connection")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The Connections header's Import button and the panel it opens. */
export function ImportButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid="import-config-button"
      >
        <Import className="h-4 w-4 mr-1" aria-hidden="true" />
        Import
      </Button>
      <ImportDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
