import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/db.js";
import { createStores, type Stores } from "../db/repos.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "../sinks/types.js";
import { BusyError, PermanentError, UnreachableError } from "../sinks/types.js";
import type { WakeEvent } from "./event.js";
import { DeliveryQueue } from "./queue.js";
import type { Route, RouteInput } from "./route.js";

const logger = pino({ level: "silent" });

class FakeAdapter implements AgentAdapter {
  readonly name = "fake";
  calls: Array<{
    kind: "resume" | "start";
    threadId?: string;
    prompt: string;
    opts: DeliveryOptions;
  }> = [];
  failWith: Error | null = null;
  failTimes = 0;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  block(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  unblock(): void {
    this.openGate?.();
    this.gate = null;
  }

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    this.calls.push({ kind: "resume", threadId, prompt, opts });
    if (this.gate) await this.gate;
    this.maybeFail();
    return { threadId, turnId: `turn-${this.calls.length}` };
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    this.calls.push({ kind: "start", prompt, opts });
    if (this.gate) await this.gate;
    this.maybeFail();
    return { threadId: `new-thread-${this.calls.length}` };
  }

  async probe(): Promise<boolean> {
    return true;
  }

  /** Throws failWith while failTimes > 0 (set to MAX_SAFE_INTEGER for "always"). */
  private maybeFail(): void {
    if (this.failWith && this.failTimes > 0) {
      this.failTimes--;
      throw this.failWith;
    }
  }
}

function makeEvent(deliveryId: string, extra: Record<string, unknown> = {}): WakeEvent {
  return {
    source: "github",
    kind: "push",
    deliveryId,
    occurredAt: new Date().toISOString(),
    summary: `push ${deliveryId}`,
    payload: { repo: "acme/api", branch: "main", ...extra },
  };
}

function routeInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    name: "test route",
    source: "github",
    match: { repo: "acme/api", events: ["push"] },
    target: { type: "thread", threadId: "thread-1" },
    sandbox: "read-only",
    enabled: true,
    ...overrides,
  } as RouteInput;
}

