import React, { useState, useEffect } from "react";
import { Connection, Credential } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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

interface ConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection?: Connection | null;
  credentials: Credential[];
  onSubmit: (data: Omit<Connection, "id"> | Connection) => Promise<void>;
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
  isClone = false,
}: ConnectionFormProps) {
  const [form, setForm] = useState<Omit<Connection, "id">>(DEFAULT_FORM);
  const [connectionType, setConnectionType] = useState<"direct" | "tunnel">("direct");
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
        destination_host: connection.destination_host,
        destination_port: connection.destination_port,
      });
      setConnectionType(connection.type);
    } else {
      setForm(DEFAULT_FORM);
      setConnectionType("direct");
    }
    setError(null);
  }, [connection, open, isClone]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const data = {
        ...form,
        type: connectionType,
        ...(connectionType !== "tunnel" && {
          gateway_host: undefined,
          gateway_port: undefined,
          gateway_credential_id: undefined,
          destination_host: undefined,
          destination_port: undefined,
        }),
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Tabs
            value={connectionType}
            onValueChange={(v) => setConnectionType(v as "direct" | "tunnel")}
          >
            <TabsList className="w-full">
              <TabsTrigger value="direct" className="flex-1">
                Direct
              </TabsTrigger>
              <TabsTrigger value="tunnel" className="flex-1">
                Tunnel
              </TabsTrigger>
            </TabsList>

            <div className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 space-y-2">
                  <Label htmlFor="name">Connection Name *</Label>
                  <Input
                    id="name"
                    placeholder="my-server"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                  />
                </div>
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

              <div className="space-y-2">
                <Label htmlFor="credential">Credential</Label>
                <Select
                  value={form.credential_id ?? "none"}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      credential_id: v === "none" ? undefined : v,
                    })
                  }
                >
                  <SelectTrigger id="credential">
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

              <TabsContent value="tunnel" className="space-y-4 mt-0">
                <div className="rounded-lg border p-4 space-y-4">
                  <p className="text-sm font-medium text-muted-foreground">
                    Gateway (Jump Host)
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="gateway_host">Gateway Host</Label>
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
                    <Label htmlFor="gateway_credential">Gateway Credential</Label>
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
                  <p className="text-sm font-medium text-muted-foreground">
                    Destination
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="destination_host">Destination Host</Label>
                      <Input
                        id="destination_host"
                        placeholder="internal.example.com"
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
                        placeholder="22"
                        value={form.destination_port ?? 22}
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
              </TabsContent>
            </div>
          </Tabs>

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
