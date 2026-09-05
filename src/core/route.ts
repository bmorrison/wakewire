import { z } from "zod";

export const GithubMatchSchema = z.object({
  /** "owner/repo" */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/repo"'),
  /**
   * GitHub event names, optionally with an action suffix: "push",
   * "pull_request", "pull_request.opened", "issues.closed".
   * A bare event name matches all of its actions.
   */
  events: z.array(z.string().min(1)).min(1).default(["push"]),
  /** For push events: only these branches. Omit for all branches. */
  branches: z.array(z.string().min(1)).optional(),
  /** For PR events: match only these PR numbers. */
  pullRequests: z.array(z.number().int().positive()).min(1).optional(),
  /** For PR/review events: match only these sender logins (exact, case-insensitive). */
  actors: z.array(z.string().min(1)).min(1).optional(),
});

export const SlackMatchSchema = z
  .object({
    /**
     * Channel ids (C…) or names (with or without "#"). Required when matching
     * plain messages — mention-only routes may span all channels the bot is in.
     */
    channels: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Slack event types: "app_mention" (default), "message",
     * "message.<subtype>", "reaction_added". Bare "message" matches all subtypes.
     */
    events: z.array(z.string().min(1)).min(1).default(["app_mention"]),
    /**
     * Filter on the sender: a Slack user id (U…, stable) or an exact
     * case-insensitive display name. Names are mutable and non-unique — use an
     * id when the filter is a trust boundary, not just a convenience.
     */
    fromUser: z.string().min(1).optional(),
    /** Case-insensitive substring the message text must contain. */
    textContains: z.string().min(1).optional(),
  })
  .superRefine((match, ctx) => {
    const wantsMessages = match.events.some((e) => e === "message" || e.startsWith("message."));
    if (wantsMessages && (!match.channels || match.channels.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["channels"],
        message:
          'matching "message" events requires naming channels — watching every message everywhere is not allowed',
      });
    }
  });

export const WebhookMatchSchema = z.object({
  /** Required: the generic source's provider name (its config.name). */
  provider: z.string().min(1, "webhook routes must name a provider"),
  /** Optional kind filters, prefix-matched like other sources. */
  events: z.array(z.string().min(1)).min(1).optional(),
  /** Conditions on MAPPED payload fields (all must hold). */
  where: z
    .array(
      z
        .object({
          field: z.string().min(1),
          equals: z.string().optional(),
          contains: z.string().optional(),
        })
        .refine((w) => (w.equals === undefined) !== (w.contains === undefined), {
          message: "each condition needs exactly one of equals/contains",
        }),
    )
    .optional(),
});

export const GmailMatchSchema = z.object({
  /**
   * Required: a Gmail label (IMAP mailbox) to watch. Routes that would match
   * the whole inbox are rejected by design.
   */
  label: z.string().min(1, "gmail routes must name a label — matching everything is not allowed"),
  /** Case-insensitive substring filter on the From header. */
  fromContains: z.string().min(1).nullish(),
});

export const RouteTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thread"),
    /** Existing Codex thread id (UUID from ~/.codex/sessions). */
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("new-thread"),
    /** Working directory for the spawned thread. */
    cwd: z.string().min(1),
    /** Create a fresh git worktree of cwd per delivery and run the thread there. */
    worktree: z.boolean().default(false),
  }),
]);

export const SandboxPolicySchema = z.enum(["read-only", "workspace-write"]);

/**
 * A review-loop skill is privileged workflow guidance, not a monitoring
 * instruction. Keep this token centralized so the route admission check and
 * documentation cannot silently describe different policies.
 */
export const REVIEW_REMEDIATION_SKILL = "$wakewire-codex-review-loop";

const PER_PASS_PERMISSION_GATE =
  /\b(?:ask|request|seek|obtain|get|wait for)\b[^.!?\n]{0,120}\b(?:permission|approval|authorization|confirmation|consent)\b/gi;
