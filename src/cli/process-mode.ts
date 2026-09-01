import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from "./service-constants.js";

export class ProcessModeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessModeConflictError";
  }
}

export function serviceDefinitionPath(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string | null {
  if (platform === "darwin") {
    return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  }
  if (platform === "linux") {
    return path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
  }
  return null;
}

export function isServiceInstalled(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): boolean {
  const defPath = serviceDefinitionPath(platform, home);
  return defPath !== null && fs.existsSync(defPath);
}

export interface ValidateTransitionOptions {
  operation: "start-detached" | "install-service";
  serviceInstalled: boolean;
  daemonPid?: number | null | undefined;
  daemonAlive?: boolean | undefined;
}

export function validateProcessModeTransition(opts: ValidateTransitionOptions): void {
  if (opts.operation === "start-detached") {
    if (opts.serviceInstalled) {
      throw new ProcessModeConflictError(
        "A persistent service definition is already installed. Use the service or run `wakewire service uninstall` before starting detached mode.",
      );
    }
  } else if (opts.operation === "install-service") {
    if (!opts.serviceInstalled && opts.daemonPid && opts.daemonAlive) {
      throw new ProcessModeConflictError(
        `A manually managed daemon is currently running (pid ${opts.daemonPid}). Run \`wakewire stop\` and verify it has stopped before installing the service.`,
      );
    }
  }
}
