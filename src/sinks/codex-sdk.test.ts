import { describe, expect, it } from "vitest";
import { buildSdkThreadOptions, CodexSdkAdapter } from "./codex-sdk.js";
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

  it("explicitly sets networkAccessEnabled: false for workspace-write when networkAccess is false", () => {
    const options = buildSdkThreadOptions({
      sandbox: "workspace-write",
      networkAccess: false,
    });
    expect(options.sandboxMode).toBe("workspace-write");
    expect(options.networkAccessEnabled).toBe(false);
  });

  it("explicitly sets networkAccessEnabled: false for workspace-write when networkAccess is omitted/default", () => {
    const options = buildSdkThreadOptions({
      sandbox: "workspace-write",
    } as never);
    expect(options.sandboxMode).toBe("workspace-write");
    expect(options.networkAccessEnabled).toBe(false);
  });

  it("does not set networkAccessEnabled on read-only sandbox", () => {
    const options = buildSdkThreadOptions({
      sandbox: "read-only",
      networkAccess: false,
    });
    expect(options.sandboxMode).toBe("read-only");
    expect(options.networkAccessEnabled).toBeUndefined();
  });
});
