import { describe, expect, it } from "vitest";
import { type ApiContext, createApi } from "./api.js";

function makeFakeContext(overrides: Partial<ApiContext> = {}): ApiContext {
  return {
    stores: {
      routes: { list: () => [] },
      sources: { list: () => [], findByKind: () => [] },
      deliveries: { list: () => [], countPending: () => 0 },
    } as never,
    queue: { queueDepth: () => 0, replay: () => ({}) as never } as never,
    sources: { statuses: () => ({}) } as never,
    secrets: { backend: "in-memory" } as never,
    adapter: {
      name: "codex-app-server",
      probe: async () => true,
    } as never,
    config: {
      apiToken: "test-token",
      appServerListen: "ws://127.0.0.1:4571",
    } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    startedAt: "2026-07-03T10:00:00.000Z",
    ...overrides,
  };
}

describe("GET /api/health", () => {
  it("reports adapter capability and shared server configuration for codex-app-server", async () => {
    const ctx = makeFakeContext({
      adapter: { name: "codex-app-server", probe: async () => true } as never,
      config: { apiToken: "test-token", appServerListen: "ws://127.0.0.1:4571" } as never,
    });
    const app = createApi(ctx);
    const res = await app.request("/api/health", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      adapter: { networkEnabledRoutesSupported: boolean; sharedServerConfigured: boolean };
    };
    expect(body.adapter.networkEnabledRoutesSupported).toBe(true);
    expect(body.adapter.sharedServerConfigured).toBe(true);
  });

  it("reports false for non-app-server adapters and unconfigured listen URL", async () => {
    const ctx = makeFakeContext({
      adapter: { name: "codex-sdk", probe: async () => true } as never,
      config: { apiToken: "test-token", appServerListen: undefined } as never,
    });
    const app = createApi(ctx);
    const res = await app.request("/api/health", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      adapter: { networkEnabledRoutesSupported: boolean; sharedServerConfigured: boolean };
    };
    expect(body.adapter.networkEnabledRoutesSupported).toBe(false);
    expect(body.adapter.sharedServerConfigured).toBe(false);
  });
});
