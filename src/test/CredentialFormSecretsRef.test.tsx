import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CredentialForm } from "@/components/CredentialForm";
import { invoke } from "@/lib/tauri";
import type { Credential } from "@/types";

/** Nothing else can see inside a ref, and the form stays mounted after it closes. */
const refs = vi.hoisted(() => [] as { current: unknown }[]);

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useRef = (initial: unknown) => {
    const ref = actual.useRef(initial);
    if (!refs.includes(ref)) refs.push(ref);
    return ref;
  };
  return { ...actual, default: { ...actual, useRef }, useRef };
});

const credential: Credential = { id: "c", name: "prod", username: "root", type: "password", password: "" };
const refsHolding = (secret: string) =>
  refs.filter((ref) => typeof ref.current === "string" && ref.current.includes(secret));

describe("CredentialForm secrets in refs", () => {
  it("keeps no plaintext secret in a ref after the form closes", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ password: "hunter2" });
    const props = { onOpenChange: vi.fn(), credential, onSubmit: vi.fn() };
    const { rerender } = render(<CredentialForm open {...props} />);
    await waitFor(() => expect(screen.getByTestId("credential-form-password")).toHaveValue("hunter2"));
    // Or this test could not see the ref it is about.
    expect(refsHolding("hunter2")).not.toEqual([]);

    rerender(<CredentialForm open={false} {...props} />);
    expect(refsHolding("hunter2")).toEqual([]);
  });
});
