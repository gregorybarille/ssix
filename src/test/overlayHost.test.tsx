import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";

import { ContextMenu } from "@/components/ContextMenu";
import { overlayHost } from "@/lib/overlayHost";

describe("the overlay host", () => {
  afterEach(() => document.getElementById("overlays")?.remove());

  it("sits beside the app in the page, empty, after it", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html.indexOf('<div id="overlays"></div>')).toBeGreaterThan(
      html.indexOf('<div id="root"></div>'),
    );
  });

  it("takes a menu rather than body, which would restyle the whole app", () => {
    const host = document.createElement("div");
    host.id = "overlays";
    document.body.appendChild(host);
    render(
      <ContextMenu
        position={{ x: 1, y: 1 }}
        onClose={() => {}}
        items={[{ label: "One", onClick: () => {} }]}
      />,
    );
    expect(host.contains(screen.getByRole("menu"))).toBe(true);
  });

  it("falls back on body where a page has none", () => {
    expect(overlayHost()).toBe(document.body);
  });
});
