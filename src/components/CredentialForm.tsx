import { useActionState, useState, useEffect, useRef, useId } from "react";
import { Credential } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { PasswordInput } from "./ui/password-input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { GenerateKeyDialog, GeneratedKey, KeyStorageMode } from "./GenerateKeyDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { pickFile } from "@/lib/dialog";
import { FolderOpen } from "lucide-react";

interface CredentialFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credential?: Credential | null;
  onSubmit: (data: Omit<Credential, "id"> | Credential) => Promise<void>;
  inline?: boolean;
}

type KeySource = "path" | "inline";

function serializeCredentialState(s: {
  name: string;
  username: string;
  credType: "password" | "ssh_key";
  password: string;
  keySource: KeySource;
  privateKeyPath: string;
  privateKey: string;
  passphrase: string;
}): string {
  return JSON.stringify([
    s.name,
    s.username,
    s.credType,
    s.password,
    s.keySource,
    s.privateKeyPath,
    s.privateKey,
    s.passphrase,
  ]);
}

export function CredentialForm({
  open,
  onOpenChange,
  credential,
  onSubmit,
  inline = false,
}: CredentialFormProps) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [credType, setCredType] = useState<"password" | "ssh_key">("password");
  const [password, setPassword] = useState("");
  const [keySource, setKeySource] = useState<KeySource>("path");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const inlineTitleId = useId();
  const inlineDescriptionId = useId();
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Inline per-field errors. Keys mirror the input identifiers.
  type FieldKey = "name" | "username" | "key_path" | "key_inline";
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const clearFieldError = (key: FieldKey) =>
    setFieldErrors((errs) => {
      if (!errs[key]) return errs;
      const next = { ...errs };
      delete next[key];
      return next;
    });

  useEffect(() => {
    if (credential) {
      setName(credential.name);
      setUsername(credential.username);
      setCredType(credential.type);
      setPassword(credential.password ?? "");
      setPrivateKeyPath(credential.private_key_path ?? "");
      setPrivateKey(credential.private_key ?? "");
      setKeySource(credential.private_key ? "inline" : "path");
      setPassphrase(credential.passphrase ?? "");
    } else {
      setName("");
      setUsername("");
      setCredType("password");
      setPassword("");
      setPrivateKeyPath("");
      setPrivateKey("");
      setKeySource("path");
      setPassphrase("");
    }
    setGeneratedPublicKey(null);
    setFieldErrors({});
  }, [credential, open]);

  // Snapshot baseline state for unsaved-changes detection. Recomputed
  // whenever the dialog opens or the backing credential changes.
  const baselineRef = useRef<string>("");
  useEffect(() => {
    const id = setTimeout(() => {
      baselineRef.current = serializeCredentialState({
        name,
        username,
        credType,
        password,
        keySource,
        privateKeyPath,
        privateKey,
        passphrase,
      });
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential, open]);

  const currentSnapshot = serializeCredentialState({
    name,
    username,
    credType,
    password,
    keySource,
    privateKeyPath,
    privateKey,
    passphrase,
  });
  const dirty =
    open && currentSnapshot !== baselineRef.current && baselineRef.current !== "";

  const guard = useUnsavedChangesGuard(dirty);
  const requestCloseDialog = () => guard.requestClose(() => onOpenChange(false));

  useEffect(() => {
    if (!inline || !open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[role='dialog']")) return;
      event.preventDefault();
      requestCloseDialog();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inline, open, requestCloseDialog]);

  useEffect(() => {
    if (!inline || !open) return;
    if (document.querySelector("[role='dialog']")) return;
    const id = window.requestAnimationFrame(() => {
      firstFieldRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [inline, open, credential?.id]);

  const handleGenerated = (key: GeneratedKey, mode: KeyStorageMode) => {
    setGeneratedPublicKey(key.public_key);
    if (mode === "inline") {
      setKeySource("inline");
      setPrivateKey(key.private_key);
      setPrivateKeyPath("");
    } else {
      setKeySource("path");
      setPrivateKeyPath(key.private_key_path ?? "");
      setPrivateKey("");
    }
  };

  /*
   * React 19: form-level error owned by useActionState; pending state
   * comes from the action runner. Field-level errors stay in plain
   * state (per AGENTS.md / migration plan).
   */
  type SubmitState = { error: string | null };
  const initialSubmitState: SubmitState = { error: null };
  const [{ error }, submitAction, isSubmitting] = useActionState<SubmitState>(
    async () => {
      // Required-field preflight: collect all problems at once so the
      // user sees every issue inline instead of one-at-a-time.
      const newFieldErrors: Partial<Record<FieldKey, string>> = {};
      if (!name.trim()) newFieldErrors.name = "Credential name is required";
      if (!username.trim()) newFieldErrors.username = "Username is required";
      if (credType === "ssh_key") {
        if (keySource === "path" && !privateKeyPath.trim()) {
          newFieldErrors.key_path = "Private key path is required";
        } else if (keySource === "inline" && !privateKey.trim()) {
          newFieldErrors.key_inline = "Private key contents are required";
        }
      }
      if (Object.keys(newFieldErrors).length > 0) {
        setFieldErrors(newFieldErrors);
        return { error: "Please fix the highlighted fields" };
      }

      try {
        let kindFields: Partial<Credential>;
        if (credType === "password") {
          kindFields = { password };
        } else {
          if (keySource === "path") {
            kindFields = {
              private_key_path: privateKeyPath,
              passphrase: passphrase || undefined,
            };
          } else {
            kindFields = {
              private_key: privateKey,
              passphrase: passphrase || undefined,
            };
          }
        }
        const data: Omit<Credential, "id"> = {
          name,
          username,
          type: credType,
          ...kindFields,
        };
        if (credential) {
          await onSubmit({ ...data, id: credential.id });
        } else {
          await onSubmit(data);
        }
        guard.markSaved();
        onOpenChange(false);
        return { error: null };
      } catch (err) {
        return { error: String(err) };
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

  const title = credential ? "Edit Credential" : "New Credential";
  const description = credential
    ? "Edit the username and authentication for this credential."
    : "Configure a new credential: username and authentication (password or SSH key).";

  const renderedForm = (
    <>
      <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b">
        {inline ? (
          <>
            <h2 id={inlineTitleId} className="text-lg leading-none font-semibold">
              {title}
            </h2>
            <p id={inlineDescriptionId} className="sr-only">
              {description}
            </p>
          </>
        ) : (
          <>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">
              {description}
            </DialogDescription>
          </>
        )}
      </DialogHeader>
      <form
        action={submitAction}
        className="flex flex-col flex-1 min-h-0"
        data-testid="credential-form"
        aria-labelledby={inline ? inlineTitleId : undefined}
        aria-describedby={inline ? inlineDescriptionId : undefined}
      >
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cred-name">Credential Name *</Label>
            <Input
              id="cred-name"
              ref={firstFieldRef}
              placeholder="my-server-key"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearFieldError("name");
              }}
              required
              data-testid="credential-form-name"
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? "cred-name-error" : undefined}
            />
            {fieldErrors.name && (
              <p id="cred-name-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.name}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="cred-username">Username *</Label>
            <Input
              id="cred-username"
              placeholder="ubuntu"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                clearFieldError("username");
              }}
              required
              data-testid="credential-form-username"
              aria-invalid={fieldErrors.username ? true : undefined}
              aria-describedby={fieldErrors.username ? "cred-username-error" : undefined}
            />
            {fieldErrors.username && (
              <p id="cred-username-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.username}
              </p>
            )}
          </div>

          <Tabs
            value={credType}
            onValueChange={(v) => setCredType(v as "password" | "ssh_key")}
          >
            <TabsList className="w-full">
              <TabsTrigger value="password" className="flex-1" data-testid="credential-form-kind-password">
                Password
              </TabsTrigger>
              <TabsTrigger value="ssh_key" className="flex-1" data-testid="credential-form-kind-sshkey">
                SSH Key
              </TabsTrigger>
            </TabsList>
            <TabsContent value="password" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="cred-password">Password</Label>
                <PasswordInput
                  id="cred-password"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="credential-form-password"
                />
              </div>
            </TabsContent>
            <TabsContent value="ssh_key" className="space-y-4 mt-4">
              <div className="flex items-center justify-between">
                <div role="tablist" aria-label="Key source" className="inline-flex rounded-md border border-input p-0.5 bg-background">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={keySource === "path"}
                    onClick={() => setKeySource("path")}
                    className={`px-3 py-1 text-xs rounded ${
                      keySource === "path"
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    Path
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={keySource === "inline"}
                    onClick={() => setKeySource("inline")}
                    className={`px-3 py-1 text-xs rounded border-l ${
                      keySource === "inline"
                        ? "bg-accent text-accent-foreground border-l-transparent"
                        : "text-muted-foreground border-border/60"
                    } ${keySource === "path" ? "border-l-transparent" : ""}`}
                  >
                    Paste key
                  </button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setGenerateOpen(true)}
                  data-testid="generate-key-open"
                >
                  Generate key…
                </Button>
              </div>
              {keySource === "path" ? (
                <div className="space-y-2">
                  <Label htmlFor="cred-key-path">Private Key Path *</Label>
                  <div className="flex gap-2">
                    <Input
                      id="cred-key-path"
                      placeholder="/home/user/.ssh/id_rsa"
                      value={privateKeyPath}
                      onChange={(e) => {
                        setPrivateKeyPath(e.target.value);
                        clearFieldError("key_path");
                      }}
                      data-testid="credential-form-private-key-path"
                      aria-invalid={fieldErrors.key_path ? true : undefined}
                      aria-describedby={fieldErrors.key_path ? "cred-key-path-error" : undefined}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={async () => {
                        const picked = await pickFile({
                          title: "Select SSH private key",
                          defaultPath: privateKeyPath || undefined,
                          filters: [{ name: "All files", extensions: ["*"] }],
                        });
                        if (picked) {
                          setPrivateKeyPath(picked);
                          clearFieldError("key_path");
                        }
                      }}
                      aria-label="Browse for private key file"
                      title="Browse for private key file"
                    >
                      <FolderOpen className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                  {fieldErrors.key_path && (
                    <p id="cred-key-path-error" role="alert" className="text-xs text-destructive">
                      {fieldErrors.key_path}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="cred-key-inline">Private Key Contents *</Label>
                  <Textarea
                    id="cred-key-inline"
                    rows={6}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                    value={privateKey}
                    onChange={(e) => {
                      setPrivateKey(e.target.value);
                      clearFieldError("key_inline");
                    }}
                    aria-invalid={fieldErrors.key_inline ? true : undefined}
                    aria-describedby={[
                      fieldErrors.key_inline ? "cred-key-inline-error" : null,
                      "cred-key-inline-hint",
                    ].filter(Boolean).join(" ")}
                  />
                  {fieldErrors.key_inline && (
                    <p id="cred-key-inline-error" role="alert" className="text-xs text-destructive">
                      {fieldErrors.key_inline}
                    </p>
                  )}
                  <p
                    id="cred-key-inline-hint"
                    className="text-xs text-muted-foreground"
                  >
                    Stored in SSIX&apos;s secrets file (~/.ssix/secrets.json) and used
                    via in-memory authentication.
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="cred-passphrase">Passphrase (optional)</Label>
                <PasswordInput
                  id="cred-passphrase"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </div>
              {generatedPublicKey && (
                <div className="space-y-2">
                  <Label>Public key (share this with the remote host)</Label>
                  <div className="flex gap-2">
                    <Textarea
                      readOnly
                      rows={3}
                      value={generatedPublicKey}
                      className="text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard?.writeText(generatedPublicKey).catch(() => {});
                      }}
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>

          {visibleError && (
            <p
              role="alert"
              aria-live="assertive"
              id="credential-form-error"
              className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md"
            >
              {visibleError}
            </p>
          )}
        </div>

        <DialogFooter className="px-6 py-3 border-t bg-background shrink-0 gap-2 sm:[&>button]:min-w-28">
          <Button
            type="button"
            variant="outline"
            onClick={requestCloseDialog}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
            data-testid="credential-form-submit"
            aria-describedby={visibleError ? "credential-form-error" : undefined}
          >
            {isSubmitting ? "Saving..." : credential ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </form>
      <GenerateKeyDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        nameHint={name}
        onGenerated={handleGenerated}
      />
    </>
  );

  return (
    <>
      {inline ? (
        open ? (
          <section
            className="flex-1 overflow-y-auto px-4 py-4"
            role="region"
            aria-labelledby={inlineTitleId}
            aria-describedby={inlineDescriptionId}
          >
            <div className="mx-auto flex min-h-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-lg">
              {renderedForm}
            </div>
          </section>
        ) : null
      ) : (
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
          <DialogContent className="sm:max-w-[460px] max-h-[90vh] flex flex-col p-0 gap-0">
            {renderedForm}
          </DialogContent>
        </Dialog>
      )}
      <ConfirmDialog
        open={guard.confirmOpen}
        onOpenChange={(o) => {
          if (!o) guard.cancelDiscard();
        }}
        title="Discard unsaved changes?"
        description="You have unsaved changes to this credential. Discard them and close the form?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        variant="destructive"
        onConfirm={guard.confirmDiscard}
      />
    </>
  );
}
