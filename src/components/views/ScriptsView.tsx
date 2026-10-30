import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileCode, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Connection, Script, ScriptInput } from "@/types";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { EmptyState } from "../ui/EmptyState";
import { ErrorBanner } from "../ui/error-banner";
import { StatusIcon } from "../ui/status-icon";
import { ConfirmDialog } from "../ConfirmDialog";
import { ScriptForm } from "../ScriptForm";
import { useScriptsStore } from "@/store/useScriptsStore";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import type { FormSwitchGuard } from "@/store/useDialogsStore";
import { isBulkActionable } from "@/lib/bulk-actions";
import {
  describeScriptEnd,
  formatDuration,
  planScriptRun,
  type ScriptRunStep,
} from "@/lib/scripts";
import { cn } from "@/lib/utils";

/** What the side panel editor is showing: a new script or an existing one. */
type Editing = { script: Script | null; key: number } | null;

/**
 * The Scripts tab: saved scripts on the left, the selected script's run
 * area on the right (hosts to run it on, then one result per host). The
 * editor opens in the side panel.
 */
export function ScriptsView() {
  const { scripts, loadError, fetchScripts, addScript, updateScript, deleteScript, run, running, runScript } =
    useScriptsStore(
      useShallow((s) => ({
        scripts: s.scripts,
        loadError: s.error,
        fetchScripts: s.fetchScripts,
        addScript: s.addScript,
        updateScript: s.updateScript,
        deleteScript: s.deleteScript,
        run: s.run,
        running: s.running,
        runScript: s.runScript,
      })),
    );
  const connections = useConnectionsStore((s) => s.connections);
  const hosts = useMemo(() => connections.filter(isBulkActionable), [connections]);

  useEffect(() => {
    void fetchScripts();
  }, [fetchScripts]);

  const [selectedId, setSelectedId] = useState<string | null>(run?.scriptId ?? null);
  const selected = scripts.find((s) => s.id === selectedId) ?? scripts[0] ?? null;

  const [editing, setEditing] = useState<Editing>(null);
  const editKey = useRef(0);
  const formGuard = useRef<FormSwitchGuard | null>(null);
  const setFormGuard = useCallback((guard: FormSwitchGuard | null) => {
    formGuard.current = guard;
  }, []);
  // Opening another script while the editor has unsaved changes asks first.
  const openEditor = (script: Script | null) => {
    const open = () => setEditing({ script, key: ++editKey.current });
    if (formGuard.current) formGuard.current(open);
    else open();
  };

  const [confirmDelete, setConfirmDelete] = useState<Script | null>(null);

  const submit = async (input: ScriptInput) => {
    const saved = editing?.script
      ? await updateScript(editing.script.id, input)
      : await addScript(input);
    setSelectedId(saved.id);
    return saved;
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold">Scripts</h1>
        <Button size="sm" onClick={() => openEditor(null)} data-testid="add-script-button">
          <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
          New Script
        </Button>
      </div>
      {loadError && (
        <ErrorBanner
          className="mx-6 mt-2"
          message={`Could not load scripts: ${loadError}`}
          onRetry={() => void fetchScripts()}
          testId="scripts-load-error"
        />
      )}
      {scripts.length === 0 ? (
        <EmptyState
          icon={FileCode}
          title="No scripts yet"
          hint="Save a script once, then run it on several hosts at the same time."
        />
      ) : (
        <div className="flex flex-1 min-h-0">
          <ul
            className="w-60 shrink-0 border-r border-border overflow-y-auto p-2 space-y-1"
            aria-label="Scripts"
            data-testid="script-list"
          >
            {scripts.map((script) => (
              <li
                key={script.id}
                className={cn(
                  "group flex items-center gap-1 rounded-md pr-1",
                  script.id === selected?.id ? "bg-accent" : "hover:bg-accent/50",
                )}
                data-testid="script-row"
                data-name={script.name}
              >
                <button
                  type="button"
                  className="flex-1 min-w-0 text-left px-2 py-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-current={script.id === selected?.id ? "true" : undefined}
                  onClick={() => setSelectedId(script.id)}
                  data-testid="script-row-select"
                >
                  <span className="block text-sm font-medium truncate">{script.name}</span>
                  <span className="block text-xs font-mono text-muted-foreground-soft truncate">
                    {script.interpreter}
                  </span>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label={`Edit ${script.name}`}
                  onClick={() => openEditor(script)}
                  data-testid="script-row-edit"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label={`Delete ${script.name}`}
                  onClick={() => setConfirmDelete(script)}
                  data-testid="script-row-delete"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          {selected && (
            <ScriptRunArea
              key={selected.id}
              script={selected}
              hosts={hosts}
              steps={run?.scriptId === selected.id ? run.steps : null}
              running={running}
              onRun={(steps) => void runScript(selected.id, steps)}
            />
          )}
        </div>
      )}

      {editing && (
        <ScriptForm
          key={editing.key}
          script={editing.script}
          onSubmit={submit}
          onClose={() => setEditing(null)}
          onGuardChange={setFormGuard}
        />
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="Delete script?"
        description={
          <>
            Delete <strong>{confirmDelete?.name}</strong>? This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        variant="destructive"
        testId="script-delete-dialog"
        onConfirm={async () => {
          if (!confirmDelete) return;
          await deleteScript(confirmDelete.id);
          if (editing?.script?.id === confirmDelete.id) setEditing(null);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

interface ScriptRunAreaProps {
  script: Script;
  hosts: Connection[];
  /** This script's latest run, if it has one. */
  steps: ScriptRunStep[] | null;
  running: boolean;
  onRun: (steps: ScriptRunStep[]) => void;
}

function ScriptRunArea({ script, hosts, steps, running, onRun }: ScriptRunAreaProps) {
  // Start from the hosts of the last run, so running again is one click.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(steps?.map((s) => s.connectionId) ?? []),
  );
  const allPicked = hosts.length > 0 && hosts.every((h) => picked.has(h.id));
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const plan = planScriptRun(hosts, picked);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6 space-y-5" data-testid="script-run-area">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold truncate">{script.name}</h2>
          <Badge variant="secondary" className="font-mono">
            {script.interpreter}
          </Badge>
        </div>
        <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-3 text-xs font-mono whitespace-pre">
          {script.body}
        </pre>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium mb-2">Run on</legend>
        {hosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No direct or jump host connections yet. Local forwards cannot run scripts.
          </p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={allPicked}
                onCheckedChange={(v) =>
                  setPicked(v === true ? new Set(hosts.map((h) => h.id)) : new Set())
                }
                disabled={running}
                data-testid="script-hosts-all"
              />
              All hosts
            </label>
            <div className="grid gap-1.5 pl-6 sm:grid-cols-2">
              {hosts.map((host) => (
                <label
                  key={host.id}
                  className="flex items-center gap-2 text-sm cursor-pointer min-w-0"
                  data-testid="script-host"
                  data-name={host.name}
                >
                  <Checkbox
                    checked={picked.has(host.id)}
                    onCheckedChange={(v) => toggle(host.id, v === true)}
                    disabled={running}
                  />
                  <span className="truncate">{host.name}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </fieldset>

      <Button
        onClick={() => onRun(plan)}
        disabled={running || plan.length === 0}
        aria-busy={running}
        data-testid="script-run"
      >
        <Play className="h-4 w-4 mr-1" aria-hidden="true" />
        {running
          ? "Running..."
          : `Run on ${plan.length} host${plan.length === 1 ? "" : "s"}`}
      </Button>

      {steps && steps.length > 0 && (
        <section
          aria-label="Results"
          className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]"
          aria-live="polite"
          aria-busy={running}
        >
          {steps.map((step) => (
            <ScriptResultCard key={step.connectionId} step={step} />
          ))}
        </section>
      )}
    </div>
  );
}

function ScriptResultCard({ step }: { step: ScriptRunStep }) {
  const { result } = step;
  const summary = result
    ? `${describeScriptEnd(result)} · ${formatDuration(result.duration_ms)}`
    : step.status === "running"
      ? "running…"
      : null;
  return (
    <article
      className="rounded-md border min-w-0 flex flex-col"
      data-testid="script-result"
      data-name={step.connectionName}
      data-status={step.status}
      data-exit-code={result?.exit_code ?? undefined}
    >
      <header className="flex items-start gap-2 px-3 py-2 border-b">
        <StatusIcon status={step.status} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{step.connectionName}</div>
          {summary && <div className="text-xs text-muted-foreground">{summary}</div>}
        </div>
      </header>
      <div className="p-3 space-y-2 text-xs">
        {step.error && <p className="text-destructive break-words">{step.error}</p>}
        {result && (
          <>
            {result.stdout && (
              <pre
                className="max-h-64 overflow-auto font-mono whitespace-pre-wrap break-words"
                data-testid="script-result-stdout"
              >
                {result.stdout}
              </pre>
            )}
            {result.stderr && (
              <div>
                <div className="text-muted-foreground-soft mb-1">stderr</div>
                <pre
                  className="max-h-48 overflow-auto font-mono whitespace-pre-wrap break-words"
                  data-testid="script-result-stderr"
                >
                  {result.stderr}
                </pre>
              </div>
            )}
            {!result.stdout && !result.stderr && (
              <p className="text-muted-foreground-soft">No output.</p>
            )}
            {result.truncated && (
              <p className="text-muted-foreground-soft">Output was cut at 1 MiB per stream.</p>
            )}
          </>
        )}
      </div>
    </article>
  );
}
