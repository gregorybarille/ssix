import { errorMessage } from "@/lib/errors";
import { log as appLog } from "@/lib/log";
import { useActionState, useState, useEffect, useRef } from "react";
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
import {
  CredentialSelect,
  FieldError,
  invalidAria,
  PortField,
  SaveCredentialFields,
} from "./ConnectionFormFields";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { credentialFieldErrors, type CredentialFieldKey } from "@/lib/credentialValidation";
import { KIND_FLAGS, KIND_LABELS, hopTerms, titleCase } from "@/lib/sshTerms";
import { InstallKeyDialog } from "./InstallKeyDialog";
import { TagInput } from "./ui/tag-input";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { COLOR_VALUES } from "@/lib/colors";
import { parsePort } from "@/lib/port";
import { detectPlatform, WSL_PROXY_COMMAND } from "@/lib/platform";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { submitWithoutReset } from "@/lib/formSubmit";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { useDialogsStore } from "@/store/useDialogsStore";
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
  /**
   * Delete a credential the form created for inline auth when the
   * connection save that needed it is refused, so retries never pile up
   * unused credentials.
   */
  onDiscardCredential?: (id: string) => Promise<void>;
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
  proxy_command: "",
  login_command: "",
  remote_path: "",
  tags: [],
  color: undefined,
};

const EMPTY_INLINE = {
  inlineUsername: "",
  inlinePassword: "",
  inlineKeyPath: "",
  inlinePassphrase: "",
  inlineCredentialName: "",
  saveCredential: false,
};

type PortInputs = Record<"port" | "gateway_port" | "destination_port" | "local_port", string>;

const DEFAULT_PORT_INPUTS: PortInputs = {
  port: "22",
  gateway_port: "22",
  destination_port: "22",
  local_port: "",
};

/**
 * The form state for a freshly opened dialog: the defaults for a new
 * connection, or the saved connection's values when editing / cloning.
 * Pure, so the init effect and the unsaved-changes baseline share it.
 */
function initialFormState(
  connection: Connection | null | undefined,
  isClone: boolean,
): {
  form: ConnectionDraft;
  portInputs: PortInputs;
  connectionType: ConnectionType;
  authMethod: AuthMethod;
} {
  if (!connection) {
    return {
      form: DEFAULT_FORM,
      portInputs: DEFAULT_PORT_INPUTS,
      connectionType: "direct",
      authMethod: "credential",
    };
  }
  // Gateway/destination fields only exist on port_forward and jump_shell
  // variants; a narrowing switch keeps TS from poking DirectConnection.
  const form: ConnectionDraft = {
    name: isClone ? `${connection.name} (copy)` : connection.name,
    host: connection.host,
    port: connection.port,
    credential_id: connection.credential_id,
    type: connection.type,
    verbosity: connection.verbosity ?? 0,
    extra_args: connection.extra_args ?? "",
    proxy_command: connection.proxy_command ?? "",
    login_command: connection.login_command ?? "",
    remote_path: connection.remote_path ?? "",
    tags: connection.tags ?? [],
    color: connection.color,
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
  };
  return {
    form,
    portInputs: {
      port: String(connection.port ?? 22),
      gateway_port: String(connection.type !== "direct" ? connection.gateway_port : 22),
      destination_port: String(connection.type !== "direct" ? connection.destination_port : 22),
      local_port: connection.type === "port_forward" ? String(connection.local_port) : "",
    },
    connectionType: connection.type,
    authMethod: "credential",
  };
}

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
    s.form.proxy_command ?? "",
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

/** The verbosity choices, named after the `ssh` flags they match. */
const VERBOSITY_LEVELS = [
  { value: 0, label: "Quiet (default)" },
  { value: 1, label: "-v (connection steps)" },
  { value: 2, label: "-vv (negotiated algorithms)" },
  { value: 3, label: "-vvv (everything)" },
] as const;


