---
name: wakewire-setup
description: Set up wakewire end to end — install/start the local daemon, wire a first GitHub or Gmail route into a Codex thread, and verify with a test delivery. Use when the user wants external events (GitHub pushes/PRs/issues, emails) delivered into their Codex threads, or when wakewire tools report the daemon is not running.
---

You are configuring wakewire, a local daemon that pushes external events into Codex threads. Configuration happens through the `wakewire_*` MCP tools; this skill is the runbook.

## 0. Check the daemon

Call `wakewire_status`.

- If it errors with "daemon is not running", have the user run in a terminal:
  ```
  npm install -g wakewire
  wakewire init
  wakewire start --detach
  ```
  For an always-on service instead, first resolve `command -v codex` and store
  its absolute result with
  `wakewire config set sink.codexPath /absolute/path/to/codex`; launchd/systemd
  may not inherit the interactive shell PATH. Then run `wakewire service install`.
  On macOS this loads the service immediately. On Linux, follow it with
  `systemctl --user daemon-reload && systemctl --user enable --now wakewire`.
  Never run detached and service modes at the same time.
  Then call `wakewire_status` again.
- Confirm `adapter.codexReachable` is true. If not, resolve Codex's absolute path,
  store it in `sink.codexPath`, restart the same management mode, and check again.
  On macOS, rerun `wakewire service install`; on Linux, use
  `systemctl --user restart wakewire`; for detached mode, use `wakewire stop`
  followed by `wakewire start --detach`. Do not use `wakewire stop` to stop an
  installed macOS service because launchd's `KeepAlive` relaunches it.

## 1. Resolve the target thread

Most users want events delivered "into this thread". MCP tools cannot see the current thread id, but shell commands can:

1. Run this shell command: `echo "$CODEX_THREAD_ID"`
2. Use that value as `target: {"type":"thread","threadId":"<value>"}`.

If the user prefers fresh threads per event (e.g. "spawn a worktree and investigate each failure"), use `target: {"type":"new-thread","cwd":"<abs repo path>","worktree":true}` instead.

## 2. Set up the source

### GitHub
1. Choose ingress based on the actual use case. For a quick test or public
   repository, call `wakewire_source_setup_github` with the repo and no `mode`
   (e.g. `{"repo":"acme/api"}`). WakeWire creates the smee.io relay channel
   itself and returns a webhook URL, secret, and instructions. Do not ask the
   user to provision Cloudflare, ngrok, or Tailscale first.
2. Relay the returned instructions verbatim — the user adds the URL and secret
   in GitHub webhook settings. Warn that smee.io is a public, development-only
   relay: payloads transit it and events can be lost while WakeWire is offline,
   although WakeWire still verifies GitHub HMAC signatures.
3. For a private repository or loss-sensitive webhook, explain that direct
   `{"mode":"listen"}` needs a separately secured public ingress. Cloudflare
   Tunnel is one option, not a WakeWire prerequisite. Confirm that choice before
   requiring the user to provision external tunnel infrastructure.
4. GitHub sends a `ping` on creation; `wakewire_status` should show that the
   source received it.

### Gmail
1. Ask which Gmail label to watch (never watch everything — a label is required) and the Gmail address.
2. Ask which auth they prefer:
   - **App password** (simpler): call `wakewire_source_setup_gmail` with `{label, user, authKind: "imap-password"}`. The user creates an app password at https://myaccount.google.com/apppasswords (needs 2-Step Verification) and runs `wakewire auth imap` in a terminal to store it. Also works for non-Gmail IMAP servers via `host`/`port`.
   - **OAuth**: call `wakewire_source_setup_gmail` with `{label, user}`. The user creates their own Google OAuth client (Desktop type) and runs `wakewire auth gmail` in a terminal to complete consent.
3. Relay the returned instructions verbatim either way.

