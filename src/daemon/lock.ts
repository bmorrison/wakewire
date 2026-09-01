import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { daemonLockDir, wakewireHome } from "../paths.js";

const INCOMPLETE_LOCK_GRACE_MS = 5_000;

export class DaemonAlreadyRunningError extends Error {
  constructor(
    public readonly pid: number,
    public readonly home: string,
    message?: string,
  ) {
    super(
      message ??
        (pid > 0
          ? `daemon already running (pid ${pid}) in ${home}`
          : `daemon startup already in progress in ${home}`),
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

export interface DaemonOwnerRecord {
  pid: number;
  token: string;
  startedAt: string;
}

export interface DaemonLockHandle {
  pid: number;
  token: string;
  release(): Promise<void>;
}

export type ProcessProbe = (pid: number, signal: 0) => void;

export interface LockOptions {
  home?: string;
  lockDir?: string;
  clock?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  /** Test seam used to stage a delayed contender before it claims reclamation. */
  onBeforeReclaim?: () => Promise<void>;
  /** Test seam used to stage another contender after this reclaimer wins. */
  onReclaimClaimed?: () => void;
  /** Test seam used to stage a contender after the canonical marker mkdir. */
  onReclamationDirectoryCreated?: () => Promise<void>;
}

interface LockSnapshot {
  owner: DaemonOwnerRecord | null;
  malformed: boolean;
  mtimeMs: number;
}

interface ReclamationClaim {
  directory: string;
  token: string;
}

/** Probe a PID without treating lack of permission as proof it is dead. */
export function isProcessAlive(pid: number, probe: ProcessProbe = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ESRCH"
    ) {
      return false;
    }
    // EPERM and unknown failures must fail closed.
    return true;
  }
}

function isOwnerRecord(value: unknown): value is DaemonOwnerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<DaemonOwnerRecord>;
  return (
    Number.isInteger(record.pid) &&
    (record.pid ?? 0) > 0 &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.startedAt === "string"
  );
}

function isErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === code
  );
}

function readSnapshot(directory: string): LockSnapshot | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch (err: unknown) {
    if (isErrorCode(err, "ENOENT")) return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8"));
    return {
      owner: isOwnerRecord(parsed) ? parsed : null,
      malformed: !isOwnerRecord(parsed),
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return { owner: null, malformed: true, mtimeMs: stat.mtimeMs };
  }
}

function sameSnapshot(first: LockSnapshot, second: LockSnapshot): boolean {
  if (first.malformed !== second.malformed) return false;
  if (!first.owner || !second.owner) return first.malformed && second.malformed;
  return (
    first.owner.pid === second.owner.pid &&
    first.owner.token === second.owner.token &&
    first.owner.startedAt === second.owner.startedAt
  );
}

function reclaimingDir(lockDir: string): string {
  return path.join(lockDir, "reclaiming");
}

async function claimReclamation(
  lockDir: string,
  onDirectoryCreated?: () => Promise<void>,
): Promise<ReclamationClaim | null> {
  const directory = reclaimingDir(lockDir);
  const token = crypto.randomUUID();
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (err: unknown) {
    if (isErrorCode(err, "EEXIST") || isErrorCode(err, "ENOENT")) return null;
    throw err;
  }
  await onDirectoryCreated?.();
  try {
    fs.writeFileSync(
      path.join(directory, "owner.json"),
      JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (err) {
    try {
      fs.rmdirSync(directory);
    } catch {
      // Leave an incomplete marker for the fail-closed recovery path.
    }
    throw err;
  }
  return { directory, token };
}

function releaseReclamationClaim(claim: ReclamationClaim): void {
  const ownerFile = path.join(claim.directory, "owner.json");
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as { token?: unknown };
    if (owner.token !== claim.token) return;
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(claim.directory);
  } catch {
    // The stale main directory may already have been atomically retired.
  }
}

/**
 * Retain each dead reclaimer marker inside the stale main directory. A later
 * contender creates a fresh canonical marker; a successful main retirement
 * deletes every retained marker with that exact stale directory.
 */
function retireDeadReclamationClaim(
  lockDir: string,
  aliveCheck: (pid: number) => boolean,
): boolean {
  const directory = reclaimingDir(lockDir);
  const snapshot = readSnapshot(directory);
  if (!snapshot?.owner || aliveCheck(snapshot.owner.pid)) return false;
  const retired = path.join(lockDir, `reclaimed-${encodeURIComponent(snapshot.owner.token)}`);
  try {
    fs.renameSync(directory, retired);
    return true;
  } catch (err: unknown) {
    if (isErrorCode(err, "ENOENT") || isErrorCode(err, "EEXIST") || isErrorCode(err, "ENOTEMPTY")) {
      return false;
    }
    throw err;
  }
}

function retireAgedIncompleteReclamationClaim(lockDir: string, clock: () => number): boolean {
  const directory = reclaimingDir(lockDir);
  const snapshot = readSnapshot(directory);
  if (!snapshot?.malformed || clock() - snapshot.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
    return false;
  }
  const retired = path.join(lockDir, `reclaimed-incomplete-${Math.floor(snapshot.mtimeMs)}`);
  try {
    fs.renameSync(directory, retired);
    return true;
  } catch (err: unknown) {
    if (isErrorCode(err, "ENOENT") || isErrorCode(err, "EEXIST") || isErrorCode(err, "ENOTEMPTY")) {
      return false;
    }
    throw err;
  }
}

function ownsReclamationClaim(claim: ReclamationClaim): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(claim.directory, "owner.json"), "utf8")) as {
      token?: unknown;
    };
    return owner.token === claim.token;
  } catch {
    return false;
  }
}

