import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentTestDataDir } from "./data-dir.js";
import { TARGETS } from "./docker.js";

/**
 * A proxy command to server-a that refuses to connect while a flag file exists,
 * so every attempt fails as a network failure would, for as long as a test
 * wants. `flagName` keeps the flags of different specs apart.
 */
export function flaggedProxy(flagName: string) {
  const flag = () => {
    const dir = currentTestDataDir();
    if (!dir) throw new Error("SSIX_DATA_DIR is not set");
    return join(dir, flagName);
  };
  return {
    refuseConnections: () => writeFileSync(flag(), ""),
    allowConnections: () => rmSync(flag(), { force: true }),
    proxyCommand: () => `[ -e ${flag()} ] && exit 1; exec nc ${TARGETS.a.host} ${TARGETS.a.sshPort}`,
  };
}
