# Milestone 5 Demo & Validation Runbook: Event-Driven Codex Review Remediation Loop

This document specifies the concrete, step-by-step verification checklist for Milestone 5 (event-driven Codex review remediation loop).

> **Environment Note:** In this local repository snapshot, external network and GitHub remote mutations (`gh`, `curl`, `ssh`, `git push`) are prohibited by security sandbox policy. Automated test suites validate all components locally with signed fixtures and fake adapters. Full live execution against GitHub is pending supervisor execution in the live environment.

---

## 1. Milestone 5 Verification Checklist

### Automated & Preflight Verification
- [x] **Step 1 Capability Admission Preflight:** Verified on `codex-cli 0.149.0` and recorded at `/private/tmp/wakewire-codex-review-admission.md` (turn `01a026ad-6f06-7b50-a242-83c9323898b4`, target PR #4 on branch `disposable/codex-review-loop-exec`, commit `72c17cf`).
- [x] **Review Webhook Normalization:** Trims `pull_request_review`, `pull_request_review_comment`, and PR `issue_comment` to minimal pointer fields; bodies omitted.
- [x] **Route Matching & Filtering:** Exact `pullRequests: [<PR_NUMBER>]` and case-insensitive exact `actors: ["chatgpt-codex-connector[bot]"]`.
- [x] **Durable Trailing-Edge Settling:** 45-second quiet window, SQLite persistence (`next_attempt_at`), multi-delivery coalescing into a single carrier turn with `coalescedInto` links.
- [x] **Explicit Network Grant & Adapter Enforcement:** `networkAccess: true` supported on `codex-app-server`, rejected with `PermanentError` on `codex-sdk` and `codex-exec`.
- [x] **Daemon Health & MCP Tools:** `wakewire_status` reports `adapter.networkEnabledRoutesSupported` and `adapter.sharedServerConfigured`; MCP schema validates target, sandbox, and settle parameters.
- [x] **Semantic Skill & State Machine:** `$wakewire-codex-review-loop` runbook enforces `WAKEWIRE_REVIEW_STATE` marker, commit trailers, 5-round cap, 3-error cap, and safe stops.

### Live Supervisor Validation Checklist (Pending Live Execution)
- [ ] **1. Shared App Server Topology:** Start daemon with `sink.appServerListen: ws://127.0.0.1:<PORT>` and attach interactive CLI via `codex --remote ws://127.0.0.1:<PORT>` in the verified PR-head checkout.
- [ ] **2. Review Route Registration:** Resolve the PR's authoritative base/head/default-branch metadata, select exactly one existing `<HEAD_REMOTE>` whose normalized fetch and push URLs both match the head repository, then create the route targeting `<CODEX_THREAD_ID>` with `pullRequests: [<PR_NUMBER>]`, `actors: ["chatgpt-codex-connector[bot]"]`, `sandbox: "workspace-write"`, `networkAccess: true`, and `settleSeconds: 45`. Refuse zero/multiple matches; never add/change a remote or assume `origin`.
- [ ] **3. Ingress Settling & Coalescing Verification:** POST one signed `pull_request_review.submitted` and two `pull_request_review_comment.created` fixtures; verify exactly one settled turn delivers after 45s, newest delivery is carrier, and two earlier rows show `status: "coalesced"`.
- [ ] **4. Negative Filter & Dedup Verification:** POST fixtures with wrong actor, wrong PR number, and duplicate delivery IDs; verify no additional turn is triggered.
- [ ] **5. Replay Isolation:** Call `wakewire_replay` on a prior delivery; verify immediate execution without joining the live settle cohort.
- [ ] **6. In-Flight Resilience & Backoff:** Interrupt App Server / make thread busy; verify delivery goes `held`, preserves retry budget and cohort deadline, and recovers on reconnect.
- [ ] **7. Exit-2 Remediation Cycle:** Receive real exit-2 review; verify agent fixes reproducible findings, runs test gates, creates normal commit with `WakeWire-Review-*` trailers, pushes once without force, posts `codex-grok-review request <PR_NUMBER>`, emits updated marker, and goes idle without polling.
- [ ] **8. Exit-0 Clean Verification:** Receive clean review webhook; verify agent evaluates `status` exit 0, makes no edits/commits/pushes/requests, reports clean status to user, and emits terminal marker.

---

## 2. Environment Variables & Setup Placeholders

Define these placeholders for live execution:

```bash
export REPO="<owner>/<repo>"              # e.g. "bmorrison/wakewire"
export PR_NUMBER="<PR_NUMBER>"             # e.g. 4
export APP_PORT="4571"
export LISTEN_URL="ws://127.0.0.1:${APP_PORT}"
export WAKEWIRE_HOME="$(mktemp -d)"
export API_PORT="4570"
```

---

## 3. Step-by-Step Live Execution Procedure

### Step 1: Start Shared App Server & Attach Session
1. Start the WakeWire daemon with the shared WebSocket listener configured:
   ```bash
   wakewire config set sink.adapter codex-app-server
   wakewire config set sink.appServerListen "${LISTEN_URL}"
   wakewire start --detach
   wakewire status
   ```
   *Expect:* `adapter.codexReachable: true`, `adapter.networkEnabledRoutesSupported: true`, `adapter.sharedServerConfigured: true`.

2. In the target PR checkout directory, resolve metadata and the head remote before attaching the Codex CLI session:
   ```bash
   cd "/path/to/${REPO}"
   gh repo view "${REPO}" --json nameWithOwner,defaultBranchRef
   gh pr view "${PR_NUMBER}" --repo "${REPO}" --json number,headRepository,headRepositoryOwner,headRefName,headRefOid,isCrossRepository
   git remote
   codex --remote "${LISTEN_URL}"
   ```
   Require `nameWithOwner` from `gh repo view` to equal the registered `${REPO}` base repository; the PR query's explicit `--repo "${REPO}"` context plus its matching PR number verifies the base PR identity. Record the returned head repository, head branch, head SHA, and default branch. Normalize the effective fetch and push URLs for every existing remote; select exactly one `<HEAD_REMOTE>` only if both URLs match the head repository. Do not add/change remotes or assume `origin`. Fetch `<verified-pr-head-branch>` from `<HEAD_REMOTE>` and verify `FETCH_HEAD`, local `HEAD`, and the authoritative PR head SHA are identical; otherwise stop the checklist. This also proves a same-named base-repository branch cannot be chosen by accident. In the attached session, resolve the thread ID:
   ```bash
   echo "$CODEX_THREAD_ID"
   ```
   Save this value as `THREAD_ID`.

3. Verify authoritative review reader is available:
   ```bash
   codex-grok-review status "${PR_NUMBER}"
   ```

### Step 2: Configure Source and Register Route
1. Set up GitHub listen-mode source:
   ```bash
   # From Codex conversation or CLI:
   wakewire_source_setup_github '{"repo":"'${REPO}'", "mode":"listen"}'
   ```
   Save the returned `sourceId` (e.g. `github-${REPO}`) and `secret`.

2. Add the PR review remediation route:
   ```json
   {
     "name": "codex-review-loop-pr-${PR_NUMBER}",
     "source": "github",
     "match": {
       "repo": "${REPO}",
       "events": [
         "pull_request_review.submitted",
         "pull_request_review_comment.created",
         "issue_comment.created"
       ],
       "pullRequests": [${PR_NUMBER}],
       "actors": ["chatgpt-codex-connector[bot]"]
     },
     "target": {
       "type": "thread",
       "threadId": "${THREAD_ID}"
     },
     "sandbox": "workspace-write",
     "networkAccess": true,
     "settleSeconds": 45,
     "promptTemplate": "A GitHub review webhook arrived for PR #${PR_NUMBER} on {{repo}}. Follow the $wakewire-codex-review-loop runbook: run codex-grok-review status ${PR_NUMBER}, address open findings if exit 2, run repo validation, commit, push, request re-review, and emit the WAKEWIRE_REVIEW_STATE marker."
   }
   ```

3. Emit the initial setup marker:
   ```text
   WAKEWIRE_REVIEW_STATE {"version":1,"repo":"${REPO}","pr":${PR_NUMBER},"baselineHead":"<HEAD_SHA>","lastSeenHead":"<HEAD_SHA>","remediationRounds":0,"consecutiveErrors":0,"lastRequestedHead":null,"outcome":"registered"}
   ```

### Step 3: Test Ingress Settling with Signed Fixtures
Simulate a multi-comment review pass by posting three signed fixtures within 10 seconds:
1. `pull_request_review.submitted` (action `submitted`, state `commented`, actor `chatgpt-codex-connector[bot]`).
2. `pull_request_review_comment.created` (action `created`, path `src/file.ts`, line 42).
3. `pull_request_review_comment.created` (action `created`, path `src/other.ts`, line 88).

Sign each payload with HMAC-SHA256 using `${SECRET}` and POST to `http://127.0.0.1:${API_PORT}/ingress/github/${SOURCE_ID}`.

**Verification:**
- Query `wakewire_deliveries`.
- Observe 3 deliveries recorded in `queued` status, all sharing the same quiet deadline (`nextAttemptAt = T_newest + 45s`).
- At T + 45s, observe exactly ONE turn delivered to `${THREAD_ID}`.
- Inspect `wakewire_deliveries`: the newest delivery is `delivered`, while earlier sibling deliveries are `status: "coalesced"` with `coalescedInto` pointing to the carrier delivery.

### Step 4: Negative Routing & Dedup Verification
1. POST a signed fixture with `actor: "random-user"` → Verify delivery is not routed (0 turns).
2. POST a signed fixture with `pull_request.number: 9999` → Verify delivery is not routed (0 turns).
3. Re-POST fixture #1 with identical `X-GitHub-Delivery` → Verify `status: "skipped-duplicate"` and quiet deadline is not extended.

### Step 5: Verify Replay Isolation
1. Call `wakewire_replay` on fixture #1.
2. Verify delivery is immediately enqueued with `isReplay: true`, `nextAttemptAt: null`, and delivers immediately without being held by or joining any live settle cohort.

### Step 6: Real Exit-2 Remediation & Exit-0 Completion
1. Trigger or receive a real Codex review on PR `${PR_NUMBER}` with open findings.
2. Settle window expires (45s) → Turn starts in `${THREAD_ID}`.
3. Observe live streaming via `codex --remote`:
   - `codex-grok-review status ${PR_NUMBER}` returns exit `2`.
   - `codex-grok-review detail ${PR_NUMBER}` lists open findings.
   - Code edits applied to working tree.
   - Repository validation gates pass (focused validation plus full required gates prescribed by the repository's toolchain, e.g. typecheck, test, lint, build).
   - Normal commit created with trailers:
     ```text
     WakeWire-Review-PR: ${REPO}#${PR_NUMBER}
     WakeWire-Review-Round: 1
     ```
   - Re-resolves PR metadata and the exact-one `<HEAD_REMOTE>` mapping immediately before commit/push; fetches `<verified-pr-head-branch>` and verifies fetched SHA, local pre-commit `HEAD`, and authoritative PR head SHA still match.
   - Pushed via `git push <HEAD_REMOTE> HEAD:<verified-pr-head-branch>` (no force).
   - Re-review requested via `codex-grok-review request ${PR_NUMBER}`.
   - Assistant emits `WAKEWIRE_REVIEW_STATE` with `outcome: "requested"`, `remediationRounds: 1`, `lastRequestedHead: <NEW_SHA>`.
   - Turn finishes and goes idle (no polling loop).
4. After Codex review completes clean, webhook wakes session:
   - `codex-grok-review status ${PR_NUMBER}` returns exit `0`.
   - Assistant reports clean status, makes no filesystem edits, creates no commits, and posts no requests.
   - Emits terminal marker with `outcome: "clean"`.

---

## 4. Teardown
1. Remove route: `wakewire_route_remove <routeId>`.
2. Stop daemon: `wakewire stop`.
