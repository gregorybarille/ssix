import React, { useState, useEffect } from "react";
import { invoke } from "@/lib/tauri";
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

export type KeyStorageMode = "default" | "custom_path" | "inline";

export interface GeneratedKey {
  private_key_path?: string;
  private_key: string;
  public_key: string;
}

interface GenerateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional default name hint used when storage = "default". */
  nameHint?: string;
  onGenerated: (key: GeneratedKey, mode: KeyStorageMode) => void;
}

export function GenerateKeyDialog({
  open,
  onOpenChange,
  nameHint,
  onGenerated,
}: GenerateKeyDialogProps) {
  const [storage, setStorage] = useState<KeyStorageMode>("default");
  const [customPath, setCustomPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setStorage("default");
      setCustomPath("");
      setPassphrase("");
      setComment("");
      setError(null);
    }
  }, [open]);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      if (storage === "custom_path" && !customPath.trim()) {
        throw new Error("Custom path is required");
      }
      const input: Record<string, unknown> = {
        storage,
        name_hint: nameHint || undefined,
        passphrase: passphrase || undefined,
        comment: comment || undefined,
      };
      if (storage === "custom_path") {
        input.path = customPath.trim();
      }
      const result = await invoke<GeneratedKey>("generate_ssh_key", { input });
      onGenerated(result, storage);
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
          <DialogTitle>Generate SSH Key</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleGenerate} className="space-y-4">
          <div className="space-y-2">
            <Label>Storage</Label>
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="key-storage"
                  value="default"
                  checked={storage === "default"}
                  onChange={() => setStorage("default")}
                  className="mt-1 accent-primary"
                />
                <span>
                  <span className="font-medium">Default</span>
                  <span className="block text-xs text-muted-foreground">
                    Write to ~/.ssh/ with a generated filename.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="key-storage"
                  value="custom_path"
                  checked={storage === "custom_path"}
                  onChange={() => setStorage("custom_path")}
                  className="mt-1 accent-primary"
                />
                <span>
                  <span className="font-medium">Custom path</span>
                  <span className="block text-xs text-muted-foreground">
                    Choose where to write the private key file (and `.pub`).
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="key-storage"
                  value="inline"
                  checked={storage === "inline"}
                  onChange={() => setStorage("inline")}
                  className="mt-1 accent-primary"
                />
                <span>
                  <span className="font-medium">Inline (no file on disk)</span>
                  <span className="block text-xs text-muted-foreground">
                    Store the key inside SSX's secrets file only.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {storage === "custom_path" && (
            <div className="space-y-2">
              <Label htmlFor="key-custom-path">Path *</Label>
              <Input
                id="key-custom-path"
                placeholder="/home/me/.ssh/id_ed25519_custom"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="key-passphrase-gen">Passphrase (optional)</Label>
            <PasswordInput
              id="key-passphrase-gen"
              placeholder="••••••••"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="key-comment">Comment (optional)</Label>
            <Input
              id="key-comment"
              placeholder="me@laptop"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>

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
              {isSubmitting ? "Generating..." : "Generate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
