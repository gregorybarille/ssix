import { FieldError, invalidAria } from "../ConnectionFormFields";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export interface Choice {
  value: string;
  label: string;
}

/** A labelled select for one option of the connection form's sections. */
export function ChoiceSelect({
  id,
  label,
  testId,
  value,
  choices,
  error,
  onChange,
}: {
  id: string;
  label: string;
  testId: string;
  value: string;
  choices: readonly Choice[];
  error?: string;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} data-testid={testId} {...invalidAria(error, errorId)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value} data-name={choice.label}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError id={errorId} message={error} testId={`${testId}-error`} />
    </div>
  );
}
