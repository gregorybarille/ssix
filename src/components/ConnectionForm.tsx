import React, { useActionState, useState, useEffect, useRef } from "react";
import { Connection, ConnectionDraft, ConnectionInput, Credential, ConnectionType, OPEN_COLORS } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { PasswordInput } from "./ui/password-input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { InstallKeyDialog } from "./InstallKeyDialog";
import { TagInput } from "./ui/tag-input";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Checkbox } from "./ui/checkbox";
import { COLOR_VALUES } from "@/lib/colors";
import { parsePort } from "@/lib/port";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { ConfirmDialog } from "./ConfirmDialog";

type AuthMethod = "password" | "ssh_key" | "credential";

interface ConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection?: Connection | null;
  credentials: Credential[];
  // Audit-4 Phase 4b: callers receive the discriminated `Connection`
  // (or `Omit<Connection, "id">` for new ones). Internally the form
  // builds a flat `ConnectionDraft` and narrows on submit.
  onSubmit: (data: ConnectionInput | Connection) => Promise<void>;
  onCreateCredential?: (data: Omit<Credential, "id">) => Promise<Credential>;
  isClone?: boolean;
}

const DEFAULT_FORM: ConnectionDraft = {
  name: "",
  host: "",
  port: 22,
  credential_id: undefined,
  type: "direct",
  verbosity: 0,
  extra_args: "",
  login_command: "",
  remote_path: "",
  tags: [],
  color: undefined,
};

/**
 * Stable serialization of every piece of form state we want to track
 * for unsaved-changes detection. Field order is fixed so the output is
 * deterministic across renders.
 */
function serializeFormState(s: {
  form: ConnectionDraft;
  portInputs: Record<string, string>;
  connectionType: ConnectionType;
  authMethod: AuthMethod;
  inlineUsername: string;
  inlinePassword: string;
  inlineKeyPath: string;
  inlinePassphrase: string;
  inlineCredentialName: string;
  saveCredential: boolean;
}): string {
  return JSON.stringify([
    s.form.name,
    s.form.host,
    s.form.credential_id ?? null,
    s.form.type,
    s.form.verbosity ?? 0,
    s.form.extra_args ?? "",
    s.form.login_command ?? "",
    s.form.remote_path ?? "",
    s.form.tags ?? [],
    s.form.color ?? null,
    s.form.gateway_host ?? null,
    s.form.gateway_credential_id ?? null,
    s.form.destination_host ?? null,
    s.form.local_port ?? null,
    s.portInputs,
    s.connectionType,
    s.authMethod,
    s.inlineUsername,
    // We deliberately track inline secrets so typing a password and
    // closing the dialog still warns the user.
    s.inlinePassword,
    s.inlineKeyPath,
    s.inlinePassphrase,
    s.inlineCredentialName,
    s.saveCredential,
  ]);
}

