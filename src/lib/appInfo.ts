import { isTauriRuntime } from "./runtime";

/** What the About section says about SSIX itself. */
export const APP_AUTHOR = "Gregory Barillé";
export const APP_LICENSE = "MIT";
export const APP_REPOSITORY_URL = "https://github.com/gregorybarille/ssix";
export const APP_LICENSE_URL = `${APP_REPOSITORY_URL}/blob/main/LICENSE`;

/** One part of what ships inside SSIX. */
export interface ThirdPartyPackage {
  name: string;
  /** Absent for a C library, whose version no lock file gives. */
  version?: string;
  license: string;
  source: "npm" | "rust" | "native";
}

/**
 * The version to show. The manifests stay at the same number across the betas,
 * so a release build is told its tag (`VITE_RELEASE_TAG`, set in
 * `.github/workflows/release.yml`). Any other build shows the manifest's number.
 */
export async function appVersion(
  releaseTag: string | undefined = import.meta.env.VITE_RELEASE_TAG,
): Promise<string | null> {
  if (releaseTag) return releaseTag;
  if (!isTauriRuntime()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** The generated list, loaded on demand: it is 50 KB nobody needs at startup. */
export async function loadThirdPartyPackages(): Promise<ThirdPartyPackage[]> {
  const list = await import("./thirdPartyLicenses.json");
  return list.default as ThirdPartyPackage[];
}

/** The packages whose name or licence holds `query`, ignoring case. */
export function filterPackages(
  packages: ThirdPartyPackage[],
  query: string,
): ThirdPartyPackage[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return packages;
  return packages.filter(
    (pkg) =>
      pkg.name.toLowerCase().includes(needle) ||
      pkg.license.toLowerCase().includes(needle),
  );
}