export function ConnectionForm({
  open,
  onOpenChange,
  connection,
  credentials,
  onSubmit,
  onCreateCredential,
  onDiscardCredential,
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
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Port inputs are managed as raw strings so we can validate without
  // silently coercing invalid input back to 22. The keys mirror the
  // numeric port field names on `Connection`.
  type PortKey = keyof PortInputs;
  const [portInputs, setPortInputs] = useState<PortInputs>(DEFAULT_PORT_INPUTS);
  const [portErrors, setPortErrors] = useState<Partial<Record<PortKey, string>>>({});

  // Inline per-field errors for required fields, cleared as the user
  // edits. The `inline_*` keys belong to the Password / SSH Key tabs and
  // come from the same checks as the credential form.
  type FieldKey =
    | "name"
    | "host"
    | "gateway_host"
    | "destination_host"
    | "gateway_credential_id"
    | "credential_id"
    | `inline_${CredentialFieldKey}`;
  const { fieldErrors, setFieldErrors, clearFieldError } = useFieldErrors<FieldKey>();

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

  // Snapshot of the form state at "freshly opened" or "freshly reset" so
  // we can detect whether the user has made any changes worth guarding on
  // close. It is derived from the same values the effect below writes
  // into state, so it can never be a stale snapshot of the previous render.
  const baselineRef = useRef<string>("");
  useEffect(() => {
    const init = initialFormState(connection, isClone);
    setForm(init.form);
    setPortInputs(init.portInputs);
    setConnectionType(init.connectionType);
    setAuthMethod(init.authMethod);
    setPortErrors({});
    setFieldErrors({});
    setInlineUsername(EMPTY_INLINE.inlineUsername);
    setInlinePassword(EMPTY_INLINE.inlinePassword);
    setInlineKeyPath(EMPTY_INLINE.inlineKeyPath);
    setInlinePassphrase(EMPTY_INLINE.inlinePassphrase);
    setInlineCredentialName(EMPTY_INLINE.inlineCredentialName);
    setSaveCredential(EMPTY_INLINE.saveCredential);
    baselineRef.current = serializeFormState({ ...init, ...EMPTY_INLINE });
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

  // The list stays visible beside this panel; opening another editor from
  // it asks before replacing unsaved changes.
  const setConnFormGuard = useDialogsStore((s) => s.setConnFormGuard);
  const { requestClose } = guard;
  useEffect(() => {
    if (!open) return;
    setConnFormGuard((proceed) => requestClose(proceed));
    return () => setConnFormGuard(null);
  }, [open, requestClose, setConnFormGuard]);

  const isTwoHop = connectionType !== "direct";
  const isWindows = detectPlatform() === "windows";
  // OpenSSH's names for the two hosts of the current kind (direct has none).
  const terms = hopTerms(connectionType === "port_forward" ? "port_forward" : "jump_shell");
  const needsTargetAuth = connectionType !== "port_forward";

  const defaultCredentialName = (method: AuthMethod) => {
    const base = form.name.trim() || "connection";
    return method === "ssh_key" ? `${base}-key` : `${base}-cred`;
  };

  /**
   * Required-field errors for the target authentication: a saved
   * credential must be picked, and an inline one must pass the same checks
   * as the credential form.
   */
  const authFieldErrors = (credentialId: string | undefined): Partial<Record<FieldKey, string>> => {
    if (authMethod === "credential") {
      if (credentialId) return {};
      return {
        credential_id:
          connectionType === "jump_shell"
            ? "Target credential is required"
            : "Credential is required",
      };
    }
    const inline = credentialFieldErrors(
      {
        name: saveCredential ? inlineCredentialName : null,
        username: inlineUsername,
        type: authMethod,
        password: inlinePassword,
        privateKeyPath: inlineKeyPath,
      },
      { requirePassword: true, takenNames: credentials.map((c) => c.name) },
    );
    const errors: Partial<Record<FieldKey, string>> = {};
    for (const [key, message] of Object.entries(inline)) {
      errors[`inline_${key as CredentialFieldKey}`] = message;
    }
    return errors;
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
        if (isTwoHop) {
          portChecks.push({ key: "gateway_port", required: true, label: terms.hopPort });
          portChecks.push({ key: "destination_port", required: true, label: terms.targetPort });
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

        // Every required field is checked before anything is saved, so the
        // inline credential below is only created for a connection that
        // passes the form's checks. All problems are collected so the user
        // sees them at once instead of one-at-a-time throw cycling.
        const newFieldErrors: Partial<Record<FieldKey, string>> = {};
        if (!formWithPorts.name.trim()) {
          newFieldErrors.name = "Connection name is required";
        }
        if (connectionType === "direct" && !formWithPorts.host.trim()) {
          newFieldErrors.host = "Host is required";
        }
        if (isTwoHop) {
          if (!formWithPorts.gateway_host || !formWithPorts.gateway_host.trim()) {
            newFieldErrors.gateway_host = `${terms.hopHost} is required`;
          }
          if (!formWithPorts.gateway_credential_id) {
            newFieldErrors.gateway_credential_id = `${terms.hopCredential} is required`;
          }
          if (!formWithPorts.destination_host || !formWithPorts.destination_host.trim()) {
            newFieldErrors.destination_host = `${terms.targetHost} is required`;
          }
        }
        if (needsTargetAuth) {
          Object.assign(newFieldErrors, authFieldErrors(formWithPorts.credential_id));
        }
        if (Object.keys(newFieldErrors).length > 0) {
          setFieldErrors(newFieldErrors);
          throw new Error("Please fix the highlighted fields");
        }

        // A local forward has no target credential.
        let credentialId = needsTargetAuth ? formWithPorts.credential_id : undefined;
        let createdCredentialId: string | null = null;
        if (needsTargetAuth && authMethod !== "credential") {
          if (!onCreateCredential) throw new Error("Inline credentials are not available here");
          const cred = await onCreateCredential({
            name: saveCredential ? inlineCredentialName.trim() : `inline-${crypto.randomUUID()}`,
            username: inlineUsername,
            is_private: !saveCredential,
            ...(authMethod === "password"
              ? { type: "password", password: inlinePassword }
              : {
                  type: "ssh_key",
                  private_key_path: inlineKeyPath,
                  passphrase: inlinePassphrase || undefined,
                }),
          });
          credentialId = cred.id;
          createdCredentialId = cred.id;
        }

        // Mirror destination_host/port into top-level host/port for two-hop kinds so
        // list views can keep displaying a meaningful "host" label.
        const effectiveHost = isTwoHop ? (formWithPorts.destination_host ?? "") : formWithPorts.host;
        const effectivePort = isTwoHop
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
          proxy_command: formWithPorts.proxy_command?.trim() || undefined,
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

        try {
          if (connection && !isClone) {
            await onSubmit({ ...data, id: connection.id } as Connection);
          } else {
            await onSubmit(data);
          }
        } catch (err) {
          // The save failed, normally because the backend refused the
          // connection (a taken name, say): drop the credential made for it.
          // This can never remove a credential the connection ended up
          // using: if the failure came after the connection was stored,
          // `delete_credential` refuses a credential in use and the cleanup
          // is only logged. The save's error is what the user sees.
          if (createdCredentialId && onDiscardCredential) {
            await onDiscardCredential(createdCredentialId).catch((cleanupErr: unknown) =>
              appLog.warn(
                "connections",
                `Could not remove the unused inline credential: ${errorMessage(cleanupErr)}`,
              ),
            );
          }
          throw err;
        }
        // Suppress the unsaved-changes guard for the close that follows
        // a successful save.
        guard.markSaved();
        onOpenChange(false);
        return { error: null };
      } catch (err) {
        return { error: errorMessage(err) };
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

  const saveCredentialFields = (
    method: "password" | "ssh_key",
    checkboxId: string,
    nameId: string,
    namePlaceholder: string,
  ) => (
    <SaveCredentialFields
      checkboxId={checkboxId}
      nameId={nameId}
      namePlaceholder={namePlaceholder}
      checked={saveCredential}
      onCheckedChange={(checked) => {
        setSaveCredential(checked);
        clearFieldError("inline_name");
        if (!checked) {
          setInlineCredentialName("");
        } else if (!inlineCredentialName) {
          setInlineCredentialName(defaultCredentialName(method));
        }
      }}
      name={inlineCredentialName}
      onNameChange={(name) => {
        setInlineCredentialName(name);
        clearFieldError("inline_name");
      }}
      error={fieldErrors.inline_name}
      testId="connection-form-save-credential"
    />
  );

  const credentialPicker = (
    <div className="space-y-2">
      <CredentialSelect
        id="credential"
        aria-label={connectionType === "jump_shell" ? "Target credential" : "Credential"}
        required
        credentials={credentials}
        value={form.credential_id}
        onChange={(credential_id) => {
          setForm({ ...form, credential_id });
          clearFieldError("credential_id");
        }}
        testId="connection-form-credential"
        error={fieldErrors.credential_id}
        errorId="credential-error"
      />
      <FieldError
        id="credential-error"
        message={fieldErrors.credential_id}
        testId="connection-form-credential-error"
      />
      {canInstallKey && selectedCredential && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setInstallOpen(true)}
          >
            <UploadCloud className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
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

  const hopBlock = (
    <div className="rounded-lg border p-4 space-y-4">
      <p className="text-sm font-medium text-muted-foreground">{terms.hop}</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="gateway_host">{titleCase(terms.hopHost)} *</Label>
          <Input
            id="gateway_host"
            placeholder={connectionType === "jump_shell" ? "bastion.example.com" : "ssh.example.com"}
            value={form.gateway_host ?? ""}
            onChange={(e) => {
              setForm({ ...form, gateway_host: e.target.value });
              clearFieldError("gateway_host");
            }}
            data-testid="connection-form-hop-host"
            {...invalidAria(fieldErrors.gateway_host, "gateway_host-error")}
          />
          <FieldError id="gateway_host-error" message={fieldErrors.gateway_host} />
        </div>
        <PortField
          id="gateway_port"
          label={titleCase(terms.hopPort)}
          value={portInputs.gateway_port}
          onChange={(raw) => updatePort("gateway_port", raw)}
          error={portErrors.gateway_port}
          testId="connection-form-hop-port"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="gateway_credential">{titleCase(terms.hopCredential)} *</Label>
        <CredentialSelect
          id="gateway_credential"
          credentials={credentials}
          value={form.gateway_credential_id}
          onChange={(gateway_credential_id) => {
            setForm({ ...form, gateway_credential_id });
            clearFieldError("gateway_credential_id");
          }}
          required
          testId="connection-form-hop-credential"
          error={fieldErrors.gateway_credential_id}
          errorId="gateway_credential-error"
        />
        <FieldError id="gateway_credential-error" message={fieldErrors.gateway_credential_id} />
      </div>
    </div>
  );

  const targetBlock = (
    <div className="rounded-lg border p-4 space-y-4">
      <p className="text-sm font-medium text-muted-foreground">{terms.target}</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="destination_host">{titleCase(terms.targetHost)} *</Label>
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
            data-testid="connection-form-target-host"
            {...invalidAria(fieldErrors.destination_host, "destination_host-error")}
          />
          <FieldError id="destination_host-error" message={fieldErrors.destination_host} />
        </div>
        <PortField
          id="destination_port"
          label={titleCase(terms.targetPort)}
          placeholder={connectionType === "port_forward" ? "80" : "22"}
          value={portInputs.destination_port}
          onChange={(raw) => updatePort("destination_port", raw)}
          error={portErrors.destination_port}
          testId="connection-form-target-port"
        />
      </div>
    </div>
  );

  const localPortBlock = (
    <PortField
      id="local_port"
      label="Local Port *"
      placeholder="9000"
      value={portInputs.local_port}
      onChange={(raw) => updatePort("local_port", raw)}
      error={portErrors.local_port}
      testId="connection-form-local-port"
      help={
        <>
          SSIX listens on <code>127.0.0.1:&lt;local port&gt;</code> and forwards each
          connection through the SSH server to the remote host, like{" "}
          <code>ssh -L</code>. The remote host is resolved by the SSH server.
        </>
      }
    />
  );

  const formDescription = connection
    ? isClone
      ? "Duplicate this connection's settings into a new entry."
      : "Edit the host, authentication, and other settings for this connection."
    : "Configure a new SSH connection: host, port, authentication, and optional advanced settings.";

  const kindTabs = (
    <Tabs
      value={connectionType}
      onValueChange={(v) => setConnectionType(v as ConnectionType)}
    >
      <TabsList className="w-full gap-1 rounded-xl bg-muted/70 p-1">
        <TabsTrigger
          value="direct"
          className="flex-1 data-[state=inactive]:bg-transparent data-[state=inactive]:hover:bg-background/70 data-[state=inactive]:hover:text-foreground data-[state=active]:bg-background data-[state=active]:shadow-sm"
          data-testid="connection-form-kind-direct"
        >
          {KIND_LABELS.direct}
        </TabsTrigger>
        <TabsTrigger
          value="port_forward"
          className="flex-1 data-[state=inactive]:bg-transparent data-[state=inactive]:hover:bg-background/70 data-[state=inactive]:hover:text-foreground data-[state=active]:bg-background data-[state=active]:shadow-sm"
          data-testid="connection-form-kind-localforward"
        >
          {KIND_LABELS.port_forward}
          <span aria-hidden="true" className="ml-1 font-mono text-xs text-muted-foreground-soft">
            {KIND_FLAGS.port_forward}
          </span>
        </TabsTrigger>
        <TabsTrigger
          value="jump_shell"
          className="flex-1 data-[state=inactive]:bg-transparent data-[state=inactive]:hover:bg-background/70 data-[state=inactive]:hover:text-foreground data-[state=active]:bg-background data-[state=active]:shadow-sm"
          data-testid="connection-form-kind-jumphost"
        >
          {KIND_LABELS.jump_shell}
          <span aria-hidden="true" className="ml-1 font-mono text-xs text-muted-foreground-soft">
            {KIND_FLAGS.jump_shell}
          </span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  const formFields = (
    <>
      {kindTabs}

      <div className="space-y-2">
        <Label htmlFor="name">Connection Name *</Label>
        <Input
          id="name"
          ref={firstFieldRef}
          placeholder="my-server"
          value={form.name}
          onChange={(e) => {
            setForm({ ...form, name: e.target.value });
            clearFieldError("name");
          }}
          required
          data-testid="connection-form-name"
          {...invalidAria(fieldErrors.name, "name-error")}
        />
        <FieldError id="name-error" message={fieldErrors.name} />
      </div>

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
              {...invalidAria(fieldErrors.host, "host-error")}
            />
            <FieldError id="host-error" message={fieldErrors.host} />
          </div>
          <PortField
            id="port"
            label="Port"
            value={portInputs.port}
            onChange={(raw) => updatePort("port", raw)}
            error={portErrors.port}
            testId="connection-form-port"
          />
        </div>
      )}

      {isTwoHop && (
        <>
          {hopBlock}
          {targetBlock}
          {connectionType === "port_forward" && localPortBlock}
        </>
      )}

      {needsTargetAuth && (
        <div className="space-y-3">
          <Label>
            {connectionType === "jump_shell"
              ? "Target Authentication"
              : "Authentication"}
          </Label>
          <Tabs
            value={authMethod}
            onValueChange={(v) => {
              setAuthMethod(v as AuthMethod);
              // The previous tab's messages describe a submit made with
              // another method; the next submit checks this one afresh.
              setFieldErrors((errs) =>
                Object.fromEntries(
                  Object.entries(errs).filter(
                    ([key]) => key !== "credential_id" && !key.startsWith("inline_"),
                  ),
                ),
              );
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger value="credential" className="flex-1 text-xs">
                Saved Credential
              </TabsTrigger>
              <TabsTrigger
                value="password"
                className="flex-1 text-xs"
                data-testid="connection-form-auth-password"
              >
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
                  data-testid="connection-form-inline-username"
                  placeholder="root"
                  value={inlineUsername}
                  onChange={(e) => {
                    setInlineUsername(e.target.value);
                    clearFieldError("inline_username");
                  }}
                  aria-required="true"
                  {...invalidAria(fieldErrors.inline_username, "inline-username-error")}
                />
                <FieldError id="inline-username-error" message={fieldErrors.inline_username} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inline-password">Password *</Label>
                <PasswordInput
                  id="inline-password"
                  data-testid="connection-form-inline-password"
                  placeholder="••••••••"
                  value={inlinePassword}
                  onChange={(e) => {
                    setInlinePassword(e.target.value);
                    clearFieldError("inline_password");
                  }}
                  aria-required="true"
                  {...invalidAria(fieldErrors.inline_password, "inline-password-error")}
                />
                <FieldError id="inline-password-error" message={fieldErrors.inline_password} />
              </div>
              {saveCredentialFields("password", "conn-save-credential-password", "password-cred-name", "server-cred")}
            </TabsContent>

            <TabsContent value="ssh_key" className="space-y-3 mt-3">
              <div className="space-y-2">
                <Label htmlFor="key-username">Username *</Label>
                <Input
                  id="key-username"
                  placeholder="root"
                  value={inlineUsername}
                  onChange={(e) => {
                    setInlineUsername(e.target.value);
                    clearFieldError("inline_username");
                  }}
                  aria-required="true"
                  {...invalidAria(fieldErrors.inline_username, "key-username-error")}
                />
                <FieldError id="key-username-error" message={fieldErrors.inline_username} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="key-path">Private Key Path *</Label>
                <Input
                  id="key-path"
                  placeholder="~/.ssh/id_rsa"
                  value={inlineKeyPath}
                  onChange={(e) => {
                    setInlineKeyPath(e.target.value);
                    clearFieldError("inline_key_path");
                  }}
                  aria-required="true"
                  {...invalidAria(fieldErrors.inline_key_path, "key-path-error")}
                />
                <FieldError id="key-path-error" message={fieldErrors.inline_key_path} />
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
              {saveCredentialFields("ssh_key", "conn-save-credential-key", "ssh-cred-name", "server-key")}
            </TabsContent>
          </Tabs>
        </div>
      )}

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
          Pass extra flags to the SSH session (e.g. <code>-C</code> to enable
          compression). Unknown flags are ignored.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="proxy_command">Proxy Command</Label>
          {isWindows && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="connection-form-proxy-wsl"
              onClick={() => setForm({ ...form, proxy_command: WSL_PROXY_COMMAND })}
            >
              Through WSL
            </Button>
          )}
        </div>
        <Input
          id="proxy_command"
          data-testid="connection-form-proxy-command"
          placeholder="nc %h %p"
          value={form.proxy_command ?? ""}
          onChange={(e) => setForm({ ...form, proxy_command: e.target.value })}
          aria-describedby="proxy_command-hint"
        />
        <p id="proxy_command-hint" className="text-xs text-muted-foreground">
          Like <code>ProxyCommand</code> in <code>ssh_config</code>: SSIX runs this
          command and talks SSH over its input and output instead of opening a
          TCP connection to the {isTwoHop ? terms.hop.toLowerCase() : "host"}.{" "}
          <code>%h</code>, <code>%p</code> and <code>%r</code> stand for its host,
          port and user.
          {isWindows && (
            <>
              {" "}
              <strong>Through WSL</strong> connects from inside your WSL
              distribution (it needs <code>nc</code> there).
            </>
          )}
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
          onValueChange={(v) => setForm({ ...form, verbosity: Number(v) })}
        >
          <SelectTrigger
            id="verbosity"
            aria-describedby="verbosity-hint"
            data-testid="connection-form-verbosity"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VERBOSITY_LEVELS.map((level) => (
              <SelectItem key={level.value} value={String(level.value)} data-name={level.label}>
                {level.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id="verbosity-hint" className="text-xs text-muted-foreground">
          Like <code>ssh -v</code>: each level adds debug lines to the Logs view.
          -v shows the connection steps (key exchange, host key, authentication,
          channels), -vv adds the negotiated ciphers, MACs and compression, and
          -vvv the algorithms SSIX offers and how long each step took.
        </p>
      </div>

      {visibleError && (
        <p
          role="alert"
          aria-live="assertive"
          id="connection-form-error"
          data-testid="connection-form-error"
          className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md"
        >
          {visibleError}
        </p>
      )}
    </>
  );

  const formFooter = (
    <DialogFooter className="px-6 py-3 border-t bg-background shrink-0 gap-2 sm:[&>button]:min-w-28">
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
  );

  const renderedForm = (
    <>
      <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="sr-only">
          {formDescription}
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={submitWithoutReset(submitAction)}
        className="flex flex-col flex-1 min-h-0"
        data-testid="connection-form"
      >
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {formFields}
        </div>
        {formFooter}
      </form>
    </>
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (o) {
            onOpenChange(true);
            return;
          }
          requestCloseDialog();
        }}
      >
        <DialogContent
          className="p-0 gap-0 overflow-hidden"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            firstFieldRef.current?.focus();
          }}
        >
          {renderedForm}
        </DialogContent>
      </Dialog>
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
    </>
  );
}