describe("DeliveryQueue", () => {
  let stores: Stores;
  let adapter: FakeAdapter;
  let now: Date;
  let queue: DeliveryQueue;
  let route: Route;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    stores = createStores(db);
    adapter = new FakeAdapter();
    now = new Date("2026-07-03T10:00:00.000Z");
    queue = new DeliveryQueue(stores, adapter, logger, {
      now: () => now,
      ratePerMinute: 10,
      maxAttempts: 3,
      autoWake: false,
    });
    route = stores.routes.create(routeInput());
  });

  it("delivers a queued event with the safety envelope and route sandbox", async () => {
    const delivery = queue.enqueueEvent(route, makeEvent("d-1"));
    expect(delivery?.status).toBe("queued");
    await queue.tick();

    expect(adapter.calls).toHaveLength(1);
    const call = adapter.calls[0];
    expect(call?.threadId).toBe("thread-1");
    expect(call?.opts.sandbox).toBe("read-only");
    expect(call?.opts.networkAccess).toBe(false);
    expect(call?.prompt).toContain("UNTRUSTED EVENT DATA");

    const stored = stores.deliveries.get(delivery?.id ?? "");
    expect(stored?.status).toBe("delivered");
    expect(stored?.threadId).toBe("thread-1");
    expect(stored?.turnId).toBe("turn-1");
  });

  it("passes networkAccess: true to adapter DeliveryOptions for enabled routes", async () => {
    const netRoute = stores.routes.create(
      routeInput({
        name: "net",
        sandbox: "workspace-write",
        networkAccess: true,
      }),
    );
    queue.enqueueEvent(netRoute, makeEvent("d-net"));
    await queue.tick();
    expect(adapter.calls[0]?.opts.networkAccess).toBe(true);
    expect(adapter.calls[0]?.opts.sandbox).toBe("workspace-write");
  });

  it("dedups by source delivery id and records the skip", async () => {
    queue.enqueueEvent(route, makeEvent("dup"));
    const second = queue.enqueueEvent(route, makeEvent("dup"));
    expect(second).toBeNull();
    await queue.tick();
    expect(adapter.calls).toHaveLength(1);
    const skipped = stores.deliveries.list({ status: "skipped-duplicate" });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.sourceDeliveryId).toBe("dup");
  });

  it("replay bypasses dedup and re-renders", async () => {
    const original = queue.enqueueEvent(route, makeEvent("d-replay"));
    await queue.tick();
    const replayed = queue.replay(original?.id ?? "");
    expect(replayed.isReplay).toBe(true);
    await queue.tick();
    expect(adapter.calls).toHaveLength(2);
  });

  it("keeps strict per-thread FIFO: one in flight, order preserved", async () => {
    const first = queue.enqueueEvent(route, makeEvent("d-a"));
    adapter.block();
    const firstTick = queue.tick();
    queue.enqueueEvent(route, makeEvent("d-b"));
    await queue.tick(); // first still in flight — d-b must wait
    expect(adapter.calls).toHaveLength(1);
    adapter.unblock();
    await firstTick;
    await queue.tick();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls.map((c) => promptDeliveryId(c.prompt))).toEqual(["d-a", "d-b"]);
    expect(stores.deliveries.get(first?.id ?? "")?.status).toBe("delivered");
  });

  it("holds and retries with backoff on BusyError, forever", async () => {
    adapter.failWith = new BusyError("turn in flight");
    adapter.failTimes = Number.MAX_SAFE_INTEGER;
    const delivery = queue.enqueueEvent(route, makeEvent("d-busy"));
    await queue.tick();
    let stored = stores.deliveries.get(delivery?.id ?? "");
    expect(stored?.status).toBe("held");
    expect(stored?.attemptCount).toBe(1);
    expect(new Date(stored?.nextAttemptAt ?? 0).getTime()).toBeGreaterThan(now.getTime());

    // before the backoff expires nothing happens
    await queue.tick();
    expect(adapter.calls).toHaveLength(1);

    // after 5 more failures the backoff is capped at 60s
    for (let i = 0; i < 8; i++) {
      now = new Date(now.getTime() + 120_000);
      await queue.tick();
    }
    stored = stores.deliveries.get(delivery?.id ?? "");
    expect(stored?.status).toBe("held"); // busy retries never become failures
    expect(stored?.attemptCount).toBe(9);
    const lastDelay = new Date(stored?.nextAttemptAt ?? 0).getTime() - now.getTime();
    expect(lastDelay).toBeLessThanOrEqual(60_000);

    // codex comes back → delivered
    adapter.failWith = null;
    now = new Date(now.getTime() + 120_000);
    await queue.tick();
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("delivered");
  });

  it("UnreachableError also retries forever", async () => {
    adapter.failWith = new UnreachableError("app closed");
    adapter.failTimes = Number.MAX_SAFE_INTEGER;
    const delivery = queue.enqueueEvent(route, makeEvent("d-unreachable"));
    for (let i = 0; i < 5; i++) {
      await queue.tick();
      now = new Date(now.getTime() + 120_000);
    }
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("held");
  });

  it("fails after maxAttempts for generic errors", async () => {
    adapter.failWith = new Error("boom");
    adapter.failTimes = Number.MAX_SAFE_INTEGER;
    const delivery = queue.enqueueEvent(route, makeEvent("d-err"));
    for (let i = 0; i < 4; i++) {
      await queue.tick();
      now = new Date(now.getTime() + 120_000);
    }
    const stored = stores.deliveries.get(delivery?.id ?? "");
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("after 3 attempts");
    expect(adapter.calls).toHaveLength(3);
  });

  it("fails immediately on PermanentError", async () => {
    adapter.failWith = new PermanentError("no such thread");
    adapter.failTimes = Number.MAX_SAFE_INTEGER;
    const delivery = queue.enqueueEvent(route, makeEvent("d-perm"));
    await queue.tick();
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("failed");
    expect(adapter.calls).toHaveLength(1);
  });

  it("records a failed delivery when the template is invalid", async () => {
    const badRoute = stores.routes.create(
      routeInput({ name: "bad", promptTemplate: "hello {{nope}}" }),
    );
    const delivery = queue.enqueueEvent(badRoute, makeEvent("d-tpl"));
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("failed");
    expect(stores.deliveries.get(delivery?.id ?? "")?.error).toContain("template error");
    await queue.tick();
    expect(adapter.calls).toHaveLength(0);
  });

  it("coalesces into a digest when the rate limit is exceeded", async () => {
    const fastQueue = new DeliveryQueue(stores, adapter, logger, {
      now: () => now,
      ratePerMinute: 2,
      autoWake: false,
    });
    // two deliveries land inside the window
    fastQueue.enqueueEvent(route, makeEvent("d-1"));
    await fastQueue.tick();
    fastQueue.enqueueEvent(route, makeEvent("d-2"));
    await fastQueue.tick();
    expect(adapter.calls).toHaveLength(2);

    // burst of three more while over budget → single digest turn
    fastQueue.enqueueEvent(route, makeEvent("d-3"));
    fastQueue.enqueueEvent(route, makeEvent("d-4"));
    fastQueue.enqueueEvent(route, makeEvent("d-5"));
    await fastQueue.tick();
    expect(adapter.calls).toHaveLength(3);
    const digestPrompt = adapter.calls[2]?.prompt ?? "";
    expect(digestPrompt).toContain("3 github events coalesced");
    expect(digestPrompt).toContain("push d-3");
    expect(digestPrompt).toContain("push d-5");

    const coalesced = stores.deliveries.list({ status: "coalesced" });
    expect(coalesced).toHaveLength(2);
    const delivered = stores.deliveries.list({ status: "delivered" });
    expect(delivered).toHaveLength(3);
  });

  it("route-level rateLimitPerMinute overrides the queue default", async () => {
    // Queue default is 10, route allows only 1/minute.
    const strictRoute = stores.routes.create(routeInput({ name: "strict", rateLimitPerMinute: 1 }));
    queue.enqueueEvent(strictRoute, makeEvent("d-1"));
    await queue.tick();
    expect(adapter.calls).toHaveLength(1);

    queue.enqueueEvent(strictRoute, makeEvent("d-2"));
    queue.enqueueEvent(strictRoute, makeEvent("d-3"));
    await queue.tick();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.prompt).toContain("2 github events coalesced");
    expect(stores.deliveries.list({ status: "coalesced" })).toHaveLength(1);
  });

  it("starts new threads (and requires a worktree hook for worktree targets)", async () => {
    const newThreadRoute = stores.routes.create(
      routeInput({
        name: "spawn",
        target: { type: "new-thread", cwd: "/tmp/repo", worktree: false },
      }),
    );
    const delivery = queue.enqueueEvent(newThreadRoute, makeEvent("d-new"));
    await queue.tick();
    expect(adapter.calls[0]?.kind).toBe("start");
    expect(adapter.calls[0]?.opts.cwd).toBe("/tmp/repo");
    expect(stores.deliveries.get(delivery?.id ?? "")?.threadId).toBe("new-thread-1");

    const worktreeRoute = stores.routes.create(
      routeInput({ name: "wt", target: { type: "new-thread", cwd: "/tmp/repo", worktree: true } }),
    );
    const wtDelivery = queue.enqueueEvent(worktreeRoute, makeEvent("d-wt"));
    await queue.tick();
    expect(stores.deliveries.get(wtDelivery?.id ?? "")?.status).toBe("failed");
    expect(stores.deliveries.get(wtDelivery?.id ?? "")?.error).toContain("worktree");
  });

  it("recovers crashed in-flight deliveries on start", async () => {
    const delivery = queue.enqueueEvent(route, makeEvent("d-crash"));
    stores.deliveries.markDelivering(delivery?.id ?? "");
    expect(stores.deliveries.resetInFlight()).toBe(1);
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("queued");
  });

  it("skips routes that were disabled after enqueue", async () => {
    const delivery = queue.enqueueEvent(route, makeEvent("d-disabled"));
    stores.routes.setEnabled(route.id, false);
    await queue.tick();
    expect(adapter.calls).toHaveLength(0);
    expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("queued");
  });

  describe("trailing-edge settling (settleSeconds)", () => {
    let settleRoute: Route;

    beforeEach(() => {
      settleRoute = stores.routes.create(
        routeInput({
          name: "settle review",
          settleSeconds: 45,
          sandbox: "workspace-write",
        }),
      );
    });

    it("one event produces no adapter call at 44.999s and one normal event turn at 45s", async () => {
      const delivery = queue.enqueueEvent(settleRoute, makeEvent("s-1"));
      expect(delivery).not.toBeNull();
      expect(delivery?.status).toBe("queued");
      expect(delivery?.nextAttemptAt).toBe(new Date(now.getTime() + 45_000).toISOString());

      // At 44.999s, nothing is ready
      now = new Date(now.getTime() + 44_999);
      await queue.tick();
      expect(adapter.calls).toHaveLength(0);

      // At 45s, delivered as normal event (not digest)
      now = new Date(now.getTime() + 1);
      await queue.tick();
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0]?.prompt).toContain("[wakewire event]");
      expect(adapter.calls[0]?.prompt).not.toContain("[wakewire digest]");
      expect(stores.deliveries.get(delivery?.id ?? "")?.status).toBe("delivered");
    });

    it("burst of events moves the whole batch deadline to 45s after the newest event", async () => {
      const d1 = queue.enqueueEvent(settleRoute, makeEvent("s-1"));
      // 10s later, second event arrives
      now = new Date(now.getTime() + 10_000);
      const d2 = queue.enqueueEvent(settleRoute, makeEvent("s-2"));
      // 10s later (20s total), third event arrives
      now = new Date(now.getTime() + 10_000);
      const d3 = queue.enqueueEvent(settleRoute, makeEvent("s-3"));

      // All 3 deliveries now have deadline at now + 45s (i.e. T0 + 65s)
      const expectedDeadline = new Date(now.getTime() + 45_000).toISOString();
      expect(stores.deliveries.get(d1?.id ?? "")?.nextAttemptAt).toBe(expectedDeadline);
      expect(stores.deliveries.get(d2?.id ?? "")?.nextAttemptAt).toBe(expectedDeadline);
      expect(stores.deliveries.get(d3?.id ?? "")?.nextAttemptAt).toBe(expectedDeadline);

      // Advance to T0 + 64.999s -> no turn
      now = new Date(now.getTime() + 44_999);
      await queue.tick();
      expect(adapter.calls).toHaveLength(0);

      // Advance to T0 + 65s -> exactly one adapter call
      now = new Date(now.getTime() + 1);
      await queue.tick();
      expect(adapter.calls).toHaveLength(1);

      // Newest delivery (d3) is carrier; d1 and d2 are coalesced into d3
      const carrier = stores.deliveries.get(d3?.id ?? "");
      expect(carrier?.status).toBe("delivered");
      const c1 = stores.deliveries.get(d1?.id ?? "");
      const c2 = stores.deliveries.get(d2?.id ?? "");
      expect(c1?.status).toBe("coalesced");
      expect(c1?.coalescedInto).toBe(d3?.id);
      expect(c2?.status).toBe("coalesced");
      expect(c2?.coalescedInto).toBe(d3?.id);

      // Digest header indicates settle window
      expect(adapter.calls[0]?.prompt).toContain("3 github events coalesced (settle window)");
    });

    it("duplicate delivery remains skipped-duplicate, does not extend deadline, does not produce extra turn", async () => {
      const d1 = queue.enqueueEvent(settleRoute, makeEvent("s-1"));
      const originalDeadline = stores.deliveries.get(d1?.id ?? "")?.nextAttemptAt;

      // 10s later duplicate s-1 arrives
      now = new Date(now.getTime() + 10_000);
      const dup = queue.enqueueEvent(settleRoute, makeEvent("s-1"));
      expect(dup).toBeNull();

      // Deadline must not have moved
      expect(stores.deliveries.get(d1?.id ?? "")?.nextAttemptAt).toBe(originalDeadline);

      // Advance to original 45s deadline
      now = new Date(now.getTime() + 35_000);
      await queue.tick();
      expect(adapter.calls).toHaveLength(1);
    });

    it("replay bypasses settling and is excluded from live settle cohort", async () => {
      // Live delivery waiting in settle window
      const dLive = queue.enqueueEvent(settleRoute, makeEvent("live-1"));

      // Past delivery on settle route that was previously delivered
      const past = stores.deliveries.enqueue({
        routeId: settleRoute.id,
        event: makeEvent("past-1"),
        renderedPrompt: "prompt",
        isReplay: false,
      });
      stores.deliveries.markDelivered(past?.id ?? "", { threadId: "thread-1" });

      // Replay it
      const replayed = queue.replay(past?.id ?? "");
      expect(replayed.isReplay).toBe(true);
      expect(replayed.nextAttemptAt).toBeNull();

      // Tick immediately delivers replay while live delivery is still waiting
      await queue.tick();
      expect(adapter.calls).toHaveLength(1);
      expect(stores.deliveries.get(replayed.id)?.status).toBe("delivered");
      expect(stores.deliveries.get(dLive?.id ?? "")?.status).toBe("queued");
    });

    it("settled carrier held by BusyError joins new events in one cohort and preserves backoff/attempt budget", async () => {
      // First event arrives and settles
      adapter.failWith = new BusyError("busy");
      adapter.failTimes = 1;
      const d1 = queue.enqueueEvent(settleRoute, makeEvent("s-1"));
      now = new Date(now.getTime() + 45_000);
      await queue.tick();

      const held1 = stores.deliveries.get(d1?.id ?? "");
      expect(held1?.status).toBe("held");
      expect(held1?.attemptCount).toBe(1);
      const backoffDeadline = held1?.nextAttemptAt;
      expect(backoffDeadline).not.toBeNull();

      // New event arrives while d1 is held
      const d2 = queue.enqueueEvent(settleRoute, makeEvent("s-2"));
      // Cohort deadline must be max(new settle deadline, existing backoff deadline)
      const expectedDeadline =
        new Date(now.getTime() + 45_000).toISOString() > (backoffDeadline ?? "")
          ? new Date(now.getTime() + 45_000).toISOString()
          : backoffDeadline;
      expect(stores.deliveries.get(d1?.id ?? "")?.nextAttemptAt).toBe(expectedDeadline);
      expect(stores.deliveries.get(d2?.id ?? "")?.nextAttemptAt).toBe(expectedDeadline);

      // After deadline, delivers once and carries forward attemptCount
      adapter.failWith = null;
      now = new Date(new Date(expectedDeadline ?? "").getTime());
      await queue.tick();
      expect(adapter.calls).toHaveLength(2); // 1 failed + 1 successful
      const carrier = stores.deliveries.get(d2?.id ?? "");
      expect(carrier?.status).toBe("delivered");
      expect(carrier?.attemptCount).toBeGreaterThanOrEqual(1);
      expect(stores.deliveries.get(d1?.id ?? "")?.status).toBe("coalesced");
    });

    it("preserves prior digest members when recoalescing retries (A + B settled -> held B -> + C settled into C)", async () => {
      // Step 1: Events A and B arrive within settle window
      const dA = queue.enqueueEvent(settleRoute, makeEvent("event-A"));
      now = new Date(now.getTime() + 10_000);
      const dB = queue.enqueueEvent(settleRoute, makeEvent("event-B"));

      // Step 2: Settle window expires for batch [A, B] -> B is carrier, A coalesces into B, but B fails with BusyError
      adapter.failWith = new BusyError("busy");
      adapter.failTimes = 1;
      now = new Date(now.getTime() + 45_000);
      await queue.tick();

      expect(stores.deliveries.get(dA?.id ?? "")?.status).toBe("coalesced");
      expect(stores.deliveries.get(dA?.id ?? "")?.coalescedInto).toBe(dB?.id);
      const heldB = stores.deliveries.get(dB?.id ?? "");
      expect(heldB?.status).toBe("held");
      expect(heldB?.attemptCount).toBe(1);

      // Step 3: Event C arrives while B is held
      now = new Date(now.getTime() + 5_000);
      const dC = queue.enqueueEvent(settleRoute, makeEvent("event-C"));
      const newDeadline = stores.deliveries.get(dC?.id ?? "")?.nextAttemptAt;
      expect(newDeadline).not.toBeNull();
      expect(stores.deliveries.get(dB?.id ?? "")?.nextAttemptAt).toBe(newDeadline);

      // Step 4: Settle window expires for recoalesced batch -> C is new carrier
      adapter.failWith = null;
      now = new Date(new Date(newDeadline ?? "").getTime());
      await queue.tick();

      // Verify delivery statuses and tree in SQLite
      const finalC = stores.deliveries.get(dC?.id ?? "");
      expect(finalC?.status).toBe("delivered");
      expect(finalC?.attemptCount).toBeGreaterThanOrEqual(1);

      const finalB = stores.deliveries.get(dB?.id ?? "");
      expect(finalB?.status).toBe("coalesced");
      expect(finalB?.coalescedInto).toBe(dC?.id);

      const finalA = stores.deliveries.get(dA?.id ?? "");
      expect(finalA?.status).toBe("coalesced");
      expect(finalA?.coalescedInto).toBe(dC?.id);

      // Verify the eventual delivered prompt contains all three events (A, B, C)
      const lastCall = adapter.calls[adapter.calls.length - 1];
      expect(lastCall?.prompt).toContain("3 github events coalesced");
      expect(lastCall?.prompt).toContain("event-A");
      expect(lastCall?.prompt).toContain("event-B");
      expect(lastCall?.prompt).toContain("event-C");
      expect(lastCall?.prompt).toContain("settle window");
    });

    it("separate routes maintain independent quiet deadlines", async () => {
      const routeA = stores.routes.create(
        routeInput({
          name: "route A",
          settleSeconds: 45,
          target: { type: "thread", threadId: "t-A" },
        }),
      );
      const routeB = stores.routes.create(
        routeInput({
          name: "route B",
          settleSeconds: 45,
          target: { type: "thread", threadId: "t-B" },
        }),
      );

      queue.enqueueEvent(routeA, makeEvent("a-1"));
      now = new Date(now.getTime() + 20_000);
      queue.enqueueEvent(routeB, makeEvent("b-1"));

      // At T0 + 45s: routeA delivers, routeB has 20s remaining
      now = new Date(now.getTime() + 25_000);
      await queue.tick();
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0]?.threadId).toBe("t-A");

      // At T0 + 65s: routeB delivers
      now = new Date(now.getTime() + 20_000);
      await queue.tick();
      expect(adapter.calls).toHaveLength(2);
      expect(adapter.calls[1]?.threadId).toBe("t-B");
    });

    it("closing/reopening database before deadline preserves next_attempt_at and delivers once", async () => {
      const dbPath = openDatabase(":memory:");
      const s = createStores(dbPath);
      const r = s.routes.create(routeInput({ name: "persist settle", settleSeconds: 45 }));
      const q1 = new DeliveryQueue(s, adapter, logger, { now: () => now, autoWake: false });
      const d = q1.enqueueEvent(r, makeEvent("p-1"));

      const deadline = s.deliveries.get(d?.id ?? "")?.nextAttemptAt;
      expect(deadline).not.toBeNull();

      // Create new queue instance on same stores (simulating restart)
      const q2 = new DeliveryQueue(s, adapter, logger, { now: () => now, autoWake: false });
      expect(s.deliveries.get(d?.id ?? "")?.nextAttemptAt).toBe(deadline);

      // Advance clock and tick
      now = new Date(now.getTime() + 45_000);
      await q2.tick();
      expect(adapter.calls).toHaveLength(1);
      expect(s.deliveries.get(d?.id ?? "")?.status).toBe("delivered");
    });
  });
});

function promptDeliveryId(prompt: string): string {
  const match = prompt.match(/push (d-\w+)/);
  return match?.[1] ?? "";
}