export function ConnectionForm({
  open,
  onOpenChange,
  connection,
  credentials,
  onSubmit,
  onCreateCredential,
  isClone = false,
}: ConnectionFormProps) {
  const [form, setForm] = useState<ConnectionDraft>(DEFAULT_FORM);
  const [connectionType, setConnectionType] = useState<ConnectionType>("direct");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("credential");
  const [inlineUsername, setInlineUsername] = useState("");
  const [inlinePassword, setInlinePassword] = useState("");
  const [inlineKeyPath, setInlineKeyPath] = useState("");
  const [inlinePassphrase, setInlinePassphrase] = useState("");
  const [inlineCredentialName, setInlineCredentialName] = useState("");
  const [saveCredential, setSaveCredential] = useState(false);

  // Port inputs are managed as raw strings so we can validate without
  // silently coercing invalid input back to 22. The keys mirror the
  // numeric port field names on `Connection`.
  type PortKey = "port" | "gateway_port" | "destination_port" | "local_port";
  const [portInputs, setPortInputs] = useState<Record<PortKey, string>>({
    port: "22",
    gateway_port: "22",
    destination_port: "22",
    local_port: "",
  });
  const [portErrors, setPortErrors] = useState<Partial<Record<PortKey, string>>>({});

  // Inline per-field errors for required text fields. Keyed by the field
  // name (`name`, `host`, `gateway_host`, `destination_host`,
  // `gateway_credential_id`). Cleared as the user edits.
  type FieldKey =
    | "name"
    | "host"
    | "gateway_host"
    | "destination_host"
    | "gateway_credential_id";
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const clearFieldError = (key: FieldKey) =>
    setFieldErrors((errs) => {
      if (!errs[key]) return errs;
      const next = { ...errs };
      delete next[key];
      return next;
    });

  const updatePort = (key: PortKey, raw: string) => {
    setPortInputs((p) => ({ ...p, [key]: raw }));
    const parsed = parsePort(raw);
    setPortErrors((errs) => {
      const next = { ...errs };
      if (parsed.error) next[key] = parsed.error;
      else delete next[key];
      return next;
    });
  };

  useEffect(() => {
    if (connection) {
      setForm({
        name: isClone ? `${connection.name} (copy)` : connection.name,
        host: connection.host,
        port: connection.port,
        credential_id: connection.credential_id,
        type: connection.type,
        verbosity: connection.verbosity ?? 0,
        extra_args: connection.extra_args ?? "",
        login_command: connection.login_command ?? "",
        remote_path: connection.remote_path ?? "",
        tags: connection.tags ?? [],
        color: connection.color,
        // Audit-4 Phase 4b: gateway/destination fields only exist on
        // port_forward and jump_shell variants. Pull them out via a
        // narrowing switch so TS knows we're not poking DirectConnection.
        ...(connection.type === "port_forward"
          ? {
              gateway_host: connection.gateway_host,
              gateway_port: connection.gateway_port,
              gateway_credential_id: connection.gateway_credential_id,
              local_port: connection.local_port,
              destination_host: connection.destination_host,
              destination_port: connection.destination_port,
            }
          : connection.type === "jump_shell"
          ? {
              gateway_host: connection.gateway_host,
              gateway_port: connection.gateway_port,
              gateway_credential_id: connection.gateway_credential_id,
              destination_host: connection.destination_host,
              destination_port: connection.destination_port,
            }
          : {}),
      });
      setPortInputs({
        port: String(connection.port ?? 22),
        gateway_port: String(
          connection.type !== "direct" ? connection.gateway_port : 22,
        ),
        destination_port: String(
          connection.type !== "direct"
            ? connection.destination_port
            : 22,
        ),
        local_port:
          connection.type === "port_forward" ? String(connection.local_port) : "",
      });
      setConnectionType(connection.type);
      setAuthMethod("credential");
    } else {
      setForm(DEFAULT_FORM);
      setPortInputs({ port: "22", gateway_port: "22", destination_port: "22", local_port: "" });
      setConnectionType("direct");
      setAuthMethod("credential");
    }
    setPortErrors({});
    setFieldErrors({});
    setInlineUsername("");
    setInlinePassword("");
    setInlineKeyPath("");
    setInlinePassphrase("");
    setInlineCredentialName("");
    setSaveCredential(false);
  }, [connection, open, isClone]);

  // Snapshot of the form state at "freshly opened" or "freshly reset"
  // so we can detect whether the user has made any changes worth
  // guarding on close. The snapshot is recomputed in the SAME effect
  // that initializes the form so it always reflects the post-init
  // values, never a stale render.
  const baselineRef = useRef<string>("");
  useEffect(() => {
    // Defer to next tick so the setState calls above have flushed.
    const id = setTimeout(() => {
      baselineRef.current = serializeFormState({
        form,
        portInputs,
        connectionType,
        authMethod,
        inlineUsername,
        inlinePassword,
        inlineKeyPath,
        inlinePassphrase,
        inlineCredentialName,
        saveCredential,
      });
    }, 0);
    return () => clearTimeout(id);
    // We only want to re-baseline when the dialog opens or the
    // backing connection changes — NOT on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, isClone]);

  const currentSnapshot = serializeFormState({
    form,
    portInputs,
    connectionType,
    authMethod,
    inlineUsername,
    inlinePassword,
    inlineKeyPath,
    inlinePassphrase,
    inlineCredentialName,
    saveCredential,
  });
  const dirty = open && currentSnapshot !== baselineRef.current && baselineRef.current !== "";

  const guard = useUnsavedChangesGuard(dirty);
  const requestCloseDialog = () => guard.requestClose(() => onOpenChange(false));

  const isTunnel = connectionType !== "direct";
  const needsDestinationAuth = connectionType !== "port_forward";

  const defaultCredentialName = (method: AuthMethod) => {
    const base = form.name.trim() || "connection";
    return method === "ssh_key" ? `${base}-key` : `${base}-cred`;
  };

  const validateNamedCredential = (method: AuthMethod) => {
    if (!saveCredential) {
      return;
    }
    const name = inlineCredentialName.trim();
    if (!name) {
      throw new Error("Credential name is required when saving");
    }
    if (credentials.some((c) => c.name === name)) {
      throw new Error(`A credential named '${name}' already exists`);
    }
    if (method === "ssh_key" && !inlineKeyPath) {
      throw new Error("Private key path is required");
    }
  };

  /*
   * React 19: form-level error owned by useActionState; pending state
   * comes from the action runner. Field-level errors (port and
   * `fieldErrors`) stay in plain state — per AGENTS.md / migration plan.
   */
  type SubmitState = { error: string | null };
  const initialSubmitState: SubmitState = { error: null };
  const [{ error }, submitAction, isSubmitting] = useActionState<SubmitState>(
    async () => {
      try {
        // Validate every port input that is relevant for the active
        // connection type. Empty is allowed for `local_port` only when
        // we're not in port_forward mode (the kind-specific check
        // further down catches required-but-empty local_port).
        const portChecks: { key: PortKey; required: boolean; label: string }[] = [];
        if (connectionType === "direct") {
          portChecks.push({ key: "port", required: true, label: "Port" });
        }
        if (isTunnel) {
          portChecks.push({ key: "gateway_port", required: true, label: "Gateway port" });
          portChecks.push({ key: "destination_port", required: true, label: "Destination port" });
        }
        if (connectionType === "port_forward") {
          portChecks.push({ key: "local_port", required: true, label: "Local port" });
        }
        const newPortErrors: Partial<Record<PortKey, string>> = {};
        const parsedPorts: Partial<Record<PortKey, number>> = {};
        for (const check of portChecks) {
          const raw = portInputs[check.key];
          const parsed = parsePort(raw);
          if (parsed.error) {
            newPortErrors[check.key] = parsed.error;
          } else if (parsed.value === null && check.required) {
            newPortErrors[check.key] = `${check.label} is required`;
          } else if (parsed.value !== null) {
            parsedPorts[check.key] = parsed.value;
          }
        }
        if (Object.keys(newPortErrors).length > 0) {
          setPortErrors(newPortErrors);
          throw new Error("Please fix the highlighted port fields");
        }
        // Apply validated ports back into `form` so the rest of the
        // submit path sees the user's intended values.
        const formWithPorts = {
          ...form,
          port: parsedPorts.port ?? form.port,
          gateway_port: parsedPorts.gateway_port ?? form.gateway_port,
          destination_port: parsedPorts.destination_port ?? form.destination_port,
          local_port: parsedPorts.local_port ?? form.local_port,
        };
        // Mutate `form` reference for the rest of the submit code path
        // (which still reads from the closure) by reassigning via setForm
        // and using formWithPorts locally.
        // (We don't await the state update — the local copy is enough.)
        setForm(formWithPorts);

        let credentialId = formWithPorts.credential_id;

        // Auto-create credential for inline auth (only for kinds that need destination auth)
        if (needsDestinationAuth) {
          if (authMethod === "password" && onCreateCredential) {
            if (!inlineUsername) throw new Error("Username is required");
            if (!inlinePassword) throw new Error("Password is required");
            validateNamedCredential(authMethod);
            const isPrivate = !saveCredential;
            const credName = saveCredential
              ? inlineCredentialName.trim()
              : `inline-${crypto.randomUUID()}`;
            const cred = await onCreateCredential({
              name: credName,
              username: inlineUsername,
              type: "password",
              password: inlinePassword,
              is_private: isPrivate,
            });
            credentialId = cred.id;
          } else if (authMethod === "ssh_key" && onCreateCredential) {
            if (!inlineUsername) throw new Error("Username is required");
            if (!inlineKeyPath) throw new Error("Private key path is required");
            validateNamedCredential(authMethod);
            const isPrivate = !saveCredential;
            const credName = saveCredential
              ? inlineCredentialName.trim()
              : `inline-${crypto.randomUUID()}`;
            const cred = await onCreateCredential({
              name: credName,
              username: inlineUsername,
              type: "ssh_key",
              private_key_path: inlineKeyPath,
              passphrase: inlinePassphrase || undefined,
              is_private: isPrivate,
            });
            credentialId = cred.id;
          }
        } else {
          // PortForward has no destination credential.
          credentialId = undefined;
        }

        // Required text fields (name + host(s) + gateway credential).
        // Collect all of them so the user sees every problem at once
        // instead of one-at-a-time throw cycling.
        const newFieldErrors: Partial<Record<FieldKey, string>> = {};
        if (!formWithPorts.name.trim()) {
          newFieldErrors.name = "Connection name is required";
        }
        if (connectionType === "direct" && !formWithPorts.host.trim()) {
          newFieldErrors.host = "Host is required";
        }
        if (isTunnel) {
          if (!formWithPorts.gateway_host || !formWithPorts.gateway_host.trim()) {
            newFieldErrors.gateway_host = "Gateway host is required";
          }
          if (!formWithPorts.gateway_credential_id) {
            newFieldErrors.gateway_credential_id = "Gateway credential is required";
          }
          if (!formWithPorts.destination_host || !formWithPorts.destination_host.trim()) {
            newFieldErrors.destination_host = "Destination host is required";
          }
        }
        if (Object.keys(newFieldErrors).length > 0) {
          setFieldErrors(newFieldErrors);
          throw new Error("Please fix the highlighted fields");
        }

        // Validation per kind.
        if (connectionType === "port_forward") {
          if (!formWithPorts.local_port)
            throw new Error("Local port is required for port forwarding");
        }
        if (connectionType === "jump_shell" && !credentialId) {
          throw new Error("Destination credential is required for jump shell");
        }

        // Mirror destination_host/port into top-level host/port for tunnel kinds so
        // list views can keep displaying a meaningful "host" label.
        const effectiveHost = isTunnel ? (formWithPorts.destination_host ?? "") : formWithPorts.host;
        const effectivePort = isTunnel
          ? (formWithPorts.destination_port ?? 22)
          : formWithPorts.port;

        // Audit-4 Phase 4b: build a flat draft, then narrow on `connectionType`
        // to a discriminated `Connection`. The `as Omit<Connection, "id">` casts
        // are sound because each branch sets exactly the fields its variant
        // requires (and excludes the others).
        const baseFields = {
          name: formWithPorts.name,
          host: effectiveHost,
          port: effectivePort,
          credential_id: credentialId,
          verbosity: formWithPorts.verbosity ?? 0,
          extra_args: formWithPorts.extra_args || undefined,
          login_command: formWithPorts.login_command || undefined,
          remote_path: formWithPorts.remote_path || undefined,
          tags: formWithPorts.tags ?? [],
          color: formWithPorts.color,
        };

        const data: ConnectionInput =
          connectionType === "direct"
            ? { ...baseFields, type: "direct" }
            : connectionType === "port_forward"
            ? {
                ...baseFields,
                type: "port_forward",
                gateway_host: formWithPorts.gateway_host ?? "",
                gateway_port: formWithPorts.gateway_port ?? 22,
                gateway_credential_id: formWithPorts.gateway_credential_id ?? "",
                local_port: formWithPorts.local_port ?? 0,
                destination_host: formWithPorts.destination_host ?? "",
                destination_port: formWithPorts.destination_port ?? 22,
              }
            : {
                // jump_shell
                ...baseFields,
                type: "jump_shell",
                gateway_host: formWithPorts.gateway_host ?? "",
                gateway_port: formWithPorts.gateway_port ?? 22,
                gateway_credential_id: formWithPorts.gateway_credential_id ?? "",
                destination_host: formWithPorts.destination_host ?? "",
                destination_port: formWithPorts.destination_port ?? 22,
              };

        if (connection && !isClone) {
          await onSubmit({ ...data, id: connection.id } as Connection);
        } else {
          await onSubmit(data);
        }
        // Suppress the unsaved-changes guard for the close that follows
        // a successful save.
        guard.markSaved();
        onOpenChange(false);
        return { error: null };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    initialSubmitState,
  );

  // Mask the action's persistent `error` after the dialog closes/reopens.
  // useActionState exposes no setter, so we track an epoch toggled by the
  // open prop and only show the error if it was produced inside the
  // current open-cycle.
  const [errorEpoch, setErrorEpoch] = useState(0);
  const [errorEpochSeen, setErrorEpochSeen] = useState(0);
  useEffect(() => {
    if (open) {
      setErrorEpoch((e) => e + 1);
    }
  }, [open]);
  useEffect(() => {
    if (error) setErrorEpochSeen(errorEpoch);
  }, [error, errorEpoch]);
  const visibleError = error && errorEpochSeen === errorEpoch ? error : null;

  const title = isClone
    ? "Clone Connection"
    : connection
    ? "Edit Connection"
    : "New Connection";

  const selectedCredential = credentials.find((c) => c.id === form.credential_id);
  const canInstallKey =
    selectedCredential?.type === "ssh_key" && form.host.trim().length > 0;
  const [installOpen, setInstallOpen] = useState(false);

  const credentialPicker = (
    <div className="space-y-2">
      <Select
        value={form.credential_id ?? "none"}
        onValueChange={(v) =>
          setForm({
            ...form,
            credential_id: v === "none" ? undefined : v,
          })
        }
      >
        <SelectTrigger data-testid="connection-form-credential">
          <SelectValue placeholder="Select credential..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none" data-name="None">None</SelectItem>
          {credentials.map((cred) => (
            <SelectItem key={cred.id} value={cred.id} data-name={cred.name}>
              {cred.name} ({cred.username})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {canInstallKey && selectedCredential && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setInstallOpen(true)}
          >
            <UploadCloud className="h-3.5 w-3.5 mr-1.5" />
            Install on remote
          </Button>
          <InstallKeyDialog
            open={installOpen}
            onOpenChange={setInstallOpen}
            credentialId={selectedCredential.id}
            defaultHost={form.host}
            defaultPort={parsePort(portInputs.port).value ?? form.port}
            defaultUsername={selectedCredential.username}
          />
        </>
      )}
    </div>
  );

  const gatewayBlock = (
    <div className="rounded-lg border p-4 space-y-4">
      <p className="text-sm font-medium text-muted-foreground">Gateway</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="gateway_host">Gateway Host *</Label>
          <Input
            id="gateway_host"
            placeholder="gateway.example.com"
            value={form.gateway_host ?? ""}
            onChange={(e) => {
              setForm({ ...form, gateway_host: e.target.value });
              clearFieldError("gateway_host");
            }}
            data-testid="connection-form-gateway"
            aria-invalid={fieldErrors.gateway_host ? true : undefined}
            aria-describedby={fieldErrors.gateway_host ? "gateway_host-error" : undefined}
          />
          {fieldErrors.gateway_host && (
            <p id="gateway_host-error" role="alert" className="text-xs text-destructive">
              {fieldErrors.gateway_host}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="gateway_port">Gateway Port</Label>
          <Input
            id="gateway_port"
            type="text"
            inputMode="numeric"
            placeholder="22"
            value={portInputs.gateway_port}
            onChange={(e) => updatePort("gateway_port", e.target.value)}
            aria-invalid={portErrors.gateway_port ? true : undefined}
            aria-describedby={portErrors.gateway_port ? "gateway_port-error" : undefined}
          />
          {portErrors.gateway_port && (
            <p
              id="gateway_port-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {portErrors.gateway_port}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="gateway_credential">Gateway Credential *</Label>
        <Select
          value={form.gateway_credential_id ?? "none"}
          onValueChange={(v) => {
            setForm({
              ...form,
              gateway_credential_id: v === "none" ? undefined : v,
            });
            clearFieldError("gateway_credential_id");
          }}
        >
          <SelectTrigger
            id="gateway_credential"
            data-testid="connection-form-dest-credential"
            aria-invalid={fieldErrors.gateway_credential_id ? true : undefined}
            aria-describedby={
              fieldErrors.gateway_credential_id ? "gateway_credential-error" : undefined
            }
          >
            <SelectValue placeholder="Select credential..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none" data-name="None">None</SelectItem>
            {credentials.map((cred) => (
              <SelectItem key={cred.id} value={cred.id} data-name={cred.name}>
                {cred.name} ({cred.username})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {fieldErrors.gateway_credential_id && (
          <p id="gateway_credential-error" role="alert" className="text-xs text-destructive">
            {fieldErrors.gateway_credential_id}
          </p>
        )}
      </div>
    </div>
  );

  const destinationBlock = (
    <div className="rounded-lg border p-4 space-y-4">
      <p className="text-sm font-medium text-muted-foreground">Destination</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="destination_host">Destination Host *</Label>
          <Input
            id="destination_host"
            placeholder={
              connectionType === "port_forward"
                ? "api.internal"
                : "internal.example.com"
            }
            value={form.destination_host ?? ""}
            onChange={(e) => {
              setForm({ ...form, destination_host: e.target.value });
              clearFieldError("destination_host");
            }}
            data-testid="connection-form-dest-host"
            aria-invalid={fieldErrors.destination_host ? true : undefined}
            aria-describedby={
              fieldErrors.destination_host ? "destination_host-error" : undefined
            }
          />
          {fieldErrors.destination_host && (
            <p id="destination_host-error" role="alert" className="text-xs text-destructive">
              {fieldErrors.destination_host}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="destination_port">Destination Port</Label>
          <Input
            id="destination_port"
            type="text"
            inputMode="numeric"
            placeholder={connectionType === "port_forward" ? "80" : "22"}
            value={portInputs.destination_port}
            onChange={(e) => updatePort("destination_port", e.target.value)}
            data-testid="connection-form-dest-port"
            aria-invalid={portErrors.destination_port ? true : undefined}
            aria-describedby={portErrors.destination_port ? "destination_port-error" : undefined}
          />
          {portErrors.destination_port && (
            <p
              id="destination_port-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {portErrors.destination_port}
            </p>
          )}
        </div>
      </div>
    </div>
  );

  const localPortBlock = (
    <div className="space-y-2">
      <Label htmlFor="local_port">Local Port *</Label>
      <Input
        id="local_port"
        type="text"
        inputMode="numeric"
        placeholder="9000"
        value={portInputs.local_port}
        onChange={(e) => updatePort("local_port", e.target.value)}
        data-testid="connection-form-local-port"
        aria-invalid={portErrors.local_port ? true : undefined}
        aria-describedby={
          portErrors.local_port ? "local_port-error" : "local_port-help"
        }
      />
      {portErrors.local_port ? (
        <p id="local_port-error" role="alert" className="text-xs text-destructive">
          {portErrors.local_port}
        </p>
      ) : (
        <p id="local_port-help" className="text-xs text-muted-foreground">
          SSX will listen on <code>127.0.0.1:&lt;local_port&gt;</code> and forward
          connections through the gateway to the destination.
        </p>
      )}
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          onOpenChange(true);
          return;
        }
        // Intercept Esc / click-outside attempts to close so we can
        // prompt for unsaved changes.
        requestCloseDialog();
      }}
    >
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b">
          <DialogTitle>{title}</DialogTitle>
          {/* P1#5: sr-only description so the dialog has a wired aria-describedby. */}
          <DialogDescription className="sr-only">
            {connection
              ? isClone
                ? "Duplicate this connection's settings into a new entry."
                : "Edit the host, authentication, and other settings for this connection."
              : "Configure a new SSH connection: host, port, authentication, and optional advanced settings."}
          </DialogDescription>
        </DialogHeader>
        <form
          action={submitAction}
          className="flex flex-col flex-1 min-h-0"
          data-testid="connection-form"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          <Tabs
            value={connectionType}
            onValueChange={(v) => setConnectionType(v as ConnectionType)}
          >
            <TabsList className="w-full">
              <TabsTrigger value="direct" className="flex-1" data-testid="connection-form-kind-direct">
                Direct
              </TabsTrigger>
              <TabsTrigger value="port_forward" className="flex-1" data-testid="connection-form-kind-portforward">
                Port Forward
              </TabsTrigger>
              <TabsTrigger value="jump_shell" className="flex-1" data-testid="connection-form-kind-jumpshell">
                Jump Shell
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Name is always shown */}
          <div className="space-y-2">
            <Label htmlFor="name">Connection Name *</Label>
            <Input
              id="name"
              placeholder="my-server"
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                clearFieldError("name");
              }}
              required
              data-testid="connection-form-name"
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? "name-error" : undefined}
            />
            {fieldErrors.name && (
              <p id="name-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.name}
              </p>
            )}
          </div>

          {/* Direct: top-level host/port */}
          {connectionType === "direct" && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="host">Host *</Label>
                <Input
                  id="host"
                  placeholder="192.168.1.1"
                  value={form.host}
                  onChange={(e) => {
                    setForm({ ...form, host: e.target.value });
                    clearFieldError("host");
                  }}
                  required
                  data-testid="connection-form-host"
                  aria-invalid={fieldErrors.host ? true : undefined}
                  aria-describedby={fieldErrors.host ? "host-error" : undefined}
                />
                {fieldErrors.host && (
                  <p id="host-error" role="alert" className="text-xs text-destructive">
                    {fieldErrors.host}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port"
                  type="text"
                  inputMode="numeric"
                  placeholder="22"
                  value={portInputs.port}
                  onChange={(e) => updatePort("port", e.target.value)}
                  data-testid="connection-form-port"
                  aria-invalid={portErrors.port ? true : undefined}
                  aria-describedby={portErrors.port ? "port-error" : undefined}
                />
                {portErrors.port && (
                  <p id="port-error" role="alert" className="text-xs text-destructive">
                    {portErrors.port}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Tunnel kinds: gateway + destination */}
          {isTunnel && (
            <>
              {gatewayBlock}
              {destinationBlock}
              {connectionType === "port_forward" && localPortBlock}
            </>
          )}

          {/* Auth section (skipped for port_forward) */}
          {needsDestinationAuth && (
            <div className="space-y-3">
              <Label>
                {connectionType === "jump_shell"
                  ? "Destination Authentication"
                  : "Authentication"}
              </Label>
              <Tabs
                value={authMethod}
                onValueChange={(v) => setAuthMethod(v as AuthMethod)}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="credential" className="flex-1 text-xs">
                    Saved Credential
                  </TabsTrigger>
                  <TabsTrigger value="password" className="flex-1 text-xs">
                    Password
                  </TabsTrigger>
                  <TabsTrigger value="ssh_key" className="flex-1 text-xs">
                    SSH Key
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="credential" className="space-y-3 mt-3">
                  {credentialPicker}
                </TabsContent>

                <TabsContent value="password" className="space-y-3 mt-3">
                  <div className="space-y-2">
                    <Label htmlFor="inline-username">Username *</Label>
                    <Input
                      id="inline-username"
                      placeholder="root"
                      value={inlineUsername}
                      onChange={(e) => setInlineUsername(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="inline-password">Password *</Label>
                    <PasswordInput
                      id="inline-password"
                      placeholder="••••••••"
                      value={inlinePassword}
                      onChange={(e) => setInlinePassword(e.target.value)}
                    />
                  </div>
                  {/*
                    Audit-3 follow-up P1#2: replaced the bare
                    <input type="checkbox" className="accent-primary">
                    with the shared <Checkbox> primitive (Radix-
                    backed). The native checkbox bypassed the
                    focus-visible ring, theme tokens, and rendered
                    differently on every OS — same contract pinned
                    by AGENTS.md and previously fixed in ScpDialog.
                  */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="conn-save-credential-password"
                      checked={saveCredential}
                      onCheckedChange={(v) => {
                        const checked = v === true;
                        setSaveCredential(checked);
                        if (!checked) {
                          setInlineCredentialName("");
                        } else if (!inlineCredentialName) {
                          setInlineCredentialName(defaultCredentialName("password"));
                        }
                      }}
                    />
                    <Label
                      htmlFor="conn-save-credential-password"
                      className="text-xs text-muted-foreground font-normal cursor-pointer select-none"
                    >
                      Save as a named credential (visible in the Credentials list)
                    </Label>
                  </div>
                  {saveCredential && (
                    <div className="space-y-2">
                      <Label htmlFor="password-cred-name">
                        Credential Name *
                      </Label>
                      <Input
                        id="password-cred-name"
                        placeholder="server-cred"
                        value={inlineCredentialName}
                        onChange={(e) => setInlineCredentialName(e.target.value)}
                      />
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="ssh_key" className="space-y-3 mt-3">
                  <div className="space-y-2">
                    <Label htmlFor="key-username">Username *</Label>
                    <Input
                      id="key-username"
                      placeholder="root"
                      value={inlineUsername}
                      onChange={(e) => setInlineUsername(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="key-path">Private Key Path *</Label>
                    <Input
                      id="key-path"
                      placeholder="~/.ssh/id_rsa"
                      value={inlineKeyPath}
                      onChange={(e) => setInlineKeyPath(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="key-passphrase">Passphrase (optional)</Label>
                    <PasswordInput
                      id="key-passphrase"
                      placeholder="••••••••"
                      value={inlinePassphrase}
                      onChange={(e) => setInlinePassphrase(e.target.value)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="conn-save-credential-key"
                      checked={saveCredential}
                      onCheckedChange={(v) => {
                        const checked = v === true;
                        setSaveCredential(checked);
                        if (!checked) {
                          setInlineCredentialName("");
                        } else if (!inlineCredentialName) {
                          setInlineCredentialName(defaultCredentialName("ssh_key"));
                        }
                      }}
                    />
                    <Label
                      htmlFor="conn-save-credential-key"
                      className="text-xs text-muted-foreground font-normal cursor-pointer select-none"
                    >
                      Save as a named credential (visible in the Credentials list)
                    </Label>
                  </div>
                  {saveCredential && (
                    <div className="space-y-2">
                      <Label htmlFor="ssh-cred-name">
                        Credential Name *
                      </Label>
                      <Input
                        id="ssh-cred-name"
                        placeholder="server-key"
                        value={inlineCredentialName}
                        onChange={(e) => setInlineCredentialName(e.target.value)}
                      />
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}

          {/* Tags */}
          <div className="space-y-2">
            <Label htmlFor="tags">Tags</Label>
            <TagInput
              id="tags"
              value={form.tags ?? []}
              onChange={(tags) => setForm({ ...form, tags })}
              placeholder="Press Enter or comma to add a tag"
              aria-describedby="tags-hint"
            />
            <p id="tags-hint" className="text-xs text-muted-foreground">
              Used for filtering — matches in the Connections search box.
            </p>
          </div>

          {/* Color */}
          {/*
            Audit-3 follow-up P0#1: this picker MUST be a Radix
            RadioGroup (per AGENTS.md). Previously it was a hand-rolled
            <button> grid with title-only labels — each swatch announced
            as an unlabeled button to screen readers, and the group had
            no semantics. The "None" option uses the literal string
            "__none__" as its RadioGroupItem value because Radix
            RadioGroup requires every option to have a non-empty string
            value (an empty value is treated as "no selection") — we
            translate it back to `undefined` on `onValueChange` so the
            persisted Connection model is unchanged.
          */}
          <div className="space-y-2">
            <h3 id="conn-color-heading" className="text-sm font-medium">
              Color
            </h3>
            <RadioGroup
              aria-labelledby="conn-color-heading"
              value={form.color ?? "__none__"}
              onValueChange={(v) =>
                setForm({ ...form, color: v === "__none__" ? undefined : v })
              }
              className="flex flex-wrap gap-2"
            >
              <RadioGroupItem
                value="__none__"
                aria-label="No color"
                className={cn(
                  "px-2 py-1 text-xs rounded-md border transition-colors",
                  "data-[state=checked]:border-primary data-[state=checked]:bg-accent",
                  "data-[state=unchecked]:border-input data-[state=unchecked]:text-muted-foreground data-[state=unchecked]:hover:text-foreground",
                )}
              >
                None
              </RadioGroupItem>
              {OPEN_COLORS.map((c) => (
                <RadioGroupItem
                  key={c}
                  value={c}
                  aria-label={c}
                  className={cn(
                    "h-7 w-7 rounded-full border transition-all",
                    "data-[state=checked]:ring-2 data-[state=checked]:ring-primary data-[state=checked]:ring-offset-2 data-[state=checked]:ring-offset-background",
                    "data-[state=unchecked]:border-transparent data-[state=unchecked]:hover:scale-110",
                  )}
                  style={{ backgroundColor: COLOR_VALUES[c] }}
                />
              ))}
            </RadioGroup>
            <p id="conn-color-help" className="text-xs text-muted-foreground-soft">
              Used as the terminal-tab accent.
            </p>
          </div>

          {/* Advanced options */}
          <div className="space-y-2">
            <Label htmlFor="extra_args">Additional SSH Arguments</Label>
            <Input
              id="extra_args"
              placeholder="-C (compression)"
              value={form.extra_args ?? ""}
              onChange={(e) => setForm({ ...form, extra_args: e.target.value })}
              aria-describedby="extra_args-hint"
            />
            <p id="extra_args-hint" className="text-xs text-muted-foreground">
              Pass extra flags to the SSH session (e.g. <code>-C</code> to
              enable compression). Unknown flags are ignored.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="login_command">Login Command</Label>
            <Input
              id="login_command"
              placeholder="sudo su - deploy"
              value={form.login_command ?? ""}
              onChange={(e) => setForm({ ...form, login_command: e.target.value })}
              aria-describedby="login_command-hint"
            />
            <p id="login_command-hint" className="text-xs text-muted-foreground">
              Runs after login. Useful for switching users or bootstrapping a shell.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="remote_path">Remote Path</Label>
            <Input
              id="remote_path"
              placeholder="/srv/app"
              value={form.remote_path ?? ""}
              onChange={(e) => setForm({ ...form, remote_path: e.target.value })}
              aria-describedby="remote_path-hint"
            />
            <p id="remote_path-hint" className="text-xs text-muted-foreground">
              Preferred starting directory for shells and default base path for SCP transfers.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="verbosity">Verbosity Level</Label>
            <Select
              value={String(form.verbosity ?? 0)}
              onValueChange={(v) =>
                setForm({ ...form, verbosity: parseInt(v) })
              }
            >
              <SelectTrigger id="verbosity" aria-describedby="verbosity-hint">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0 — Silent (default)</SelectItem>
                <SelectItem value="1">1 — Info (connection events)</SelectItem>
                <SelectItem value="2">2 — Debug (full SSH protocol trace)</SelectItem>
              </SelectContent>
            </Select>
            <p id="verbosity-hint" className="text-xs text-muted-foreground">
              Level 1 prints connection lifecycle messages (handshake,
              authentication, channel open) to the terminal. Level 2 also
              emits a low-level SSH protocol trace — useful for diagnosing
              auth or transport failures, but very noisy.
            </p>
          </div>

          {visibleError && (
            <p
              role="alert"
              aria-live="assertive"
              id="connection-form-error"
              className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md"
            >
              {visibleError}
            </p>
          )}
          </div>

          <DialogFooter className="px-6 py-3 border-t bg-background shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={requestCloseDialog}
              disabled={isSubmitting}
              data-testid="connection-form-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
              data-testid="connection-form-submit"
              aria-describedby={visibleError ? "connection-form-error" : undefined}
            >
              {isSubmitting
                ? "Saving..."
                : isClone
                ? "Clone"
                : connection
                ? "Update"
                : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      <ConfirmDialog
        open={guard.confirmOpen}
        onOpenChange={(o) => {
          if (!o) guard.cancelDiscard();
        }}
        title="Discard unsaved changes?"
        description="You have unsaved changes to this connection. Discard them and close the form?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        variant="destructive"
        onConfirm={guard.confirmDiscard}
      />
    </Dialog>
  );
}
