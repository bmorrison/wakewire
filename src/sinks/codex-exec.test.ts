import { describe, expect, it } from "vitest";
import { buildExecArgs, CodexExecAdapter, parseThreadId } from "./codex-exec.js";
import { PermanentError } from "./types.js";

describe("parseThreadId", () => {
  it("finds the thread id in a --json event stream", () => {
    const jsonl = [
      '{"type":"session.created"}',
      "not json noise",
      '{"type":"thread.started","thread_id":"0197-abc"}',
      '{"type":"turn.completed","usage":{}}',
    ].join("\n");
    expect(parseThreadId(jsonl)).toBe("0197-abc");
  });

  it("returns null when absent", () => {
    expect(parseThreadId('{"type":"turn.completed"}')).toBeNull();
    expect(parseThreadId("")).toBeNull();
  });

  it("rejects networkAccess: true with PermanentError", async () => {
    const adapter = new CodexExecAdapter({ debug: () => {} } as never);
    await expect(
      adapter.deliverToThread("t-1", "prompt", {
        sandbox: "workspace-write",
        networkAccess: true,
      }),
    ).rejects.toThrow(PermanentError);
    await expect(
      adapter.startThread("prompt", {
        sandbox: "workspace-write",
        networkAccess: true,
      }),
    ).rejects.toThrow(PermanentError);
  });

  it("explicitly overrides workspace-write network egress to false when networkAccess is false", () => {
    const { args } = buildExecArgs({
      sandbox: "workspace-write",
      networkAccess: false,
    });
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args).toContain("--config");
    expect(args[args.indexOf("--config") + 1]).toBe("sandbox_workspace_write.network_access=false");
  });

  it("explicitly overrides workspace-write network egress to false when networkAccess is omitted/default", () => {
    const { args } = buildExecArgs({
      sandbox: "workspace-write",
    } as never);
    expect(args).toContain("--config");
    expect(args[args.indexOf("--config") + 1]).toBe("sandbox_workspace_write.network_access=false");
  });

  it("does not pass workspace-write config for read-only sandbox", () => {
    const { args } = buildExecArgs({
      sandbox: "read-only",
      networkAccess: false,
    });
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).not.toContain("sandbox_workspace_write.network_access=false");
  });
});
