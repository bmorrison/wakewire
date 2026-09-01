import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readDaemonState } from "../client.js";
import { isProcessAlive } from "../daemon/lock.js";
import { logsDir } from "../paths.js";
import { isServiceInstalled, validateProcessModeTransition } from "./process-mode.js";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from "./service-constants.js";

const execFileAsync = promisify(execFile);

const DARWIN_STANDARD_DIRS = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const LINUX_STANDARD_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"];

function hasInvalidXmlControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    ) {
      return true;
    }
  }
  return false;
}

function hasInvalidSystemdChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x00 || code === 0x0a || code === 0x0d) {
      return true;
    }
  }
  return false;
}

export function buildServicePath(
  execPath: string,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const nodeDir = path.dirname(execPath);
  const inheritedEntries = inheritedPath
    ? inheritedPath.split(":").filter((entry) => entry.length > 0 && path.isAbsolute(entry))
    : [];

  const standardDirs = platform === "darwin" ? DARWIN_STANDARD_DIRS : LINUX_STANDARD_DIRS;

  const candidates = [nodeDir, ...inheritedEntries, ...standardDirs];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const dir of candidates) {
    if (dir && path.isAbsolute(dir) && !seen.has(dir)) {
      seen.add(dir);
      result.push(dir);
    }
  }

  return result.join(":");
}

export function escapeXmlText(text: string): string {
  if (hasInvalidXmlControlChar(text)) {
    throw new Error("Invalid character in XML text: control characters are not allowed");
  }
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function quoteSystemdValue(val: string): string {
  if (hasInvalidSystemdChar(val)) {
    throw new Error("Invalid systemd value: NUL and newline characters are not allowed");
  }
  const escaped = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${escaped}"`;
}

export const quoteSystemdArg = quoteSystemdValue;

export function launchdPlist(cliPath: string, servicePath: string): string {
  const stdout = path.join(logsDir(), "launchd.out.log");
  const stderr = path.join(logsDir(), "launchd.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXmlText(LAUNCHD_LABEL)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXmlText(servicePath)}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXmlText(process.execPath)}</string>
    <string>${escapeXmlText(cliPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXmlText(stdout)}</string>
  <key>StandardErrorPath</key><string>${escapeXmlText(stderr)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(cliPath: string, servicePath: string): string {
  return `[Unit]
Description=wakewire - push external events into Codex threads
After=network-online.target

[Service]
Environment=${quoteSystemdValue(`PATH=${servicePath}`)}
ExecStart=${[process.execPath, cliPath, "start"].map(quoteSystemdArg).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * launchd (macOS) / systemd user unit (Linux) registration so the daemon
 * starts at login. Windows: run under a terminal or NSSM — documented in the
 * README, no service wrapper in v1.
 */
export async function installService(cliPath: string): Promise<void> {
  const serviceInstalled = isServiceInstalled();
  const state = readDaemonState();
  const isAlive = state ? isProcessAlive(state.pid) : false;

  validateProcessModeTransition({
    operation: "install-service",
    serviceInstalled,
    daemonPid: state?.pid,
    daemonAlive: isAlive,
  });

  const servicePath = buildServicePath(process.execPath, process.env.PATH, process.platform);

  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(plist, launchdPlist(cliPath, servicePath));
    await execFileAsync("launchctl", ["unload", plist]).catch(() => undefined);
    await execFileAsync("launchctl", ["load", plist]);
    console.log(`Installed and loaded launchd agent: ${plist}`);
    return;
  }
  if (process.platform === "linux") {
    const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
    const unit = path.join(unitDir, SYSTEMD_UNIT_NAME);
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unit, systemdUnit(cliPath, servicePath));
    console.log(`Wrote ${unit}`);
    console.log(
      "Enable it with:\n  systemctl --user daemon-reload && systemctl --user enable --now wakewire",
    );
    return;
  }
  console.log(
    "No service wrapper for this platform in v1. Run `wakewire start` in a terminal, " +
      "or on Windows use NSSM: nssm install wakewire <node> <cli.js> start",
  );
}

export async function uninstallService(): Promise<void> {
  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    await execFileAsync("launchctl", ["unload", plist]).catch(() => undefined);
    fs.rmSync(plist, { force: true });
    console.log(`Removed ${plist}`);
    return;
  }
  if (process.platform === "linux") {
    const unit = path.join(os.homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
    await execFileAsync("systemctl", ["--user", "disable", "--now", "wakewire"]).catch(
      () => undefined,
    );
    fs.rmSync(unit, { force: true });
    console.log(`Removed ${unit}`);
    return;
  }
  console.log("Nothing to uninstall on this platform.");
}
