import { Plus } from "lucide-react";
import { CredentialList } from "../CredentialList";
import { CredentialForm } from "../CredentialForm";
import { LayoutToggle } from "../ui/layout-toggle";
import { Button } from "../ui/button";
import { useShallow } from "zustand/react/shallow";
import { useDialogsStore } from "@/store/useDialogsStore";
import { useCredentialsStore } from "@/store/useCredentialsStore";
import { ErrorBanner } from "../ui/error-banner";
import type { AppSettings, Credential, LayoutMode, UpdateCredentialPayload } from "@/types";

interface CredentialsViewProps {
  credentials: Credential[];
  settings: AppSettings;
  onLayoutChange: (layout: LayoutMode) => void;
  onSubmit: (data: Omit<Credential, "id"> | UpdateCredentialPayload) => Promise<void>;
}

/** The Credentials tab: header, inline form when open, otherwise the list. */
export function CredentialsView({
  credentials,
  settings,
  onLayoutChange,
  onSubmit,
}: CredentialsViewProps) {
  const dialogs = useDialogsStore(
    useShallow((s) => ({
      credFormOpen: s.credFormOpen,
      editingCred: s.editingCred,
      openNewCredential: s.openNewCredential,
      setCredFormOpen: s.setCredFormOpen,
      openEditCredential: s.openEditCredential,
      setConfirmDeleteCred: s.setConfirmDeleteCred,
    })),
  );
  // A failed load must not look like an empty list.
  const { loadError, retryLoad } = useCredentialsStore(
    useShallow((s) => ({ loadError: s.error, retryLoad: s.fetchCredentials })),
  );
  return (
    <>
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold">Credentials</h1>
        <div className="flex items-center gap-2">
          <LayoutToggle value={settings.credential_layout} onChange={onLayoutChange} />
          <Button
            size="sm"
            onClick={() => dialogs.openNewCredential()}
            data-testid="add-credential-button"
          >
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            New Credential
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {loadError && (
          <ErrorBanner
            className="mx-2 mb-2"
            message={`Could not load credentials: ${loadError}`}
            onRetry={() => void retryLoad()}
            testId="credentials-load-error"
          />
        )}
        <CredentialList
          credentials={credentials}
          layout={settings.credential_layout}
          onEdit={(cred) => dialogs.openEditCredential(cred)}
          onDelete={(id) => {
            const cred = credentials.find((c) => c.id === id);
            if (cred) dialogs.setConfirmDeleteCred(cred);
          }}
        />
      </div>
      <CredentialForm
        open={dialogs.credFormOpen}
        onOpenChange={dialogs.setCredFormOpen}
        credential={dialogs.editingCred}
        onSubmit={onSubmit}
      />
    </>
  );
}
