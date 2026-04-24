import React, { useState, useEffect } from "react";
import { Connection, Credential, ConnectionType, OPEN_COLORS } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { PasswordInput } from "./ui/password-input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { COLOR_VALUES } from "@/lib/colors";
import { parsePort } from "@/lib/port";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

type AuthMethod = "password" | "ssh_key" | "credential";

interface ConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection?: Connection | null;
  credentials: Credential[];
  onSubmit: (data: Omit<Connection, "id"> | Connection) => Promise<void>;
  onCreateCredential?: (data: Omit<Credential, "id">) => Promise<Credential>;
  isClone?: boolean;
}

const DEFAULT_FORM: Omit<Connection, "id"> = {
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

export function ConnectionForm({
  open,
  onOpenChange,
  connection,
  credentials,
  onSubmit,
  onCreateCredential,
  isClone = false,
}: ConnectionFormProps) {
  const [form, setForm] = useState<Omit<Connection, "id">>(DEFAULT_FORM);
  const [connectionType, setConnectionType] = useState<ConnectionType>("direct");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("credential");
  const [inlineUsername, setInlineUsername] = useState("");
  const [inlinePassword, setInlinePassword] = useState("");
  const [inlineKeyPath, setInlineKeyPath] = useState("");
  const [inlinePassphrase, setInlinePassphrase] = useState("");
  const [inlineCredentialName, setInlineCredentialName] = useState("");
  const [saveCredential, setSaveCredential] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
        gateway_host: connection.gateway_host,
        gateway_port: connection.gateway_port,
        gateway_credential_id: connection.gateway_credential_id,
        local_port: connection.local_port,
        destination_host: connection.destination_host,
        destination_port: connection.destination_port,
      });
      setPortInputs({
        port: String(connection.port ?? 22),
        gateway_port: String(connection.gateway_port ?? 22),
        destination_port: String(
          connection.destination_port ?? (connection.type === "port_forward" ? 80 : 22),
        ),
        local_port: connection.local_port ? String(connection.local_port) : "",
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
    setInlineUsername("");
    setInlinePassword("");
    setInlineKeyPath("");
    setInlinePassphrase("");
    setInlineCredentialName("");
    setSaveCredential(false);
    setError(null);
  }, [connection, open, isClone]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
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

      // Validation per kind.
      if (isTunnel) {
        if (!formWithPorts.gateway_host)
          throw new Error("Gateway host is required");
        if (!formWithPorts.gateway_credential_id)
          throw new Error("Gateway credential is required");
        if (!formWithPorts.destination_host)
          throw new Error("Destination host is required");
      }
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

      const base: Omit<Connection, "id"> = {
        name: formWithPorts.name,
        host: effectiveHost,
        port: effectivePort,
        credential_id: credentialId,
        type: connectionType,
        verbosity: formWithPorts.verbosity ?? 0,
        extra_args: formWithPorts.extra_args || undefined,
        login_command: formWithPorts.login_command || undefined,
        remote_path: formWithPorts.remote_path || undefined,
        tags: formWithPorts.tags ?? [],
        color: formWithPorts.color,
      };

      const data: Omit<Connection, "id"> =
        connectionType === "direct"
          ? base
          : connectionType === "port_forward"
          ? {
              ...base,
              gateway_host: formWithPorts.gateway_host,
              gateway_port: formWithPorts.gateway_port ?? 22,
              gateway_credential_id: formWithPorts.gateway_credential_id,
              local_port: formWithPorts.local_port,
              destination_host: formWithPorts.destination_host,
              destination_port: formWithPorts.destination_port ?? 22,
            }
          : {
              // jump_shell
              ...base,
              gateway_host: formWithPorts.gateway_host,
              gateway_port: formWithPorts.gateway_port ?? 22,
              gateway_credential_id: formWithPorts.gateway_credential_id,
              destination_host: formWithPorts.destination_host,
              destination_port: formWithPorts.destination_port ?? 22,
            };

      if (connection && !isClone) {
        await onSubmit({ ...data, id: connection.id });
      } else {
        await onSubmit(data);
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

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
        <SelectTrigger>
          <SelectValue placeholder="Select credential..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None</SelectItem>
          {credentials.map((cred) => (
            <SelectItem key={cred.id} value={cred.id}>
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
            onChange={(e) =>
              setForm({ ...form, gateway_host: e.target.value })
            }
          />
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
          onValueChange={(v) =>
            setForm({
              ...form,
              gateway_credential_id: v === "none" ? undefined : v,
            })
          }
        >
          <SelectTrigger id="gateway_credential">
            <SelectValue placeholder="Select credential..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            {credentials.map((cred) => (
              <SelectItem key={cred.id} value={cred.id}>
                {cred.name} ({cred.username})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
            onChange={(e) =>
              setForm({ ...form, destination_host: e.target.value })
            }
          />
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col flex-1 min-h-0"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          <Tabs
            value={connectionType}
            onValueChange={(v) => setConnectionType(v as ConnectionType)}
          >
            <TabsList className="w-full">
              <TabsTrigger value="direct" className="flex-1">
                Direct
              </TabsTrigger>
              <TabsTrigger value="port_forward" className="flex-1">
                Port Forward
              </TabsTrigger>
              <TabsTrigger value="jump_shell" className="flex-1">
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
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
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
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  required
                />
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
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={saveCredential}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSaveCredential(checked);
                        if (!checked) {
                          setInlineCredentialName("");
                        } else if (!inlineCredentialName) {
                          setInlineCredentialName(defaultCredentialName("password"));
                        }
                      }}
                      className="accent-primary"
                    />
                    Save as a named credential (visible in the Credentials list)
                  </label>
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
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={saveCredential}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSaveCredential(checked);
                        if (!checked) {
                          setInlineCredentialName("");
                        } else if (!inlineCredentialName) {
                          setInlineCredentialName(defaultCredentialName("ssh_key"));
                        }
                      }}
                      className="accent-primary"
                    />
                    Save as a named credential (visible in the Credentials list)
                  </label>
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
              placeholder="Press space to add a tag"
            />
            <p className="text-xs text-muted-foreground">
              Used for filtering — matches in the Connections search box.
            </p>
          </div>

          {/* Color */}
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setForm({ ...form, color: undefined })}
                className={cn(
                  "px-2 py-1 text-xs rounded-md border transition-colors",
                  !form.color
                    ? "border-primary bg-accent"
                    : "border-input text-muted-foreground hover:text-foreground",
                )}
              >
                None
              </button>
              {OPEN_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  onClick={() => setForm({ ...form, color: c })}
                  className={cn(
                    "h-7 w-7 rounded-full border transition-all",
                    form.color === c
                      ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                      : "border-transparent hover:scale-110",
                  )}
                  style={{ backgroundColor: COLOR_VALUES[c] }}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
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
            />
            <p className="text-xs text-muted-foreground">
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
            />
            <p className="text-xs text-muted-foreground">
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
            />
            <p className="text-xs text-muted-foreground">
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
              <SelectTrigger id="verbosity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0 — Silent (default)</SelectItem>
                <SelectItem value="1">1 — Info (connection events)</SelectItem>
                <SelectItem value="2">2 — Debug (libssh2 trace)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Level 1 prints connection info to the terminal. Level 2 enables
              low-level libssh2 tracing (verbose).
            </p>
          </div>

          {error && (
            <p
              role="alert"
              aria-live="assertive"
              id="connection-form-error"
              className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md"
            >
              {error}
            </p>
          )}
          </div>

          <DialogFooter className="px-6 py-3 border-t bg-background shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              aria-describedby={error ? "connection-form-error" : undefined}
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
    </Dialog>
  );
}
