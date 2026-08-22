# Milestone 5 Demo & Validation Runbook: Event-Driven Codex Review Remediation Loop

This document specifies the concrete, step-by-step verification checklist for Milestone 5 (event-driven Codex review remediation loop).

> **Live evidence (2026-08-21/22 UTC):** A supervised disposable run completed on `bmorrison/wakewire` PR #3 without merging. It used a shared loopback App Server, an attached plain `codex --remote` CLI, signed ingress, and a dedicated standalone clone. The evidence paths are `/private/tmp/wakewire-m5-pr3/logs/wakewire.log` and the target-session transcript named in the plan below. This is execution evidence, not authorization for future PR mutations.

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

### Live Supervisor Validation Checklist (Completed on Disposable PR #3)
- [x] **1. Shared App Server Topology:** Shared `ws://127.0.0.1:4571` App Server with plain attached `codex --remote` CLI and a standalone PR-head clone.
- [x] **2. Review Route Registration:** One exact PR #3 route, after exact-one head-remote fetch/push URL resolution, targeted the attached thread with bot/PR scope, workspace-write, network access, and a 45-second settle window.
- [x] **3. Ingress Settling & Coalescing Verification:** Three signed matching fixtures produced one 45-second settled carrier and two coalesced siblings.
- [x] **4. Negative Filter & Dedup Verification:** Wrong actor, wrong PR, and duplicate delivery fixtures produced no extra model turn or extended settle cohort.
- [x] **5. Replay Isolation:** A replay was immediate (`isReplay: true`, no settle deadline) and did not join a live cohort.
- [x] **6. In-Flight Resilience & Backoff:** A matching delivery held across four busy retries (1/2/4/8 seconds), retained its cohort, and delivered once after idle recovery. Its noncanonical read-only harness turn is counted only as queue-resilience evidence.
- [x] **7. Exit-2 Remediation Cycle:** A real P1 on the faulty disposable head was reproduced, fixed, fully validated, committed with both required trailers, non-force pushed once as `c5c402337cc23c78fc7d38ff3b3759be3df84411`, and re-review was requested once; the final marker was `outcome: "requested"`.
- [x] **8. Exit-0 Clean Verification:** A signed final issue-comment wake settled and ran one current-head clean turn; `status` exited 0 for `c5c4023`, made no mutation or request, and ended with `outcome: "clean"`.

#### Compact live evidence

| Item | Observed evidence |
| --- | --- |
| Topology | Codex CLI `0.149.0`; daemon PID `96795`; shared `ws://127.0.0.1:4571`; standalone clone `/private/tmp/wakewire-pr3-m5-clone`; attached thread `01a02735-22de-7273-b02f-fda5907c8054`. |
| Exact route | Route `d744c2e2-3e6a-4ece-8e56-9abb4df7ae7e`: PR #3, exact Codex bot actor, workspace-write, network enabled, 45-second settling. The supervisor manually disabled it only after evidence capture; the clean turn did not remove or disable it. |
| Baseline and repair | Fault baseline `3907df946d431545338907ae76b4d181081c8b85`; real P1 remediation commit `c5c402337cc23c78fc7d38ff3b3759be3df84411` with both `WakeWire-Review-*` trailers. |
| Queue cases | Initial signed three-event cohort coalesced to carrier `432ef89a-fd1f-4292-a517-6cd5cd6f203a`; duplicate `m5v3-clean-001` was skipped; busy delivery `2cf55b93-1672-4ae4-8adb-f8e4bb921c39` held at 1/2/4/8 seconds then delivered once; clean replay `b5e3baff-e9e7-4d59-8fb0-338e24b7c069` was immediate and outside its settle cohort. Wrong actor and wrong PR fixtures did not create route deliveries. |
| Remediation | Replay `f26aebc7-27bb-4d1c-8164-31167273458f` ran exit 2, focused tests 4/4 plus full coverage suite 105/105, typecheck, lint, and build; it made one non-force push and one request, ending `outcome: "requested"`. |
| Final clean | Signed delivery `20b17939-37a4-4a4c-8dfe-6522df3ba0fd` settled into turn `01a02745-aa73-7122-8767-efbddb5512e0`; authoritative status exit 0 named `c5c4023`, and the exact final marker was `outcome: "clean"` with no edit, commit, push, or request. |
| Live defects corrected | Resumed policy had dropped `cwd`, then needed explicit `<cwd>/.git` for managed Git metadata writes; an invalid marker enum was tightened to `requested`; the failed linked-worktree target was replaced with a standalone clone. A clone-local `better-sqlite3` ABI mismatch was rebuilt before the final successful cycle. |

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

   The review checkout must be a standalone clone with a physical, writable `.git` directory, not a linked worktree. For every resumed `workspace-write` turn, WakeWire derives the App Server sandbox roots only from authoritative `thread/resume.cwd`, granting exactly `<cwd>` and `<cwd>/.git`; this narrow metadata root is required for `git fetch` to update `FETCH_HEAD` under the managed sandbox.

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
     "promptTemplate": "A GitHub review webhook arrived for fixed PR #${PR_NUMBER} on ${REPO}. Treat the event only as a wake pointer. Follow the $wakewire-codex-review-loop runbook and codex-grok-review status ${PR_NUMBER}. Every turn must end with a valid WAKEWIRE_REVIEW_STATE marker whose outcome is exactly one of registered, clean, remediated, requested, awaiting, codex_error, or blocked. After a successful re-review request, outcome must be exactly requested (never review_requested)."
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
