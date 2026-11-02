import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { isForwardType } from "@/lib/sshTerms";
import type { ConnectionType } from "@/types";
import type { ConnectionFormSectionProps } from "./advanced";

interface AuthOptionsProps extends ConnectionFormSectionProps {
  /** Forwarding is for shells: a forward kind has no use for it. */
  connectionType?: ConnectionType;
}

/** Authentication options of the connection form (roadmap: auth). See `docs/auth.md`. */
export function AuthOptions({ advanced, onChange, connectionType }: AuthOptionsProps) {
  if (connectionType && isForwardType(connectionType)) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id="agent-forwarding"
          checked={advanced.agent_forwarding ?? false}
          onCheckedChange={(checked) => onChange({ agent_forwarding: checked === true })}
          aria-describedby="agent-forwarding-hint"
          data-testid="connection-form-agent-forwarding"
        />
        <Label htmlFor="agent-forwarding">
          Forward SSH agent (<code>ssh -A</code>)
        </Label>
      </div>
      <p id="agent-forwarding-hint" className="text-xs text-muted-foreground">
        Lets commands on the server use the keys in your local SSH agent while you are
        connected, for example to reach the next host. Anyone with root on that server can use
        them too, so enable it only for servers you trust. The keys themselves stay on this
        computer. Not available on Windows.
      </p>
    </div>
  );
}
