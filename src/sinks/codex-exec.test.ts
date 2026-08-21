import { describe, expect, it } from "vitest";
import { CodexExecAdapter, parseThreadId } from "./codex-exec.js";
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
});
