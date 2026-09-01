# Fix service MCP PATH and daemon exclusivity

## Goal

Make WakeWire's persistent-service mode launch Codex and plugin MCP subprocesses with a deterministic executable search path, so the bundled `npx -y wakewire mcp` command works when Codex App Server is spawned by launchd or systemd. At the same time, enforce one WakeWire daemon per `WAKEWIRE_HOME` and prevent detached/service mode mixing from recreating the duplicate-daemon state found during diagnosis.

## Conversation-derived intent

- Keep `/Users/burkmorrison/Documents/Projects/wakewire` as the authoritative custom fork and preserve its local plugin-development workflow.
- Fix the actual process-chain failure: launchd starts WakeWire with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; WakeWire's shared App Server inherits it; the App Server then cannot resolve the plugin's `npx` command and reports `No such file or directory (os error 2)`.
- Treat the timing accurately. `plugin/.mcp.json` has used `npx` since July and `src/cli/service.ts` has never written a service PATH; the latent defect can remain hidden while an older shared App Server stays alive and become visible when Codex/App Server restarts or newer startup reporting surfaces the MCP failure.
- Preserve `sink.codexPath` as the absolute path to the Codex executable, but do not mistake it for a complete fix: it lets WakeWire start Codex and does not provide `npx`, `uvx`, or other plugin executables to Codex's descendants.
- Preserve the portable plugin declaration. Do not replace `npx` in `plugin/.mcp.json` with a path tied to this Mac, an asdf installation, Homebrew, or this checkout.
- Make service and detached modes mutually exclusive in code, matching the existing README/setup contract. The current machine has one launchd-managed daemon, three additional orphaned detached daemons, and one shared App Server child; implementation must provide a safe migration path without killing unrelated processes automatically.
- Keep changes small, testable, and limited to service environment generation, daemon ownership, CLI guardrails, and the corresponding documentation.

## Current state / repository context

- No repository-level `AGENTS.md` is present. `README.md` and `CONTRIBUTING.md` require Node 20.18+, strict TypeScript/ESM, Vitest, Biome, typechecking, and a build before release.
- `plugin/.mcp.json` declares the WakeWire MCP server as `command: "npx"` with args `[-y, wakewire, mcp]`. This is intentionally portable but requires `npx` to be discoverable in the App Server environment.
- `src/cli/service.ts::installService()` writes a launchd plist or systemd user unit. `launchdPlist()` and `systemdUnit()` use absolute paths for Node and `dist/cli.js`, but neither definition sets `PATH`.
- On this installation, the launchd job uses `/Users/burkmorrison/.asdf/installs/nodejs/24.7.0/bin/node`; `npx` is colocated in that directory, but launchd's current PATH excludes it.
- `src/sinks/codex-app-server.ts::openSharedWs()` spawns `sink.codexPath app-server --listen ...` without an explicit `env`, correctly inheriting the daemon environment. The service definition is therefore the narrowest place to repair the entire descendant process tree.
- `src/cli.ts` checks only the PID in `daemon.json` before `start`; `src/daemon/daemon.ts::Daemon.start()` writes that file only after database, adapter, API, queue, and sources initialization. There is no atomic ownership primitive, so concurrent starts or stale-state replacement can produce multiple live daemons while only one PID remains discoverable.
- `docs/setup.md`, `docs/GETTING-STARTED.md`, `README.md`, and `plugin/skills/wakewire-setup/SKILL.md` tell users not to mix detached and service modes, but the CLI does not enforce that rule.
- Existing tests cover adapters, queueing, persistence, routes, and sources. There are no service-definition, CLI mode, or daemon-lock tests today.
- `docs/plans/event-driven-codex-review-remediation-loop.md` touches shared App Server behavior but does not change service environments or daemon ownership. This plan must not reopen that feature's routing, sandbox, or review-loop decisions.

## Scope & Explicit Non-goals

### In scope

- Generate a deterministic PATH for launchd and systemd definitions from the Node executable directory plus safe absolute entries present during service installation.
- Escape dynamic plist and systemd values correctly and unit-test the generated definitions.
- Add an atomic, per-`WAKEWIRE_HOME` daemon lease that is acquired before daemon initialization and released only by its owner.
- Add CLI preflight checks that reject `start --detach` while a service definition is installed and reject a first-time service install while a manually managed daemon is live.
- Document reinstallation after runtime/PATH changes, duplicate-daemon recovery, and verification of MCP startup from a shared App Server.
- Provide automated and macOS manual validation for the exact failure reported.

