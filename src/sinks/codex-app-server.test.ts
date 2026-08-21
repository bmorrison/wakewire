import { describe, expect, it } from "vitest";
import { assertLoopbackWsUrl, buildSandboxPolicy } from "./codex-app-server.js";
import { PermanentError } from "./types.js";

describe("buildSandboxPolicy", () => {
  it("forces networkAccess: false for read-only sandbox", () => {
    const policy = buildSandboxPolicy({ sandbox: "read-only", networkAccess: false });
    expect(policy).toEqual({ type: "readOnly", networkAccess: false });

    // Even if networkAccess is true in delivery options, read-only stays false
    const forced = buildSandboxPolicy({ sandbox: "read-only", networkAccess: true });
    expect(forced).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("defaults networkAccess: false for workspace-write", () => {
    const policy = buildSandboxPolicy({ sandbox: "workspace-write", networkAccess: false });
    expect(policy).toEqual({
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("maps explicit networkAccess: true for workspace-write", () => {
    const policy = buildSandboxPolicy({
      sandbox: "workspace-write",
      networkAccess: true,
      cwd: "/repos/test",
    });
    expect(policy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repos/test"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });
});

describe("assertLoopbackWsUrl", () => {
  it("accepts valid loopback ws URLs with ports", () => {
    expect(() => assertLoopbackWsUrl("ws://127.0.0.1:4571")).not.toThrow();
    expect(() => assertLoopbackWsUrl("ws://localhost:4571")).not.toThrow();
    expect(() => assertLoopbackWsUrl("ws://[::1]:4571")).not.toThrow();
  });

  it("rejects non-loopback URLs", () => {
    expect(() => assertLoopbackWsUrl("ws://0.0.0.0:4571")).toThrow(PermanentError);
    expect(() => assertLoopbackWsUrl("ws://192.168.1.5:4571")).toThrow(PermanentError);
    expect(() => assertLoopbackWsUrl("ws://example.com:4571")).toThrow(PermanentError);
  });

  it("rejects missing port or non-ws protocols", () => {
    expect(() => assertLoopbackWsUrl("ws://127.0.0.1")).toThrow(PermanentError);
    expect(() => assertLoopbackWsUrl("http://127.0.0.1:4571")).toThrow(PermanentError);
  });
});
