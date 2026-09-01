import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDaemonLifecycle, runDaemonWithShutdownSignals } from "./daemon.js";
import {
  acquireDaemonLock,
  DaemonAlreadyRunningError,
  isProcessAlive,
  withDaemonLock,
} from "./lock.js";

describe("Daemon lock", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-lock-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  class FakeSignalSource {
    private readonly handlers = new Map<NodeJS.Signals, Set<() => void>>();

    on(signal: NodeJS.Signals, listener: () => void): void {
      const listeners = this.handlers.get(signal) ?? new Set();
      listeners.add(listener);
      this.handlers.set(signal, listeners);
    }

    off(signal: NodeJS.Signals, listener: () => void): void {
      this.handlers.get(signal)?.delete(listener);
    }

    emit(signal: NodeJS.Signals): void {
      for (const listener of this.handlers.get(signal) ?? []) listener();
    }

    count(signal: NodeJS.Signals): number {
      return this.handlers.get(signal)?.size ?? 0;
    }
  }

  it("creates missing WAKEWIRE_HOME with mode 0700 during acquisition", async () => {
    const missingHome = path.join(tempHome, "nested", "home");
    const lock = await acquireDaemonLock({ home: missingHome });
    expect(fs.existsSync(missingHome)).toBe(true);
    const stat = fs.statSync(missingHome);
    // On POSIX check permissions mode mask
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o700);
    }
    await lock.release();
  });

  it("successfully acquires lock and writes owner.json with mode 0600", async () => {
    const lock = await acquireDaemonLock({ home: tempHome });
    const lockDir = path.join(tempHome, "daemon.lock");
    const ownerFile = path.join(lockDir, "owner.json");

    expect(fs.existsSync(ownerFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    expect(content.pid).toBe(process.pid);
    expect(content.token).toBe(lock.token);
    expect(typeof content.startedAt).toBe("string");

    if (process.platform !== "win32") {
      const stat = fs.statSync(ownerFile);
      expect(stat.mode & 0o777).toBe(0o600);
    }

    await lock.release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("rejects second acquisition when owner is alive", async () => {
    const lock = await acquireDaemonLock({
      home: tempHome,
      isProcessAlive: () => true,
    });

    await expect(acquireDaemonLock({ home: tempHome, isProcessAlive: () => true })).rejects.toThrow(
      DaemonAlreadyRunningError,
    );

    await lock.release();
  });

  it("probes ESRCH as dead and EPERM or unknown errors as alive", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-123)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
    let signal: number | undefined;
    expect(
      isProcessAlive(123, (_pid, receivedSignal) => {
        signal = receivedSignal;
      }),
    ).toBe(true);
    expect(signal).toBe(0);
    expect(
      isProcessAlive(123, () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }),
    ).toBe(false);
    expect(
      isProcessAlive(123, () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }),
    ).toBe(true);
    expect(
      isProcessAlive(123, () => {
        throw new Error("unexpected probe failure");
      }),
    ).toBe(true);
  });

  it("reclaims stale lease if owner PID is dead", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 9999999, token: "dead-token", startedAt: new Date().toISOString() }),
    );

    const lock = await acquireDaemonLock({
      home: tempHome,
      isProcessAlive: (pid) => pid !== 9999999,
    });

    expect(lock.token).not.toBe("dead-token");
    await lock.release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "treats invalid owner PID %p as malformed without probing",
    async (pid) => {
      const lockDir = path.join(tempHome, "daemon.lock");
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid, token: "invalid-pid", startedAt: new Date().toISOString() }),
      );
      const stat = fs.statSync(lockDir);
      let probeCalls = 0;

      const lock = await acquireDaemonLock({
        home: tempHome,
        clock: () => stat.mtimeMs + 6000,
        isProcessAlive: () => {
          probeCalls += 1;
          return false;
        },
      });

      expect(probeCalls).toBe(0);
      await lock.release();
    },
  );

  it("does not remove a fresh incomplete lock (< 5 seconds old)", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    const stat = fs.statSync(lockDir);

    const now = stat.mtimeMs + 2000; // 2 seconds old
    await expect(
      acquireDaemonLock({
        home: tempHome,
        clock: () => now,
        isProcessAlive: () => false,
      }),
    ).rejects.toThrow(DaemonAlreadyRunningError);

    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("reclaims an old incomplete or malformed lock (>= 5 seconds old)", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, "owner.json"), "invalid json content");
    const stat = fs.statSync(lockDir);

    const now = stat.mtimeMs + 6000; // 6 seconds old
    const lock = await acquireDaemonLock({
      home: tempHome,
      clock: () => now,
      isProcessAlive: () => false,
    });

    expect(lock).toBeDefined();
    await lock.release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("serializes staged reclaimers so a stale observer cannot remove the replacement", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 777, token: "stale-owner", startedAt: new Date().toISOString() }),
    );

    let contender: Promise<unknown> | undefined;
    const winner = await acquireDaemonLock({
      home: tempHome,
      isProcessAlive: () => false,
      onReclaimClaimed: () => {
        // This contender has already observed the same dead owner, but the
        // exclusive reclaim claim makes it fail before it can touch the lease.
        contender = acquireDaemonLock({ home: tempHome, isProcessAlive: () => false });
      },
    });

    await expect(contender).rejects.toThrow(DaemonAlreadyRunningError);
    const replacement = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    expect(replacement.token).toBe(winner.token);
    await winner.release();
  });

  it("leaves a replacement untouched when a stale contender resumes after reclamation", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 777, token: "stale-owner", startedAt: new Date().toISOString() }),
    );

    let replacement: Awaited<ReturnType<typeof acquireDaemonLock>> | undefined;
    const delayed = acquireDaemonLock({
      home: tempHome,
      isProcessAlive: () => false,
      onBeforeReclaim: async () => {
        replacement = await acquireDaemonLock({ home: tempHome, isProcessAlive: () => false });
      },
    });

    await expect(delayed).rejects.toThrow(DaemonAlreadyRunningError);
    expect(replacement).toBeDefined();
    const current = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    expect(current.token).toBe(replacement?.token);
    expect(fs.existsSync(`${lockDir}.reclaiming`)).toBe(false);

    await replacement?.release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("reclaims a dead in-lock reclaimer and removes its marker with the stale lock", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    const claimDir = path.join(lockDir, "reclaiming");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 777, token: "dead-owner", startedAt: new Date().toISOString() }),
    );
    fs.mkdirSync(claimDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(claimDir, "owner.json"),
      JSON.stringify({ pid: 778, token: "dead-reclaimer", startedAt: new Date().toISOString() }),
    );

    const lock = await acquireDaemonLock({ home: tempHome, isProcessAlive: () => false });
    expect(fs.existsSync(claimDir)).toBe(false);
    await lock.release();
  });

  it("recovers after repeated reclaimer crashes and clears all retained markers", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 777, token: "stale-main", startedAt: new Date().toISOString() }),
    );
    fs.mkdirSync(path.join(lockDir, "reclaimed-first"), { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "reclaimed-first", "owner.json"),
      JSON.stringify({ pid: 778, token: "first", startedAt: new Date().toISOString() }),
    );
    fs.mkdirSync(path.join(lockDir, "reclaiming"), { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "reclaiming", "owner.json"),
      JSON.stringify({ pid: 779, token: "second", startedAt: new Date().toISOString() }),
    );

    const lock = await acquireDaemonLock({ home: tempHome, isProcessAlive: () => false });
    expect(fs.existsSync(path.join(lockDir, "reclaiming"))).toBe(false);
    expect(fs.existsSync(path.join(lockDir, "reclaimed-first"))).toBe(false);
    expect(fs.existsSync(path.join(lockDir, "owner.json"))).toBe(true);
    await lock.release();
  });

  it("fails closed for an incomplete in-lock reclaimer claim", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    const claimDir = path.join(lockDir, "reclaiming");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 777, token: "dead-owner", startedAt: new Date().toISOString() }),
    );
    fs.mkdirSync(claimDir, { mode: 0o700 });
    await expect(
      acquireDaemonLock({ home: tempHome, isProcessAlive: () => false }),
    ).rejects.toThrow(DaemonAlreadyRunningError);
    expect(fs.existsSync(claimDir)).toBe(true);
  });

  it("reclaims an aged incomplete marker without letting its paused creator replace the winner", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 777, token: "dead-owner", startedAt: new Date().toISOString() }),
    );

    let winner: Promise<Awaited<ReturnType<typeof acquireDaemonLock>>> | undefined;
    const pausedCreator = acquireDaemonLock({
      home: tempHome,
      isProcessAlive: () => false,
      onReclamationDirectoryCreated: async () => {
        const marker = fs.statSync(path.join(lockDir, "reclaiming"));
        winner = acquireDaemonLock({
          home: tempHome,
          clock: () => marker.mtimeMs + 6000,
          isProcessAlive: () => false,
        });
        await winner;
      },
    });

    await expect(pausedCreator).rejects.toThrow();
    const replacement = await winner;
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    expect(owner.token).toBe(replacement?.token);
    expect(fs.existsSync(path.join(lockDir, "reclaiming"))).toBe(false);
    await replacement?.release();
  });

  it("blocks a delayed observer of a stale reclaimer generation from replacing the winner", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    const mainToken = "stale-main";
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 777, token: mainToken, startedAt: new Date().toISOString() }),
    );
    fs.mkdirSync(path.join(lockDir, "reclaiming"), { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "reclaiming", "owner.json"),
      JSON.stringify({ pid: 778, token: "stale-guard", startedAt: new Date().toISOString() }),
    );

    let delayed: Promise<unknown> | undefined;
    const winner = await acquireDaemonLock({
      home: tempHome,
      isProcessAlive: (pid) => pid === process.pid,
      onReclaimClaimed: () => {
        delayed = acquireDaemonLock({
          home: tempHome,
          isProcessAlive: (pid) => pid === process.pid,
        });
      },
    });

    await expect(delayed).rejects.toThrow(DaemonAlreadyRunningError);
    const replacement = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    expect(replacement.token).toBe(winner.token);
    expect(fs.existsSync(path.join(lockDir, "reclaiming"))).toBe(false);
    await winner.release();
  });

  it("fails closed while a reclaimer claim has a live owner", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    const claimDir = path.join(lockDir, "reclaiming");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 777, token: "dead-owner", startedAt: new Date().toISOString() }),
    );
    fs.mkdirSync(claimDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(claimDir, "owner.json"),
      JSON.stringify({ pid: 778, token: "live-reclaimer", startedAt: new Date().toISOString() }),
    );

    await expect(
      acquireDaemonLock({ home: tempHome, isProcessAlive: (pid) => pid === 778 }),
    ).rejects.toThrow(DaemonAlreadyRunningError);
    expect(fs.existsSync(claimDir)).toBe(true);
  });

  it("does not remove lock directory on release if ownership token has changed", async () => {
    const lock = await acquireDaemonLock({ home: tempHome });
    const lockDir = path.join(tempHome, "daemon.lock");
    const ownerFile = path.join(lockDir, "owner.json");

    // Simulate another process taking over the lock directory
    fs.writeFileSync(
      ownerFile,
      JSON.stringify({ pid: 8888, token: "another-token", startedAt: new Date().toISOString() }),
    );

    await lock.release();
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("release is idempotent and allows subsequent acquisitions", async () => {
    const lock1 = await acquireDaemonLock({ home: tempHome });
    await lock1.release();
    await lock1.release(); // second call is harmless

    const lock2 = await acquireDaemonLock({ home: tempHome });
    expect(lock2).toBeDefined();
    await lock2.release();
  });

  it("withDaemonLock executes callback and releases on resolve and reject", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");

    let executed = false;
    const res = await withDaemonLock(
      async () => {
        executed = true;
        expect(fs.existsSync(lockDir)).toBe(true);
        return 42;
      },
      { home: tempHome },
    );

    expect(executed).toBe(true);
    expect(res).toBe(42);
    expect(fs.existsSync(lockDir)).toBe(false);

    await expect(
      withDaemonLock(
        async () => {
          expect(fs.existsSync(lockDir)).toBe(true);
          throw new Error("test error");
        },
        { home: tempHome },
      ),
    ).rejects.toThrow("test error");

    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("stops the daemon before releasing its lease, then permits the hard-exit path", async () => {
    const events: string[] = [];
    const lockDir = path.join(tempHome, "daemon.lock");
    const hardExit = () => {
      // This represents runDaemon's process.exit call, which is deliberately
      // outside the lifecycle wrapper.
      expect(fs.existsSync(lockDir)).toBe(false);
      events.push("exit");
    };

    await runDaemonLifecycle(
      () => ({
        async start() {
          events.push("start");
        },
        async stop() {
          events.push("stop");
          expect(fs.existsSync(lockDir)).toBe(true);
        },
      }),
      async () => {
        events.push("signal");
      },
      { home: tempHome },
    );

    expect(fs.existsSync(lockDir)).toBe(false);
    hardExit();
    expect(events).toEqual(["start", "signal", "stop", "exit"]);
  });

  it("stops a partially started daemon before releasing its lease", async () => {
    const lockDir = path.join(tempHome, "daemon.lock");
    const failure = new Error("startup failed");

    await expect(
      runDaemonLifecycle(
        () => ({
          async start() {
            throw failure;
          },
          async stop() {
            expect(fs.existsSync(lockDir)).toBe(true);
          },
        }),
        async () => undefined,
        { home: tempHome },
      ),
    ).rejects.toBe(failure);

    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("keeps signal handlers through startup and repeated signals during stop", async () => {
    const source = new FakeSignalSource();
    const lockDir = path.join(tempHome, "daemon.lock");
    let beginStart!: () => void;
    let resolveStart!: () => void;
    let beginStop!: () => void;
    let resolveStop!: () => void;
    const started = new Promise<void>((resolve) => {
      beginStart = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      beginStop = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    const running = runDaemonWithShutdownSignals(
      () => ({
        async start() {
          beginStart();
          await startGate;
        },
        async stop() {
          beginStop();
          expect(fs.existsSync(lockDir)).toBe(true);
          await stopGate;
        },
      }),
      source,
      { home: tempHome },
    );

    await started;
    source.emit("SIGTERM");
    expect(source.count("SIGTERM")).toBe(1);
    resolveStart();
    await stopped;
    source.emit("SIGTERM");
    expect(source.count("SIGTERM")).toBe(1);
    resolveStop();
    await running;

    expect(fs.existsSync(lockDir)).toBe(false);
    expect(source.count("SIGINT")).toBe(0);
    expect(source.count("SIGTERM")).toBe(0);
  });
});