const PER_PASS_PERMISSION_NEGATION = /\b(?:do not|don't|never|must not|should not)\s*$/i;

function asksForPerPassPermission(template: string): boolean {
  for (const match of template.matchAll(PER_PASS_PERMISSION_GATE)) {
    const prefix = template.slice(Math.max(0, (match.index ?? 0) - 24), match.index);
    if (!PER_PASS_PERMISSION_NEGATION.test(prefix)) return true;
  }
  return false;
}

function matchSchemaFor(source: "github" | "gmail" | "slack" | "webhook") {
  switch (source) {
    case "github":
      return GithubMatchSchema;
    case "gmail":
      return GmailMatchSchema;
    case "webhook":
      return WebhookMatchSchema;
    default:
      return SlackMatchSchema;
  }
}

export const RouteInputSchema = z
  .object({
    name: z.string().min(1).max(100),
    source: z.enum(["github", "gmail", "slack", "webhook"]),
    match: z.record(z.string(), z.unknown()),
    target: RouteTargetSchema,
    promptTemplate: z.string().max(4000).optional(),
    sandbox: SandboxPolicySchema.default("read-only"),
    /** Deliveries per minute before coalescing into a digest. Omit to use the daemon default (10). */
    rateLimitPerMinute: z.number().int().positive().max(600).optional(),
    /** Trailing-edge quiet window (in seconds) before delivering a batch. Omit for immediate delivery. */
    settleSeconds: z.number().int().min(1).max(3600).optional(),
    /** Explicit unattended network access grant (github + workspace-write only). */
    networkAccess: z.boolean().default(false),
    /**
     * Enables the tightly scoped Codex review remediation workflow. Ordinary
     * routes are monitoring/delivery routes and must not invoke that skill.
     */
    reviewRemediation: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .superRefine((route, ctx) => {
    const parsed = matchSchemaFor(route.source).safeParse(route.match);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", path: ["match", ...issue.path], message: issue.message });
      }
    }
    if (route.source === "gmail" && route.sandbox !== "read-only") {
      ctx.addIssue({
        code: "custom",
        path: ["sandbox"],
        message: "gmail routes are forced to read-only sandbox",
      });
    }
    if (route.networkAccess && (route.source !== "github" || route.sandbox !== "workspace-write")) {
      ctx.addIssue({
        code: "custom",
        path: ["networkAccess"],
        message: "networkAccess is only allowed on github workspace-write routes",
      });
    }

    const invokesReviewRemediation =
      route.promptTemplate?.includes(REVIEW_REMEDIATION_SKILL) ?? false;
    if (invokesReviewRemediation && !route.reviewRemediation) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewRemediation"],
        message:
          "a monitoring route cannot invoke $wakewire-codex-review-loop; register it with reviewRemediation: true after the explicit setup authorization",
      });
    }
    if (!route.reviewRemediation) return;

    if (!invokesReviewRemediation) {
      ctx.addIssue({
        code: "custom",
        path: ["promptTemplate"],
        message: "reviewRemediation routes must invoke $wakewire-codex-review-loop",
      });
    }
    if (route.source !== "github") {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "reviewRemediation routes must use the github source",
      });
    }
    if (route.sandbox !== "workspace-write") {
      ctx.addIssue({
        code: "custom",
        path: ["sandbox"],
        message: "reviewRemediation routes require the workspace-write sandbox",
      });
    }
    if (!route.networkAccess) {
      ctx.addIssue({
        code: "custom",
        path: ["networkAccess"],
        message:
          "reviewRemediation routes require networkAccess: true for the verified push and re-review",
      });
    }
    if (parsed.success && route.source === "github") {
      const match = parsed.data as GithubMatch;
      if (match.pullRequests?.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["match", "pullRequests"],
          message: "reviewRemediation routes must be scoped to exactly one pull request",
        });
      }
      if (!match.actors?.length) {
        ctx.addIssue({
          code: "custom",
          path: ["match", "actors"],
          message: "reviewRemediation routes must scope wake-ups to an explicit reviewer actor",
        });
      }
    }
    if (route.promptTemplate && asksForPerPassPermission(route.promptTemplate)) {
      ctx.addIssue({
        code: "custom",
        path: ["promptTemplate"],
        message:
          "reviewRemediation routes use the setup confirmation as standing authorization; remove per-pass permission or approval requests",
      });
    }
  })
  .transform((route) => {
    // Persist the PARSED match so schema defaults (github events: ["push"],
    // slack events: ["app_mention"]) reach the router — storing the raw input
    // dropped them and made the router throw on default routes.
    const parsed = matchSchemaFor(route.source).safeParse(route.match);
    return {
      ...route,
      match: (parsed.success ? parsed.data : route.match) as
        | GithubMatch
        | GmailMatch
        | SlackMatch
        | WebhookMatch,
    };
  });

export type GithubMatch = z.infer<typeof GithubMatchSchema>;
export type GmailMatch = z.infer<typeof GmailMatchSchema>;
export type SlackMatch = z.infer<typeof SlackMatchSchema>;
export type WebhookMatch = z.infer<typeof WebhookMatchSchema>;
export type RouteTarget = z.infer<typeof RouteTargetSchema>;
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;
export type RouteInput = z.infer<typeof RouteInputSchema>;
export type RouteInputRaw = z.input<typeof RouteInputSchema>;

export interface Route {
  id: string;
  name: string;
  source: "github" | "gmail" | "slack" | "webhook";
  match: GithubMatch | GmailMatch | SlackMatch | WebhookMatch;
  target: RouteTarget;
  promptTemplate: string | null;
  sandbox: SandboxPolicy;
  /** null = use the daemon-wide default. */
  rateLimitPerMinute: number | null;
  settleSeconds: number | null;
  networkAccess: boolean;
  /** True only for an explicitly authorized, single-PR review remediation route. */
  reviewRemediation: boolean;
  enabled: boolean;
  createdAt: string;
}
