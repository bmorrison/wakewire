# WakeWire (Codex plugin)

The Codex plugin bundle for [WakeWire](https://github.com/glenncalleja/wakewire):
an MCP server (`wakewire mcp`) exposing the `wakewire_*` management tools, plus
the `$wakewire-setup`, `$wakewire-inspect`, and `$wakewire-codex-review-loop` skills for conversational
configuration, delivery triage, and automated PR review remediation loops.

Requires the wakewire daemon: `npm install -g wakewire && wakewire init &&
wakewire start --detach`. Full docs: the repository README and
[docs/setup.md](https://github.com/glenncalleja/wakewire/blob/main/docs/setup.md).

For a quick GitHub test, `$wakewire-setup` creates the default smee.io relay and
returns the URL and secret to add to the GitHub webhook. Cloudflare Tunnel is
optional infrastructure for private or loss-sensitive direct ingress, not a
prerequisite for setup.