### Slack
1. Call `wakewire_source_setup_slack` (optionally with `{team: "workspace-name"}`). It returns the one-time Slack app setup: create an app, enable Socket Mode (app-level token, `connections:write`), add bot scopes (`app_mentions:read`, `channels:history`, `channels:read`, `users:read`), subscribe to bot events (`app_mention`, `message.channels`), install, invite the bot to channels.
2. Relay those steps verbatim, then have the user run `wakewire auth slack` in a terminal — both tokens go in via hidden prompts, never through this conversation.
3. Slack routes match `app_mention` by default (any channel the bot is in); matching plain `message` events requires naming channels. Bot-posted messages are skipped by default.

### Any other provider (Sentry, Grafana, Linear, ClickUp, Stripe, CI, custom)
Use the generic webhook source. The loop:
1. `wakewire_source_setup_webhook` with `name` and `verification` only (check the provider's docs for its signature header; hmac-sha256 + header name covers most). Relay the returned URL + secret. The next 3 events are captured raw.
2. Ask the user to trigger a test event, then read it with `wakewire_source_captures`.
3. Author the mapping from the real payload — `deliveryId`/`kind`/`occurredAt` paths, a `summary` template, and `fields` (alias → dot.path). Only mapped fields reach the model, so map what routes and prompts need, nothing more.
4. Re-run `wakewire_source_setup_webhook` with the mapping (the secret and relay URL are preserved).
5. Route with `source: "webhook"`, `match: {"provider": "<name>", "where": [...]}`.
Known-provider presets (ClickUp, Linear, Sentry) are in the package's recipes/ directory.

### Codex Code Review Remediation Loop
For automated, event-driven remediation of GitHub PR reviews from Codex:
1. Check `wakewire_status`. Verify `adapter.networkEnabledRoutesSupported === true` and `adapter.sharedServerConfigured === true`. If not, have the user configure `sink.appServerListen` (e.g. `ws://127.0.0.1:4571`) and restart WakeWire. Note: A configured listener alone indicates server capability, not that a live TUI is currently connected.
2. Ask the user to confirm their interactive CLI session is attached with `codex --remote ws://127.0.0.1:4571` in the PR checkout directory.
3. Resolve `CODEX_THREAD_ID` via `echo "$CODEX_THREAD_ID"`.
4. Resolve normal GitHub metadata for the route's PR: base repository/PR identity, head repository owner/name, head branch, head SHA, and base repository default branch. Inspect existing Git remotes and choose exactly one whose normalized fetch **and** push repository URLs match the authoritative head repository. If no remote or more than one remote matches, refuse registration; never add/change a remote or assume `origin`. Fetch from that `<HEAD_REMOTE>` and require fetched SHA, local `HEAD`, and authoritative PR head SHA to match. Verify the current branch is the head branch and not the default branch.
5. Prove `codex-grok-review status <PR>` is runnable. Refuse registration if the command is missing or cannot run.
6. Explain the explicit write + network access grant: the route will have standing authorization to edit files, execute tests, commit with review trailers, push only via `git push <HEAD_REMOTE> HEAD:<verified-pr-head-branch>` without force, and request review. The selected remote must map to the PR head repository, never a same-named branch in the base repository. Obtain explicit user authorization.
7. Call `wakewire_route_add` using the recipe in `recipes/codex-review-loop.md`:
   - `events`: `["pull_request_review.submitted", "pull_request_review_comment.created", "issue_comment.created"]`
   - `pullRequests`: `[<PR>]`
   - `actors`: `["chatgpt-codex-connector[bot]"]`
   - `sandbox`: `"workspace-write"`
   - `networkAccess`: `true`
   - `settleSeconds`: `45`
8. Finish setup by emitting the initialized `WAKEWIRE_REVIEW_STATE` marker with `baselineHead` and `lastSeenHead` set to current HEAD.
9. Tell the user that a green review, merge, or closed PR does not automatically
   disable the route. When the loop is finished, identify the exact route with
   `wakewire_route_list`, then disable it with `wakewire_route_toggle` or delete
   it with `wakewire_route_remove`. Remove a shared GitHub source only when no
   other routes depend on it.

## 3. Create the route

Call `wakewire_route_add`. Examples:

- Pushes to main into this thread:
  ```json
  {
    "name": "api main pushes",
    "source": "github",
    "match": {"repo": "acme/api", "events": ["push"], "branches": ["main"]},
    "target": {"type": "thread", "threadId": "<resolved id>"},
    "promptTemplate": "Summarize this push to {{repo}}:{{branch}} and flag anything risky."
  }
  ```
- Labeled email into this thread: `match: {"label": "agent-inbox"}`.

### Codex Review Remediation Loop Setup

To set up an autonomous review remediation loop for a specific PR:

1. **Verify daemon readiness**:
   Call `wakewire_status`. Verify:
   - `adapter.networkEnabledRoutesSupported === true` (requires `codex-app-server` adapter)
   - `adapter.sharedServerConfigured === true` (requires `appServerListen` configured)
2. **Confirm attached session**:
   Ask the user to confirm that their target Codex CLI session is attached via `codex --remote <listenUrl>` in the PR's working directory. (A configured listener alone does NOT mean a session is currently attached).
3. **Resolve thread and verify checkout**:
   - Run `echo "$CODEX_THREAD_ID"` to obtain the thread ID.
   - Resolve normal GitHub metadata for the PR (base repo/PR identity, head repo, head branch, head SHA, and default branch). Inspect existing Git remotes, normalize their fetch and push URLs, and select exactly one `<HEAD_REMOTE>` whose two URLs match the head repository. Refuse if zero or multiple remotes match; never add/change a remote or assume `origin`.
   - Run `git status --short` and `git rev-parse HEAD`; fetch `<verified-pr-head-branch>` from `<HEAD_REMOTE>` and require fetched SHA, local `HEAD`, and authoritative PR head SHA to agree. Confirm the clean checkout is on that PR branch, never the default branch.
   - Run `codex-grok-review status <PR>` to confirm the review tool is installed and functional.
4. **Obtain explicit authorization**:
   Explain clearly that the route grants standing authorization for this specific PR to:
   - Edit files in the working directory
   - Execute test and validation gates
   - Create normal commits with `WakeWire-Review-*` trailers
   - Push without force only to the verified head remote: `git push <HEAD_REMOTE> HEAD:<verified-pr-head-branch>`
   - Post `@codex review` re-review requests
   Obtain explicit confirmation from the user.
5. **Add route**:
   Call `wakewire_route_add` with the parameters from `recipes/codex-review-loop.md`:
   - `match`: `{ "repo": "owner/repo", "events": ["pull_request_review.submitted", "pull_request_review_comment.created", "issue_comment.created"], "pullRequests": [<PR>], "actors": ["chatgpt-codex-connector[bot]"] }`
   - `target`: `{ "type": "thread", "threadId": "<CODEX_THREAD_ID>" }`
   - `sandbox`: `"workspace-write"`
   - `networkAccess`: `true`
   - `settleSeconds`: `45`
   - `promptTemplate`: instructions referencing `$wakewire-codex-review-loop` and `$codex-grok-review`.
6. **Emit Initial State Marker**:
   Emit the initialized state marker with the verified HEAD commit:
   ```text
   WAKEWIRE_REVIEW_STATE {"version":1,"repo":"owner/repo","pr":143,"baselineHead":"<HEAD_SHA>","lastSeenHead":"<HEAD_SHA>","remediationRounds":0,"consecutiveErrors":0,"lastRequestedHead":null,"outcome":"registered"}
   ```

Prompt templates may interpolate only whitelisted summary fields ({{summary}}, {{repo}}, {{branch}}, {{kind}}, {{subject}}, {{from}}, …). Event payloads are always delivered as fenced untrusted data — remind the user that email/commit content must be treated as data, not instructions.

Sandbox: default is read-only. Only set `"sandbox": "workspace-write"` for GitHub routes if the user explicitly wants the injected turns to edit files. Gmail routes are always read-only.

## 4. Verify

1. Ask the user to trigger a real event (push a commit, or send + label an email), or replay one: `wakewire_deliveries` → pick a delivery id → `wakewire_replay`.
2. Confirm with `wakewire_deliveries` that the delivery status is `delivered` and the turn arrived in the target thread.
3. If something is off, switch to the $wakewire-inspect skill.
