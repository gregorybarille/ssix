import React, { useState, useEffect } from "react";
import { Credential } from "@/types";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface CredentialFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credential?: Credential | null;
  onSubmit: (data: Omit<Credential, "id"> | Credential) => Promise<void>;
}

export function CredentialForm({
  open,
  onOpenChange,
  credential,
  onSubmit,
}: CredentialFormProps) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [credType, setCredType] = useState<"password" | "ssh_key">("password");
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (credential) {
      setName(credential.name);
      setUsername(credential.username);
      setCredType(credential.type);
      setPassword(credential.password ?? "");
      setPrivateKeyPath(credential.private_key_path ?? "");
      setPassphrase(credential.passphrase ?? "");
    } else {
      setName("");
      setUsername("");
      setCredType("password");
      setPassword("");
      setPrivateKeyPath("");
      setPassphrase("");
    }
    setError(null);
  }, [credential, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      if (credType === "ssh_key" && !privateKeyPath.trim()) {
        throw new Error("Private key path is required");
      }
      const data: Omit<Credential, "id"> = {
        name,
        username,
        type: credType,
        ...(credType === "password"
          ? { password }
          : { private_key_path: privateKeyPath, passphrase: passphrase || undefined }),
      };
      if (credential) {
        await onSubmit({ ...data, id: credential.id });
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>
            {credential ? "Edit Credential" : "New Credential"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cred-name">Credential Name *</Label>
            <Input
              id="cred-name"
              placeholder="my-server-key"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cred-username">Username *</Label>
            <Input
              id="cred-username"
              placeholder="ubuntu"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <Tabs
            value={credType}
            onValueChange={(v) => setCredType(v as "password" | "ssh_key")}
          >
            <TabsList className="w-full">
              <TabsTrigger value="password" className="flex-1">
                Password
              </TabsTrigger>
              <TabsTrigger value="ssh_key" className="flex-1">
                SSH Key
              </TabsTrigger>
            </TabsList>
            <TabsContent value="password" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="cred-password">Password</Label>
                <PasswordInput
                  id="cred-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </TabsContent>
            <TabsContent value="ssh_key" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="cred-key-path">Private Key Path *</Label>
                <Input
                  id="cred-key-path"
                  placeholder="/home/user/.ssh/id_rsa"
                  value={privateKeyPath}
                  onChange={(e) => setPrivateKeyPath(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cred-passphrase">Passphrase (optional)</Label>
                <PasswordInput
                  id="cred-passphrase"
                  placeholder="••••••••"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </div>
            </TabsContent>
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
              {isSubmitting ? "Saving..." : credential ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
