import { describe, expect, it, vi } from "vitest";
import {
  assertLoopbackWsUrl,
  buildSandboxPolicy,
  CodexAppServerAdapter,
} from "./codex-app-server.js";
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
      writableRoots: ["/repos/test", "/repos/test/.git"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });
});

describe("CodexAppServerAdapter resumed thread delivery", () => {
  it("uses the App Server-resumed cwd and its Git metadata as workspace-write roots", async () => {
    const adapter = new CodexAppServerAdapter({} as never);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const internal = adapter as unknown as {
      connect: () => Promise<object>;
      call: (rpc: object, method: string, params: Record<string, unknown>) => Promise<unknown>;
      handleNotification: (method: string, params: unknown) => void;
    };
    internal.connect = vi.fn().mockResolvedValue({});
    internal.call = vi.fn(async (_rpc, method, params) => {
      calls.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", status: { type: "idle" } }, cwd: "/tmp/pr-checkout" };
      }
      return { turn: { id: "turn-1" } };
    });

    const pending = adapter.deliverToThread("thread-1", "wake", {
      sandbox: "workspace-write",
      networkAccess: true,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({
      method: "turn/start",
      params: expect.objectContaining({
        threadId: "thread-1",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/pr-checkout", "/tmp/pr-checkout/.git"],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      }),
    });

    internal.handleNotification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await expect(pending).resolves.toMatchObject({ threadId: "thread-1", turnId: "turn-1" });
  });

  it("fails closed when a workspace-write resumed thread has no cwd", async () => {
    const adapter = new CodexAppServerAdapter({} as never);
    const internal = adapter as unknown as {
      connect: () => Promise<object>;
      call: (rpc: object, method: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    internal.connect = vi.fn().mockResolvedValue({});
    internal.call = vi.fn().mockResolvedValue({ thread: { id: "thread-1" } });

    await expect(
      adapter.deliverToThread("thread-1", "wake", {
        sandbox: "workspace-write",
        networkAccess: true,
      }),
    ).rejects.toThrow("did not report a checkout cwd");
    expect(internal.call).toHaveBeenCalledTimes(1);
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