### Explicit non-goals

- Do not change `plugin/.mcp.json`, publish/install a different npm package, require a global `wakewire`/`npx`, or add Homebrew/asdf-specific paths.
- Do not alter Codex App Server JSON-RPC, shared-WebSocket behavior, route delivery, review remediation, database schemas, source integrations, or plugin tool contracts.
- Do not add a general-purpose environment configuration subsystem or a new persisted `service.path` setting.
- Do not automatically kill every process named `wakewire` or `codex`; cleanup must validate ownership and prefer graceful shutdown.
- Do not change Windows process management or add a Windows service wrapper.
- Do not archive this plan. Leave it under `docs/plans/` until implementation is independently verified.

## Implementation steps (concrete, file-specific actions)

1. **Add red tests for service PATH construction and definition rendering.**
   - Create `src/cli/service.test.ts` using Vitest and temporary absolute fixture paths; do not read or modify the user's real LaunchAgents/systemd directories.
   - Export pure helpers from `src/cli/service.ts` so tests can call them without invoking `launchctl` or `systemctl`: `buildServicePath(execPath, inheritedPath, platform)`, `launchdPlist(cliPath, servicePath)`, and `systemdUnit(cliPath, servicePath)`.
   - Assert `buildServicePath()` prepends `path.dirname(execPath)`, keeps only non-empty absolute inherited PATH entries, removes duplicates while preserving first occurrence, and appends missing standard directories. Use `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, and `/sbin` for macOS; use `/usr/local/bin`, `/usr/bin`, and `/bin` for Linux. This must make an asdf-managed `node` directory sufficient to find its colocated `npx` without hard-coding asdf.
   - Assert relative entries and the empty PATH element (which means the current directory) are dropped so installing from a permissive shell does not create a service-time executable-hijacking path.
   - Add a small `escapeXmlText()` helper. Assert the launchd output contains an `EnvironmentVariables` dictionary with exactly one `PATH` value; encode `&`, `<`, and `>` in every dynamic XML text node, preserve spaces, and reject NUL or other XML-invalid control characters before writing the plist. Quotes may remain literal in XML text nodes.
   - Add `quoteSystemdValue()` for `Environment=` and `quoteSystemdArg()` for each `ExecStart` argument. Both must reject NUL/newline input, wrap values in double quotes, escape `\` as `\\` and `"` as `\"`, and encode literal `%` as `%%` so systemd does not interpret a path fragment as a specifier. Build the environment directive by concatenating literal `Environment=` with `quoteSystemdValue("PATH=" + servicePath)`; build `ExecStart=` by quoting and joining `[process.execPath, cliPath, "start"]`. Assert fixtures with whitespace, backslashes, percent signs, and double quotes round-trip to the intended values. Do not invoke a shell.

2. **Write the deterministic environment into both service definitions.**
   - In `src/cli/service.ts::installService()`, compute the service PATH once from `process.execPath`, `process.env.PATH`, and `process.platform`, then pass it to the renderer for the selected platform.
   - In `launchdPlist()`, add `<key>EnvironmentVariables</key><dict><key>PATH</key><string>...</string></dict>` before `ProgramArguments`. Continue using the absolute `process.execPath` and `cliPath` so WakeWire itself does not depend on PATH.
   - In `systemdUnit()`, add the escaped PATH with an `Environment=` directive while retaining the absolute Node/CLI `ExecStart`, `Restart=on-failure`, and existing enablement instructions.
   - Do not add an `env` override in `src/sinks/codex-app-server.ts`: both `openStdio()` and `openSharedWs()` should inherit the corrected daemon environment, and Codex must pass that environment naturally to every configured MCP subprocess.

