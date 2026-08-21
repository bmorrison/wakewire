import { z } from "zod";

export const WakewireRouteAddInputSchema = {
  name: z.string().min(1).describe("Short human name for the route"),
  source: z.enum(["github", "gmail", "slack", "webhook"]),
  match: z
    .record(z.string(), z.unknown())
    .describe("Source-specific match rules (see tool description)"),
  target: z.object({
    type: z.enum(["this-thread", "thread", "new-thread"]),
    threadId: z.string().optional().describe('Required when type is "thread"'),
    cwd: z.string().optional().describe('Required when type is "new-thread"'),
    worktree: z
      .boolean()
      .optional()
      .describe("new-thread only: run in a fresh git worktree per delivery"),
  }),
  promptTemplate: z
    .string()
    .optional()
    .describe(
      "Optional instructions template. May interpolate only whitelisted summary fields " +
        "like {{summary}}, {{repo}}, {{branch}}, {{subject}} — never raw payload content.",
    ),
  sandbox: z
    .enum(["read-only", "workspace-write"])
    .optional()
    .describe("Sandbox for injected turns. Default read-only. Gmail routes are always read-only."),
  rateLimitPerMinute: z
    .number()
    .int()
    .positive()
    .max(600)
    .optional()
    .describe(
      "Deliveries per minute for this route before bursts coalesce into a digest turn (default 10).",
    ),
  settleSeconds: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .optional()
    .describe(
      "Trailing-edge quiet window (in seconds) before delivering a batch. Omit for immediate delivery.",
    ),
  networkAccess: z
    .boolean()
    .optional()
    .describe(
      "Explicit unattended outbound network access grant. Default false; only allowed for GitHub routes with workspace-write sandbox.",
    ),
};

export type WakewireRouteAddArgs = z.infer<z.ZodObject<typeof WakewireRouteAddInputSchema>>;

export function buildRouteCreateBody(args: WakewireRouteAddArgs): {
  body?: Record<string, unknown>;
  error?: string;
  instructions?: string;
} {
  if (args.target.type === "this-thread") {
    return {
      instructions: [
        "To target the current thread I need its id, and MCP tools cannot see it.",
        "Do this now:",
        '1. Run this shell command in this conversation: echo "$CODEX_THREAD_ID"',
        "   (Codex exposes the current thread id to shell commands.)",
        '2. Call wakewire_route_add again with target {"type":"thread","threadId":"<the value>"}.',
      ].join("\n"),
    };
  }
  if (args.target.type === "thread" && !args.target.threadId) {
    return { error: 'target.type "thread" requires target.threadId' };
  }
  if (args.target.type === "new-thread" && !args.target.cwd) {
    return { error: 'target.type "new-thread" requires target.cwd (an absolute path)' };
  }
  const target =
    args.target.type === "thread"
      ? { type: "thread", threadId: args.target.threadId }
      : { type: "new-thread", cwd: args.target.cwd, worktree: args.target.worktree ?? false };

  const body: Record<string, unknown> = {
    name: args.name,
    source: args.source,
    match: args.match,
    target,
  };

  if (args.promptTemplate !== undefined) body.promptTemplate = args.promptTemplate;
  if (args.sandbox !== undefined) body.sandbox = args.sandbox;
  if (args.rateLimitPerMinute !== undefined) body.rateLimitPerMinute = args.rateLimitPerMinute;
  if (args.settleSeconds !== undefined) body.settleSeconds = args.settleSeconds;
  if (args.networkAccess !== undefined) body.networkAccess = args.networkAccess;

  return { body };
}
