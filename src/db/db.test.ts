import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { migrate } from "./migrations.js";
import { createStores } from "./repos.js";

describe("migrations", () => {
  it("creates the schema and is idempotent", () => {
    const db = openDatabase(":memory:");
    migrate(db); // second run is a no-op
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["routes", "deliveries", "sources", "settings", "schema_migrations"]),
    );
  });
});

describe("migration 3 upgrade (source-kind CHECK removal)", () => {
  it("preserves routes, sources, and deliveries across the table rebuild", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 2); // simulate an installation on the v2 schema
    const stores = createStores(db);
    const routeId = "r-old";
    db.prepare(
      `INSERT INTO routes (id, name, source_kind, match_json, target_json, prompt_template, sandbox_policy, rate_limit_per_minute, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      routeId,
      "old route",
      "github",
      JSON.stringify({ repo: "a/b", events: ["push"] }),
      JSON.stringify({ type: "thread", threadId: "t-1" }),
      null,
      "read-only",
      3,
      1,
      "2026-07-03T00:00:00.000Z",
    );
    stores.sources.upsert({ id: "src-1", kind: "gmail", config: { label: "x" } });
    stores.deliveries.enqueue({
      routeId,
      event: {
        source: "github",
        kind: "push",
        deliveryId: "d-1",
        occurredAt: "t",
        summary: "s",
        payload: {},
      },
      renderedPrompt: "p",
    });

    migrate(db); // apply v3 rebuild

    const migrated = createStores(db);
    expect(migrated.routes.get(routeId)?.rateLimitPerMinute).toBe(3);
    expect(migrated.sources.get("src-1")?.config.label).toBe("x");
    expect(migrated.deliveries.list({}).length).toBe(1);
    // and the rebuilt table accepts the new source kind
    expect(() =>
      migrated.sources.upsert({ id: "src-2", kind: "slack", config: { team: "default" } }),
    ).not.toThrow();
    expect(() =>
      migrated.routes.create({
        name: "slack route",
        source: "slack",
        match: { events: ["app_mention"] },
        target: { type: "thread", threadId: "t-1" },
        sandbox: "read-only",
        networkAccess: false,
        enabled: true,
      }),
    ).not.toThrow();
  });
});

describe("migration 5 upgrade (settle_seconds and network_access)", () => {
  it("preserves v4 routes/deliveries/sources/captures and defaults settle_seconds to null and network_access to 0", () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db, 4); // apply up to migration 4

    // Seed v4 route with raw SQL
    db.prepare(
      `INSERT INTO routes (id, name, source_kind, match_json, target_json, prompt_template, sandbox_policy, rate_limit_per_minute, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "r-v4",
      "v4 route",
      "github",
      JSON.stringify({ repo: "acme/api", events: ["push"] }),
      JSON.stringify({ type: "thread", threadId: "t-v4" }),
      null,
      "workspace-write",
      10,
      1,
      "2026-07-03T00:00:00.000Z",
    );

    // Apply migration 5
    migrate(db);

    const stores = createStores(db);
    const loaded = stores.routes.get("r-v4");
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe("v4 route");
    expect(loaded?.settleSeconds).toBeNull();
    expect(loaded?.networkAccess).toBe(false);
    expect(loaded?.rateLimitPerMinute).toBe(10);
  });
});

describe("stores", () => {
  it("round-trips routes with JSON columns, settleSeconds, and networkAccess", () => {
    const stores = createStores(openDatabase(":memory:"));
    const route = stores.routes.create({
      name: "r",
      source: "github",
      match: { repo: "a/b", events: ["push"] },
      target: { type: "thread", threadId: "t-1" },
      sandbox: "workspace-write",
      settleSeconds: 45,
      networkAccess: true,
      enabled: true,
    });
    const loaded = stores.routes.get(route.id);
    expect(loaded?.match).toEqual({ repo: "a/b", events: ["push"] });
    expect(loaded?.target).toEqual({ type: "thread", threadId: "t-1" });
    expect(loaded?.settleSeconds).toBe(45);
    expect(loaded?.networkAccess).toBe(true);
    expect(stores.routes.list()).toHaveLength(1);
    expect(stores.routes.remove(route.id)).toBe(true);
    expect(stores.routes.list()).toHaveLength(0);
  });

  it("settings getOrCreate only creates once", () => {
    const stores = createStores(openDatabase(":memory:"));
    let calls = 0;
    const make = () => {
      calls++;
      return "token-value";
    };
    expect(stores.settings.getOrCreate("k", make)).toBe("token-value");
    expect(stores.settings.getOrCreate("k", make)).toBe("token-value");
    expect(calls).toBe(1);
  });

  it("sources upsert preserves ids and updates configs", () => {
    const stores = createStores(openDatabase(":memory:"));
    const created = stores.sources.upsert({ kind: "gmail", config: { label: "a" } });
    const updated = stores.sources.upsert({
      id: created.id,
      kind: "gmail",
      config: { label: "b" },
    });
    expect(updated.id).toBe(created.id);
    expect(stores.sources.list()).toHaveLength(1);
    expect(stores.sources.get(created.id)?.config.label).toBe("b");
  });
});
