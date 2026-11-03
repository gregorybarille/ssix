import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AboutSection } from "@/components/settings/AboutSection";
import {
  APP_LICENSE_URL,
  APP_REPOSITORY_URL,
  appVersion,
  filterPackages,
  type ThirdPartyPackage,
} from "@/lib/appInfo";

const open = vi.hoisted(() => vi.fn());
const getVersion = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-shell", () => ({ open }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

describe("appVersion", () => {
  beforeEach(() => getVersion.mockReset().mockResolvedValue("1.0.0"));

  it("prefers the release tag, because the manifests do not change across betas", async () => {
    await expect(appVersion("v1.0.0-beta.17")).resolves.toBe("v1.0.0-beta.17");
    expect(getVersion).not.toHaveBeenCalled();
  });

  it("falls back on the manifest in a build that has no tag", async () => {
    await expect(appVersion("")).resolves.toBe("1.0.0");
  });
});

describe("filterPackages", () => {
  const packages: ThirdPartyPackage[] = [
    { name: "react", version: "19.0.0", license: "MIT", source: "npm" },
    { name: "OpenSSL", license: "Apache-2.0", source: "native" },
  ];

  it("matches a name or a licence whatever the case, and keeps all on empty", () => {
    expect(filterPackages(packages, "openssl").map((p) => p.name)).toEqual(["OpenSSL"]);
    expect(filterPackages(packages, " mit ").map((p) => p.name)).toEqual(["react"]);
    expect(filterPackages(packages, "  ")).toBe(packages);
    expect(filterPackages(packages, "nothing")).toEqual([]);
  });
});

describe("AboutSection", () => {
  beforeEach(() => {
    open.mockReset().mockResolvedValue(undefined);
    getVersion.mockReset().mockResolvedValue("1.2.3");
  });

  it("names the version and the author", async () => {
    render(<AboutSection />);
    await waitFor(() => expect(screen.getByTestId("about-version")).toHaveTextContent("1.2.3"));
    expect(screen.getByTestId("about-author")).toHaveTextContent("Gregory Barillé");
  });

  it("says the version is not known rather than show nothing", async () => {
    getVersion.mockRejectedValue(new Error("no"));
    render(<AboutSection />);
    await waitFor(() => expect(getVersion).toHaveBeenCalled());
    expect(screen.getByTestId("about-version")).toHaveTextContent("Unknown");
  });

  it("opens the project's links in the browser", async () => {
    const user = userEvent.setup();
    render(<AboutSection />);
    await user.click(screen.getByTestId("about-repository-link"));
    await user.click(screen.getByTestId("about-license-link"));
    expect(open.mock.calls.map(([url]) => url)).toEqual([APP_REPOSITORY_URL, APP_LICENSE_URL]);
  });

  it("shows why a link would not open", async () => {
    open.mockRejectedValue(new Error("No browser here"));
    const user = userEvent.setup();
    render(<AboutSection />);
    await user.click(screen.getByTestId("about-repository-link"));
    expect(await screen.findByRole("alert")).toHaveTextContent("No browser here");
  });

  it("loads the licence list when asked, and filters it", async () => {
    const user = userEvent.setup();
    render(<AboutSection />);
    expect(screen.queryByTestId("about-licenses-list")).not.toBeInTheDocument();

    const toggle = screen.getByTestId("about-licenses-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await screen.findByTestId("about-licenses-list");
    expect(screen.getAllByTestId("about-license-row").length).toBeGreaterThan(100);

    await user.type(screen.getByTestId("about-licenses-filter"), "libssh2");
    const names = screen.getAllByTestId("about-license-row").map((row) => row.dataset.name);
    expect(names).toContain("libssh2");
    expect(names).not.toContain("react");

    await user.type(screen.getByTestId("about-licenses-filter"), "no such thing");
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByTestId("about-licenses-list")).not.toBeInTheDocument();
  });
});
