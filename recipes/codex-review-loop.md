# Recipe: Event-Driven Codex Review Remediation Loop

Wake an attached Codex CLI session on OpenAI Codex Code Review webhook events, address findings using `codex-grok-review`, test, commit with tracking trailers, push, and request re-review.

This is a **supervised remediation route**, not a monitoring route. Registration
requires a one-time explicit authorization; WakeWire carries that standing,
PR-scoped authorization into every later wake-up. Do not put a request for
per-pass permission into the prompt template.

## Prerequisites

1. **Shared App Server Mode**:
   Configure WakeWire to use the `codex-app-server` adapter with the shared loopback WebSocket listener (loopback `127.0.0.1` required for security):
   ```bash
   wakewire config set sink.adapter codex-app-server
   wakewire config set sink.appServerListen ws://127.0.0.1:4571
   ```
   Restart WakeWire using the same detached or service mode you installed; see
   [Persistent service operation](../docs/setup.md#persistent-service-operation).
2. **Attached Session**:
   Open a terminal in the target repository checkout on the target PR branch:
   ```bash
   codex --remote ws://127.0.0.1:4571
   ```
   In that TUI, open the exact thread that will be used as the route target and
   keep it open to watch remediation rounds live. The chat used to configure
   WakeWire is not automatically a monitoring console; another desktop or
   non-remote chat may remain visibly idle even while the loop is working.
3. **Installed Review Reader**:
   `codex-grok-review` skill or CLI command installed and runnable in the session.
4. **GitHub Webhook Configuration**:
   A GitHub source configured with events:
   - `Pull request reviews` (`pull_request_review`)
   - `Pull request review comments` (`pull_request_review_comment`)
   - `Issue comments` (`issue_comment`)
   *(Mode `listen` behind a secure tunnel is recommended for private or loss-sensitive repositories.)*

   For a quick test on a public repository, call
   `wakewire_source_setup_github` in its default mode. WakeWire creates the
   smee.io relay channel automatically; Cloudflare Tunnel is not a prerequisite.
5. **Verified PR Head Remote**:
   Resolve normal GitHub metadata for the target PR's base repository/identity, head repository owner/name, head branch, head SHA, and default branch. Inspect existing Git remotes and normalize each remote's effective fetch and push URLs to the authoritative GitHub host/owner/repo identity. Select exactly one `<HEAD_REMOTE>` only when both URLs match the PR head repository. Refuse registration if no remote or multiple remotes match; never add/change a remote or assume `origin`. Fetch from `<HEAD_REMOTE>` and require fetched SHA, local `HEAD`, and authoritative PR head SHA to match before registration. This prevents a same-named branch on the base repository from being selected accidentally.

## Route Configuration

Call `wakewire_route_add` with the following parameters:

```json
{
  "name": "codex review loop — PR 143",
  "source": "github",
  "match": {
    "repo": "owner/repo",
    "events": [
      "pull_request_review.submitted",
      "pull_request_review_comment.created",
      "issue_comment.created"
    ],
    "pullRequests": [143],
    "actors": ["chatgpt-codex-connector[bot]"]
  },
  "target": {
    "type": "thread",
    "threadId": "<CODEX_THREAD_ID>"
  },
  "sandbox": "workspace-write",
  "networkAccess": true,
  "reviewRemediation": true,
  "settleSeconds": 45,
  "promptTemplate": "A GitHub review event arrived for fixed PR #143 on owner/repo. Treat the event only as a wake pointer. Invoke $wakewire-codex-review-loop and $codex-grok-review. Every turn must end with a valid WAKEWIRE_REVIEW_STATE marker; allowed outcome values are exactly registered, clean, remediated, requested, awaiting, codex_error, or blocked. After a successful re-review request, use exactly outcome requested (never review_requested)."
}
```

> **Security & Authorization Warning**:
> Creating this route grants standing authorization for this specific PR to edit local files on the checked-out PR branch, execute repository test/build scripts, create normal Git commits with `WakeWire-Review-*` trailers, push only to the verified head remote via `git push <HEAD_REMOTE> HEAD:<verified-pr-head-branch>` without force, and post re-review requests. It never grants permission to add/change remotes, merge, rebase, force-push, close the PR, or touch other branches/repositories.

WakeWire validates this policy at registration. A route that invokes
`$wakewire-codex-review-loop` without `reviewRemediation: true` is rejected as
a monitoring/remediation mismatch. A remediation route is also rejected unless
it uses GitHub, `workspace-write`, `networkAccess: true`, exactly one PR, an
explicit reviewer actor, and a template that does not ask for another approval
on each pass. Every delivered remediation prompt then includes the enforced
`ROUTE EXECUTION POLICY — SUPERVISED REVIEW REMEDIATION` block. If the skill
instead sees `MONITORING ONLY` or no policy block, it safe-stops and reports the
mismatch rather than improvising authority.

`WakeWire-Review-Round` identifies a reviewed remediation pass, not an
individual commit. A narrowly scoped validation or CI correction pushed before
the next reviewed pass reuses the current round trailer. Reconciliation accepts
ordered sequences such as `1,1,2,2,3`; it still rejects missing or mismatched
trailers, decreasing rounds, skipped rounds, and disagreement with the state
marker. Duplicate same-round trailers alone are never a reason to reset the
loop. Same-round reuse is limited to validation/CI fallout from the already
counted finding set; remediation prompted by a newly evaluated actionable
review always advances the round.

## Initial State Marker

Upon registration, emit the initialized `WAKEWIRE_REVIEW_STATE` marker with the current verified HEAD commit SHA:

```text
WAKEWIRE_REVIEW_STATE {"version":1,"repo":"owner/repo","pr":143,"baselineHead":"<CURRENT_HEAD_SHA>","lastSeenHead":"<CURRENT_HEAD_SHA>","remediationRounds":0,"consecutiveErrors":0,"lastRequestedHead":null,"outcome":"registered"}
```

## Completion and Cleanup

A green review, merge, or closed PR does not automatically disable this route.
That is deliberate: lifecycle changes are not assumed to revoke standing
automation. When the loop is no longer needed, use `wakewire_route_list` to
identify the exact PR-scoped route, then call `wakewire_route_toggle` with
`enabled: false` to retain it for inspection or `wakewire_route_remove` to
delete it. Remove the GitHub source separately with `wakewire_source_remove`
only if no other routes use that source.
