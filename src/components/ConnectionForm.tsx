import React, { useState, useEffect } from "react";
import { Connection, Credential, ConnectionType } from "@/types";
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
  const [saveCredential, setSaveCredential] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (connection) {
      setForm({
        name: isClone ? `${connection.name} (copy)` : connection.name,
        host: connection.host,
        port: connection.port,
        credential_id: connection.credential_id,
        type: connection.type,
        gateway_host: connection.gateway_host,
        gateway_port: connection.gateway_port,
        gateway_credential_id: connection.gateway_credential_id,
        local_port: connection.local_port,
        destination_host: connection.destination_host,
        destination_port: connection.destination_port,
      });
      setConnectionType(connection.type);
      setAuthMethod("credential");
    } else {
      setForm(DEFAULT_FORM);
      setConnectionType("direct");
      setAuthMethod("credential");
    }
    setInlineUsername("");
    setInlinePassword("");
    setInlineKeyPath("");
    setInlinePassphrase("");
    setSaveCredential(false);
    setError(null);
  }, [connection, open, isClone]);

  const isTunnel = connectionType !== "direct";
  const needsDestinationAuth = connectionType !== "port_forward";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      let credentialId = form.credential_id;

      // Auto-create credential for inline auth (only for kinds that need destination auth)
      if (needsDestinationAuth) {
        if (authMethod === "password" && onCreateCredential) {
          if (!inlineUsername) throw new Error("Username is required");
          if (!inlinePassword) throw new Error("Password is required");
          const isPrivate = !saveCredential;
          const credName = saveCredential
            ? `${form.name || "connection"}-cred`
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
          const isPrivate = !saveCredential;
          const credName = saveCredential
            ? `${form.name || "connection"}-key`
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
        if (!form.gateway_host)
          throw new Error("Gateway host is required");
        if (!form.gateway_credential_id)
          throw new Error("Gateway credential is required");
        if (!form.destination_host)
          throw new Error("Destination host is required");
      }
      if (connectionType === "port_forward") {
        if (!form.local_port)
          throw new Error("Local port is required for port forwarding");
      }
      if (connectionType === "jump_shell" && !credentialId) {
        throw new Error("Destination credential is required for jump shell");
      }

      // Mirror destination_host/port into top-level host/port for tunnel kinds so
      // list views can keep displaying a meaningful "host" label.
      const effectiveHost = isTunnel ? (form.destination_host ?? "") : form.host;
      const effectivePort = isTunnel
        ? (form.destination_port ?? 22)
        : form.port;

      const base: Omit<Connection, "id"> = {
        name: form.name,
        host: effectiveHost,
        port: effectivePort,
        credential_id: credentialId,
        type: connectionType,
      };

      const data: Omit<Connection, "id"> =
        connectionType === "direct"
          ? base
          : connectionType === "port_forward"
          ? {
              ...base,
              gateway_host: form.gateway_host,
              gateway_port: form.gateway_port ?? 22,
              gateway_credential_id: form.gateway_credential_id,
              local_port: form.local_port,
              destination_host: form.destination_host,
              destination_port: form.destination_port ?? 22,
            }
          : {
              // jump_shell
              ...base,
              gateway_host: form.gateway_host,
              gateway_port: form.gateway_port ?? 22,
              gateway_credential_id: form.gateway_credential_id,
              destination_host: form.destination_host,
              destination_port: form.destination_port ?? 22,
            };

      if (connection && !isClone) {
        await onSubmit({ ...data, id: connection.id });
      } else {
        await onSubmit(data);
      }
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const title = isClone
    ? "Clone Connection"
    : connection
    ? "Edit Connection"
    : "New Connection";

  const credentialPicker = (
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
            type="number"
            placeholder="22"
            value={form.gateway_port ?? 22}
            onChange={(e) =>
              setForm({
                ...form,
                gateway_port: parseInt(e.target.value) || 22,
              })
            }
          />
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
            type="number"
            placeholder={connectionType === "port_forward" ? "80" : "22"}
            value={form.destination_port ?? (connectionType === "port_forward" ? 80 : 22)}
            onChange={(e) =>
              setForm({
                ...form,
                destination_port: parseInt(e.target.value) || 22,
              })
            }
          />
        </div>
      </div>
    </div>
  );

  const localPortBlock = (
    <div className="space-y-2">
      <Label htmlFor="local_port">Local Port *</Label>
      <Input
        id="local_port"
        type="number"
        placeholder="9000"
        value={form.local_port ?? ""}
        onChange={(e) =>
          setForm({
            ...form,
            local_port: parseInt(e.target.value) || undefined,
          })
        }
      />
      <p className="text-xs text-muted-foreground">
        SSX will listen on <code>127.0.0.1:&lt;local_port&gt;</code> and forward
        connections through the gateway to the destination.
      </p>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
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
                  type="number"
                  placeholder="22"
                  value={form.port}
                  onChange={(e) =>
                    setForm({ ...form, port: parseInt(e.target.value) || 22 })
                  }
                />
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
                      onChange={(e) => setSaveCredential(e.target.checked)}
                      className="accent-primary"
                    />
                    Save as a named credential (visible in the Credentials list)
                  </label>
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
                      onChange={(e) => setSaveCredential(e.target.checked)}
                      className="accent-primary"
                    />
                    Save as a named credential (visible in the Credentials list)
                  </label>
                </TabsContent>
              </Tabs>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
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
