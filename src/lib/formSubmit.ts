import { startTransition, type FormEvent } from "react";

/**
 * `onSubmit` handler that runs a `useActionState` action without React's
 * automatic form reset; use it instead of `<form action={…}>`.
 *
 * React resets a `<form action>` after every submission, including one whose
 * action reported a validation error. Radix Select, Checkbox, RadioGroup and
 * Switch listen for that reset and snap back to the value they mounted with,
 * so a failed save would quietly undo the credential, colour or checkbox the
 * user had just picked.
 *
 * React bubbles submit events through portals, so a dialog's form nested in
 * another form's tree (Install Key inside the connection form) would also
 * reach the outer handler; only the form's own submissions are handled.
 */
export function submitWithoutReset(action: () => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    startTransition(action);
  };
}
