# Getting started

Step-by-step setup for each source, with prompts you can paste straight into a
Codex conversation. Everything conversational goes through the WakeWire plugin's
`wakewire_*` tools; everything secret goes through terminal commands with hidden
prompts, so credentials never transit a model conversation.

## 0. Install (once, ~3 minutes)

```bash
npm install -g wakewire
wakewire init
```

Then choose one process-management mode. For a manually managed background
process, run `wakewire start --detach`. For an always-on service instead,
resolve Codex's absolute path with `command -v codex`, save it with
`wakewire config set sink.codexPath /absolute/path/to/codex`, then run
`wakewire service install`. That command installs and starts a launchd agent on
macOS. On Linux it writes a systemd user unit; finish with
`systemctl --user daemon-reload && systemctl --user enable --now wakewire`.
Do not run both modes. Finally, run `wakewire status` and expect
`adapter.codexReachable: true`. See
[Persistent service operation](setup.md#persistent-service-operation).

Install the Codex plugin:

```bash
codex plugin marketplace add https://github.com/glenncalleja/wakewire   # or a local checkout path
```

then in a `codex` CLI session run `/plugins`, install **WakeWire**, and restart.
(Desktop app: the Plugins screen in settings.)

**Quick sanity check** — paste into any Codex conversation:

> Call wakewire_status and tell me if the daemon is healthy and Codex is reachable.

## 1. Pick where events should land

Routes target a Codex thread. Open the thread you want (a dedicated "triage"
thread works well — every event appends a turn), and note: MCP tools can't see
which thread they're called from, but shell commands can. The prompts below
handle this for you via `echo "$CODEX_THREAD_ID"`.

## 2. GitHub

Paste into the target thread:

> Use $wakewire-setup. Watch pushes to OWNER/REPO on main and deliver them into
> this thread. Create the GitHub source with wakewire_source_setup_github, relay
> the webhook URL and secret to me so I can add them to GitHub settings, then add the route.

## 3. Next steps & Recipes

- **Detailed Source Setup:** See [docs/setup.md](setup.md) for full Gmail, Slack, and generic webhook instructions.
- **Event-Driven Codex Review Remediation:** See [recipes/codex-review-loop.md](../recipes/codex-review-loop.md) and `$wakewire-codex-review-loop` to automatically remediate Codex Code Review findings on pull requests.
- **Webhook Recipes:** See [recipes/](../recipes/) for ready-to-use Linear, Sentry, and ClickUp recipes.
- **Triage & Troubleshooting:** See `$wakewire-inspect` to triage deliveries and inspect error messages.