3. **Introduce an atomic daemon lease before any mutable daemon startup work.**
   - Add `daemonLockDir()` to `src/paths.ts`, returning `<wakewireHome>/daemon.lock`; use a directory rather than `daemon.json` because `fs.mkdirSync()` provides the required same-filesystem atomic create.
   - Create `src/daemon/lock.ts` with `acquireDaemonLock()` returning an idempotent `release()` callback and a typed `DaemonAlreadyRunningError`. Before acquiring, create `wakewireHome()` recursively with mode `0700`; this preserves the current ability for `start` to initialize a missing home while ensuring the parent exists before the atomic lock-directory operation. Store `{pid, token, startedAt}` in `<wakewireHome>/daemon.lock/owner.json` with mode `0600`; create the lock directory with mode `0700` and generate `token` with `crypto.randomUUID()`.
   - On `EEXIST`, read `owner.json`. If its PID is alive, fail with a stable message naming that PID and `WAKEWIRE_HOME`. If the owner record is missing/malformed but the lock directory is less than five seconds old, treat another start as in progress and fail without deleting it. If the PID is dead, or an invalid lock is at least five seconds old, remove only that exact lock directory and retry acquisition once.
   - Implement PID probing in one injected/testable helper. `process.kill(pid, 0)` success means alive; an error with code `ESRCH` means dead; `EPERM` or any other error means alive/fail-closed. Reject non-integer or non-positive PIDs as malformed owner records rather than probing them.
   - Make `release()` compare the on-disk ownership token before removing anything. A process must never delete a lease replaced by another process; repeated release calls must be harmless.
   - Export `withDaemonLock(run)` from `src/daemon/lock.ts`; it must acquire once, `await run()`, and release in `finally` on both resolution and rejection.
   - Restructure `src/daemon/daemon.ts::runDaemon()` exactly around that wrapper: construct `Daemon` inside the callback; use an inner `try/finally` that calls `await daemon.stop()` after a signal or partial `Daemon.start()` failure; let `withDaemonLock()` release only after `Daemon.stop()` finishes. Remove `daemon.stop()` from the signal callback so shutdown has one owner and cannot run twice.
   - Preserve the existing hard-exit rationale for lingering source sockets, but call `process.exit(0)` only after `await withDaemonLock(...)` has returned and its release `finally` has completed. Never call `process.exit()` from inside the lock callback because Node would skip both cleanup `finally` blocks. Keep `Daemon.stop()`'s PID-checked `daemon.json` removal and adapter shutdown behavior unchanged.
   - Do not use `daemon.json` as the lock. It remains the authenticated API discovery record written after the HTTP server chooses its port.

4. **Test daemon lease contention, stale recovery, and cleanup.**
   - Create `src/daemon/lock.test.ts` with a temporary `WAKEWIRE_HOME` and injected/test-only clock and PID probe, rather than sending signals to arbitrary real PIDs.
   - Cover: acquisition creates a previously missing home; first acquisition succeeds; a second acquisition for a live owner fails; `ESRCH` is dead while `EPERM`/unknown probe errors fail closed as alive; invalid PIDs are rejected as malformed; a dead-owner lease is reclaimed; a fresh incomplete lease is not removed; an old incomplete lease is reclaimed; release removes an owned lease; release cannot remove a lease whose token has changed; and acquisition is available again after release.
   - Test that `withDaemonLock(run)` releases after both resolve and throw. Add a focused lifecycle test around an injected fake daemon proving cleanup completes before the lock is released and that the hard-exit callback is reached only afterward; do not invoke real `process.exit()`, bind a server, or refactor `Daemon` internals beyond extracting the signal-wait/lifecycle helper needed for this ordering test.

5. **Enforce detached/service mode exclusivity at the CLI boundary.**
   - Create `src/cli/process-mode.ts` with pure `serviceDefinitionPath(platform, home)` and `validateProcessModeTransition({operation, serviceInstalled, daemonPid, daemonAlive})` helpers. Support `operation: "start-detached" | "install-service"`; return normally for allowed transitions and throw a typed, actionable conflict error for rejected transitions. `serviceDefinitionPath()` must return the launchd plist on `darwin`, the systemd user unit on `linux`, and `null` on every other platform so the new guard does not change the documented Windows/other-platform foreground or detached behavior.
   - In `src/cli.ts`'s `start` action, before spawning a detached child, reject `--detach` when a service definition is installed. The error must direct the user to keep service mode or run `wakewire service uninstall` before starting detached mode. Foreground `start` must remain allowed because launchd/systemd invoke that exact command.
   - In `service install`, when no service definition currently exists, reject installation if `readDaemonState()` points to a live manually managed daemon; direct the user to `wakewire stop`, verify it exited, and retry. When a service definition already exists, preserve the existing reinstall/reload workflow.
   - Keep the daemon lease as the authoritative race/singleton defense. These preflights exist for actionable errors; they must not infer safety solely from a possibly stale `daemon.json`.
   - Add `src/cli/process-mode.test.ts` covering macOS/Linux definition paths, installed/not-installed classification, detached rejection, first-install rejection, stale-state allowance, and service reinstall allowance. Test `validateProcessModeTransition()` directly rather than importing `src/cli.ts`, whose module parses argv.

