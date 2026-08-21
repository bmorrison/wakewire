import { describe, expect, it } from "vitest";
import { CodexSdkAdapter } from "./codex-sdk.js";
import { PermanentError } from "./types.js";

describe("CodexSdkAdapter", () => {
  it("rejects networkAccess: true with PermanentError", async () => {
    const adapter = new CodexSdkAdapter({ debug: () => {} } as never);
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
