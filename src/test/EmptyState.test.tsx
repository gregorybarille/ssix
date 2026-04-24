import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Key } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * Audit-4 Dup H1: EmptyState replaces hand-rolled empty blocks in
 * ConnectionList and CredentialList. The contract callers depend on:
 *   - announces itself politely (role=status, aria-live=polite) so SR
 *     users hear "No credentials yet" when the list empties
 *   - the icon is decorative (aria-hidden) so the title isn't doubled
 *   - hint is optional
 */
describe("EmptyState", () => {
  it("renders title and hint inside a polite live region", () => {
    render(<EmptyState icon={Key} title="No credentials yet" hint="Add your first" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("No credentials yet");
    expect(status).toHaveTextContent("Add your first");
  });

  it("hides the icon from assistive tech", () => {
    const { container } = render(<EmptyState icon={Key} title="Nothing here" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  it("omits the hint paragraph when no hint provided", () => {
    render(<EmptyState icon={Key} title="Nothing here" />);
    // Only one paragraph should be in the status region.
    expect(screen.getAllByText(/here/i)).toHaveLength(1);
  });
});