6. **Add safe operator recovery and PATH lifecycle documentation.**
   - Update the service sections in `README.md`, `docs/GETTING-STARTED.md`, and `docs/setup.md` to state that `wakewire service install` snapshots a sanitized PATH containing the active Node runtime directory, and must be rerun after changing/removing Node versions or moving CLI tools.
   - In `docs/setup.md`, add a targeted troubleshooting entry for `MCP startup failed: No such file or directory (os error 2)`: inspect the service's effective PATH, confirm the plugin command (`npx` for bundled WakeWire) resolves in that environment, rebuild the fork, reinstall/reload the service, and start a fresh remote Codex session against the shared server.
   - Add a duplicate-daemon recovery procedure that first identifies exact WakeWire PIDs and parent/service ownership, uninstalls or unloads the managed service before stopping extra detached processes, uses graceful `SIGTERM`, verifies no WakeWire daemon remains, removes `daemon.lock`/`daemon.json` only when their recorded PID is confirmed dead, and then starts exactly one selected mode. Do not recommend broad `pkill`, wildcard deletion, or deleting the SQLite database.
   - Update `plugin/skills/wakewire-setup/SKILL.md` so setup checks the mode conflict and explains service reinstallation after PATH/runtime changes. Keep all existing route, live-view, and review-loop instructions intact.
   - State that an already-running shared App Server retains its original environment; service reload plus a new `codex --remote` connection is required to validate the fix.

7. **Validate the implementation and the reported macOS topology.**
   - Run focused tests first: `npm test -- src/cli/service.test.ts src/cli/process-mode.test.ts src/daemon/lock.test.ts`.
   - Run the repository gates from `CONTRIBUTING.md`: `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build`.
   - Run `git diff --check`, inspect `git status --short`, and verify that changes are restricted to the files listed below plus generated `dist/` only if the repository's normal build policy tracks it (currently `dist/` is ignored/not listed in the inspected source tree).
   - Treat all live macOS operations as a separate, explicit approval gate. Before unloading/reloading launchd, sending any signal, removing stale `daemon.lock`/`daemon.json`, or replacing the installed plist, show the user the exact service label, resolved files, and validated WakeWire PIDs and obtain confirmation. Unit tests, typecheck, lint, build, and read-only inspection do not require this gate.
   - After approval, perform the documented graceful duplicate-daemon cleanup, rebuild the custom fork, and rerun `wakewire service install`. Run `plutil -lint ~/Library/LaunchAgents/io.wakewire.daemon.plist`, then inspect `launchctl print gui/$(id -u)/io.wakewire.daemon` and the daemon/App Server process environments, confirming PATH includes the directory containing the installed Node runtime and `npx`. If plist validation fails, stop the live smoke test and use the rollback procedure rather than repeatedly reloading it.
   - Confirm one WakeWire daemon exists for the default `WAKEWIRE_HOME`, with at most one WakeWire-owned shared `codex app-server --listen ws://127.0.0.1:4571` child. A deliberate second foreground or detached start must fail before opening sources or overwriting `daemon.json`.
   - Start a fresh `codex --remote ws://127.0.0.1:4571` session, install/load the local WakeWire plugin, and call `wakewire_status`. Confirm the `wakewire` MCP server reaches ready state without the OS error and that an existing route/delivery still works.
   - On Linux, rely on renderer/unit tests unless a systemd user session is available; if available, run `systemd-analyze --user verify ~/.config/systemd/user/wakewire.service` before a live restart.

## Files likely to change (with paths)

- `src/cli/service.ts`
- `src/cli/service.test.ts` (new)
- `src/cli.ts`
- `src/cli/process-mode.ts` (new)
- `src/cli/process-mode.test.ts` (new)
- `src/paths.ts`
- `src/daemon/lock.ts` (new)
- `src/daemon/lock.test.ts` (new)
- `src/daemon/daemon.ts`
- `README.md`
- `docs/GETTING-STARTED.md`
- `docs/setup.md`
- `plugin/skills/wakewire-setup/SKILL.md`
- `docs/plans/fix-service-mcp-path-and-daemon-exclusivity.md` (this plan)