function retireDirectory(directory: string, suffix: string): boolean {
  const retired = `${directory}.${suffix}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(directory, retired);
  } catch (err: unknown) {
    if (isErrorCode(err, "ENOENT") || isErrorCode(err, "EEXIST") || isErrorCode(err, "ENOTEMPTY")) {
      return false;
    }
    throw err;
  }
  fs.rmSync(retired, { recursive: true, force: true });
  return true;
}

export async function acquireDaemonLock(options?: LockOptions): Promise<DaemonLockHandle> {
  const home = options?.home ?? wakewireHome();
  const lockDir =
    options?.lockDir ?? (options?.home ? path.join(options.home, "daemon.lock") : daemonLockDir());
  const clock = options?.clock ?? Date.now;
  const aliveCheck = options?.isProcessAlive ?? isProcessAlive;
  const ownerFile = path.join(lockDir, "owner.json");

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const tryCreateLock = (): DaemonLockHandle | null => {
    const token = crypto.randomUUID();
    const pid = process.pid;
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
    } catch (err: unknown) {
      if (isErrorCode(err, "EEXIST")) return null;
      throw err;
    }
    const record: DaemonOwnerRecord = { pid, token, startedAt: new Date().toISOString() };
    try {
      fs.writeFileSync(ownerFile, JSON.stringify(record, null, 2), { mode: 0o600 });
      fs.chmodSync(ownerFile, 0o600);
    } catch (err) {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // Leave an incomplete lock for the normal grace-period recovery path.
      }
      throw err;
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as unknown;
        if (!isOwnerRecord(current) || current.token !== token) return;
        // Atomically remove this exact directory from the live lock path before
        // deleting it, so a delayed reclaimer marker cannot strand the lease.
        retireDirectory(lockDir, "released");
      } catch {
        // The owner may already have been replaced or reclaimed.
      }
    };
    return { pid, token, release };
  };

  const handle = tryCreateLock();
  if (handle) return handle;

  const snapshot = readSnapshot(lockDir);
  if (!snapshot) {
    const retryHandle = tryCreateLock();
    if (retryHandle) return retryHandle;
    throw new DaemonAlreadyRunningError(0, home);
  }
  if (snapshot.owner && aliveCheck(snapshot.owner.pid)) {
    throw new DaemonAlreadyRunningError(snapshot.owner.pid, home);
  }
  if (snapshot.malformed && clock() - snapshot.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
    throw new DaemonAlreadyRunningError(0, home);
  }

  await options?.onBeforeReclaim?.();

  let claim = await claimReclamation(lockDir, options?.onReclamationDirectoryCreated);
  if (
    !claim &&
    (retireDeadReclamationClaim(lockDir, aliveCheck) ||
      retireAgedIncompleteReclamationClaim(lockDir, clock))
  ) {
    claim = await claimReclamation(lockDir, options?.onReclamationDirectoryCreated);
  }
  if (!claim) throw new DaemonAlreadyRunningError(snapshot.owner?.pid ?? 0, home);

  try {
    options?.onReclaimClaimed?.();
    const current = readSnapshot(lockDir);
    if (
      !current ||
      !sameSnapshot(snapshot, current) ||
      !ownsReclamationClaim(claim) ||
      !retireDirectory(lockDir, "reclaimed")
    ) {
      throw new DaemonAlreadyRunningError(snapshot.owner?.pid ?? 0, home);
    }
    const retryHandle = tryCreateLock();
    if (retryHandle) return retryHandle;
    throw new DaemonAlreadyRunningError(snapshot.owner?.pid ?? 0, home);
  } finally {
    releaseReclamationClaim(claim);
  }
}

export async function withDaemonLock<T>(run: () => Promise<T>, options?: LockOptions): Promise<T> {
  const lock = await acquireDaemonLock(options);
  try {
    return await run();
  } finally {
    await lock.release();
  }
}
