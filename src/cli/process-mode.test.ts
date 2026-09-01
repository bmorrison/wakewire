import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isServiceInstalled,
  ProcessModeConflictError,
  serviceDefinitionPath,
  validateProcessModeTransition,
} from "./process-mode.js";

describe("process-mode helpers", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-process-mode-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("serviceDefinitionPath", () => {
    it("returns launchd plist path on darwin", () => {
      const p = serviceDefinitionPath("darwin", tempHome);
      expect(p).toBe(path.join(tempHome, "Library", "LaunchAgents", "io.wakewire.daemon.plist"));
    });

    it("returns systemd unit path on linux", () => {
      const p = serviceDefinitionPath("linux", tempHome);
      expect(p).toBe(path.join(tempHome, ".config", "systemd", "user", "wakewire.service"));
    });

    it("returns null on win32 and other platforms", () => {
      expect(serviceDefinitionPath("win32", tempHome)).toBeNull();
      expect(serviceDefinitionPath("aix", tempHome)).toBeNull();
    });
  });

  describe("isServiceInstalled", () => {
    it("returns true when definition file exists and false when absent", () => {
      expect(isServiceInstalled("darwin", tempHome)).toBe(false);

      const plistPath = serviceDefinitionPath("darwin", tempHome);
      expect(plistPath).not.toBeNull();
      if (!plistPath) return;
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, "dummy plist");

      expect(isServiceInstalled("darwin", tempHome)).toBe(true);
    });

    it("returns false on platforms with no service wrapper", () => {
      expect(isServiceInstalled("win32", tempHome)).toBe(false);
    });
  });

  describe("validateProcessModeTransition", () => {
    it("rejects start-detached before considering an existing live daemon", () => {
      const transition = () =>
        validateProcessModeTransition({
          operation: "start-detached",
          serviceInstalled: true,
          daemonPid: 12345,
          daemonAlive: true,
        });

      expect(transition).toThrow(ProcessModeConflictError);
      expect(transition).toThrow(
        "Use the service or run `wakewire service uninstall` before starting detached mode.",
      );
    });

    it("allows start-detached when no service definition is installed", () => {
      expect(() =>
        validateProcessModeTransition({
          operation: "start-detached",
          serviceInstalled: false,
        }),
      ).not.toThrow();
    });

    it("rejects install-service when no service exists but a manually managed daemon is alive", () => {
      expect(() =>
        validateProcessModeTransition({
          operation: "install-service",
          serviceInstalled: false,
          daemonPid: 12345,
          daemonAlive: true,
        }),
      ).toThrow(ProcessModeConflictError);
    });

    it("allows install-service when daemon is dead (stale state)", () => {
      expect(() =>
        validateProcessModeTransition({
          operation: "install-service",
          serviceInstalled: false,
          daemonPid: 12345,
          daemonAlive: false,
        }),
      ).not.toThrow();
    });

    it("allows install-service when no daemon is running at all", () => {
      expect(() =>
        validateProcessModeTransition({
          operation: "install-service",
          serviceInstalled: false,
          daemonPid: null,
          daemonAlive: false,
        }),
      ).not.toThrow();
    });

    it("allows install-service when a service is already installed (reinstall / reload workflow)", () => {
      expect(() =>
        validateProcessModeTransition({
          operation: "install-service",
          serviceInstalled: true,
          daemonPid: 12345,
          daemonAlive: true,
        }),
      ).not.toThrow();
    });
  });
});