`plugin/.mcp.json`, `src/sinks/codex-app-server.ts`, database migrations, route code, and delivery code are explicitly not expected to change.

## Tests / validation

- Unit-test deterministic PATH sanitization/deduplication and launchd/systemd escaping with no real service mutation.
- Unit-test atomic lease acquisition, missing-home creation, PID probe semantics, live contention, stale recovery, grace-period handling, token-safe release, and exception cleanup in temporary homes.
- Unit-test shutdown ordering: partial or normal daemon cleanup finishes, the ownership token is released, and only then may the hard-exit path run.
- Unit-test mode-transition decisions for installed service, live detached daemon, stale state, and reinstall cases.
- Run all project gates: typecheck, complete Vitest suite, Biome, and TypeScript build.
- Validate the real macOS service environment after a controlled reinstall and verify `npx` from the effective PATH.
- Validate a fresh shared App Server/plugin lifecycle end to end with `wakewire_status`, plus a deliberate second-start rejection and a process-tree check.
- Verify existing configuration, secrets, routes, `state.db`, and delivery history survive the service migration unchanged.
- If approval for live macOS mutation is not granted, report the automated gates as complete and the service/plugin smoke test as pending; do not claim the live acceptance criteria passed.

## Acceptance criteria

- A launchd-installed WakeWire started from this custom fork gives its Codex App Server descendant a PATH that resolves the `npx` colocated with the Node runtime used to install the service.
- Loading the local WakeWire plugin in a fresh shared App Server session no longer emits `MCP client for wakewire failed to start ... os error 2`, and `wakewire_status` is callable.
- Generated launchd and systemd definitions are valid, safely escaped, and contain no user-machine-specific hard-coded runtime-manager paths in source.
- Only one daemon can own a given `WAKEWIRE_HOME`; concurrent or accidental second starts fail before daemon initialization mutates state.
- Normal signal shutdown and startup failure both stop partially initialized resources before releasing the lease; the final hard exit cannot strand an owned `daemon.lock`.
- `wakewire start --detach` and `wakewire service install` give actionable errors for conflicting management modes while ordinary service reinstall remains supported.
- Existing daemon shutdown, state-file authentication, shared App Server delivery, routes, secrets, and delivery history continue to work without schema changes.
- Documentation explains why the failure appeared recently, how PATH is captured, when service reinstall is required, and how to recover duplicates without broad process termination or state loss.
- All focused tests and the full `typecheck`, `test`, `lint`, and `build` gates pass; the macOS process/environment and plugin smoke checks pass.

## Risks and rollback

- **Captured PATH becomes stale:** a removed Node/runtime-manager directory can break future service starts. Mitigation: always prepend the current `process.execPath` directory, retain system fallbacks, and document reinstalling the service after runtime changes.
- **PATH injection or malformed definitions:** empty/relative entries and incorrect XML/systemd escaping could execute the wrong binary or make the service unloadable. Mitigation: accept only absolute entries and cover escaping plus definition validation in tests.
- **False stale-lock decisions:** PID reuse or an incomplete owner record can make a lease appear active/stale incorrectly. Mitigation: fail closed for live PIDs and fresh incomplete locks, use an ownership token on release, reclaim only dead/aged records, and include the exact lock path/PID in errors.
- **Hard exit bypasses cleanup:** calling `process.exit()` inside the daemon or lease `try/finally` would strand the lock. Mitigation: test cleanup/release ordering and keep the hard exit strictly after `withDaemonLock()` resolves.
- **launchd KeepAlive restart churn during migration:** a second daemon may repeatedly fail its lease while another mode owns it. Mitigation: unload/uninstall the service first, stop validated detached PIDs gracefully, verify zero daemons, then start one mode.
- **Rollback:** revert the implementation commit, run `npm run build`, and reinstall/reload the prior service definition. If the reverted version cannot start because a new lease remains, remove only `<WAKEWIRE_HOME>/daemon.lock` after confirming its recorded PID is dead. Do not remove `state.db`, secrets, routes, delivery history, or plugin installation.

## Open questions (only if truly blocking)

None. The observed process environment, repository code, and current plugin declaration are sufficient to implement and validate the fix without a product-level decision.
