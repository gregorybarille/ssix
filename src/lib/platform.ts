export type Platform = "macos" | "windows" | "linux";

/** The desktop platform, read from the webview's user agent. */
export function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  return "linux";
}

/**
 * The "Through WSL" proxy command: reach the host from inside the default
 * WSL distribution, for hosts only WSL can see (its own network, a VPN
 * running there). `-e` runs `nc` directly, without a WSL shell.
 */
export const WSL_PROXY_COMMAND = "wsl.exe -e nc %h %p";
