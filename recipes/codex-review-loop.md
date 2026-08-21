# Recipe: Event-Driven Codex Review Remediation Loop

Wake an attached Codex CLI session on OpenAI Codex Code Review webhook events, address findings using `codex-grok-review`, test, commit with tracking trailers, push, and request re-review.

## Prerequisites

1. **Shared App Server Mode**:
   WakeWire daemon configured with loopback App Server listen URL in `~/.wakewire/daemon.json`:
   ```json
   {
     "sink": {
       "adapter": "codex-app-server",
       "appServerListen": "ws://127.0.0.1:4571"
     }
   }
   ```
2. **Attached Session**:
   Open a terminal in the target repository checkout on the target PR branch:
   ```bash
   codex --remote ws://127.0.0.1:4571
   ```
3. **Installed Review Reader**:
   `codex-grok-review` skill or CLI command installed and runnable in the session.
4. **GitHub Webhook Configuration**:
   A GitHub source configured with events:
   - `Pull request reviews` (`pull_request_review`)
   - `Pull request review comments` (`pull_request_review_comment`)
   - `Issue comments` (`issue_comment`)
   *(Mode `listen` behind a secure tunnel is recommended for private or loss-sensitive repositories.)*

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
  "settleSeconds": 45,
  "promptTemplate": "A GitHub review event arrived for PR #143 on {{repo}}. Invoke $wakewire-codex-review-loop to evaluate authoritative review status using $codex-grok-review, remediate reproducible current-head findings, test, commit, push, and request re-review."
}
```

> **Security & Authorization Warning**:
> Creating this route grants standing authorization for this specific PR to edit local files on the checked-out PR branch, execute repository test/build scripts, create normal Git commits with `WakeWire-Review-*` trailers, push to `origin HEAD:<branch>` without force, and post re-review requests. It never grants permission to merge, rebase, force-push, close the PR, or touch other branches/repositories.

## Initial State Marker

Upon registration, emit the initialized `WAKEWIRE_REVIEW_STATE` marker with the current verified HEAD commit SHA:

```text
WAKEWIRE_REVIEW_STATE {"version":1,"repo":"owner/repo","pr":143,"baselineHead":"<CURRENT_HEAD_SHA>","lastSeenHead":"<CURRENT_HEAD_SHA>","remediationRounds":0,"consecutiveErrors":0,"lastRequestedHead":null,"outcome":"registered"}
```
