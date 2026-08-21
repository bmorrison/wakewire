import crypto from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../../core/event.js";
import type { SecretStore } from "../../secrets/store.js";
import { secretNames } from "../../secrets/store.js";
import type { SourceContext } from "../types.js";
import { GithubWebhookSource } from "./source.js";

const logger = pino({ level: "silent" });

function makeSecretStore(secrets: Record<string, string> = {}): SecretStore {
  const store = new Map<string, string>(Object.entries(secrets));
  return {
    backend: "file",
    get: (key: string) => store.get(key) ?? null,
    set: (key: string, val: string) => {
      store.set(key, val);
    },
    delete: (key: string) => {
      store.delete(key);
    },
  };
}

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GithubWebhookSource.handleWebhook (signed ingress)", () => {
  const sourceId = "github-acme-api";
  const secret = "correct-webhook-secret-42";
  const secrets = makeSecretStore({
    [secretNames.githubWebhookSecret(sourceId)]: secret,
  });

  const reviewCommentPayload = {
    action: "created",
    repository: { full_name: "acme/api", description: "INTERNAL ONLY" },
    sender: { login: "chatgpt-codex-connector[bot]", id: 9876 },
    comment: {
      id: 55,
      html_url: "https://github.com/acme/api/pull/143#discussion_r55",
      path: "src/engine.ts",
      line: 108,
      original_line: 100,
      body: "![P1 Badge](https://...) Possible SQL injection in query planner",
      user: { login: "chatgpt-codex-connector[bot]" },
    },
    pull_request: {
      number: 143,
      title: "Query planner optimization",
      body: "PR body that should not leak",
      html_url: "https://github.com/acme/api/pull/143",
      head: { ref: "feature/opt-planner", sha: "sha-head-143" },
      base: { ref: "main" },
    },
  };

  it("accepts a valid HMAC fixture for a Codex review event and emits a trimmed no-body event", async () => {
    const emitted: WakeEvent[] = [];
    const ctx: SourceContext = {
      logger,
      emit: (event) => emitted.push(event),
    };
    const source = new GithubWebhookSource(sourceId, { mode: "listen" }, secrets, ctx);
    const rawBody = JSON.stringify(reviewCommentPayload);
    const signature = sign(secret, rawBody);

    const result = await source.handleWebhook({
      eventName: "pull_request_review_comment",
      deliveryId: "deliv-rev-1",
      signature,
      rawBody,
    });

    expect(result).toEqual({ status: 200, message: "accepted" });
    expect(emitted).toHaveLength(1);

    const event = emitted[0];
    if (!event) throw new Error("Expected emitted event");
    expect(event.source).toBe("github");
    expect(event.kind).toBe("pull_request_review_comment.created");
    expect(event.deliveryId).toBe("deliv-rev-1");
    expect(event.summary).toBe(
      "PR #143 review comment created on acme/api by chatgpt-codex-connector[bot]",
    );
    expect(event.payload).toEqual({
      repo: "acme/api",
      action: "created",
      number: 143,
      title: "Query planner optimization",
      actor: "chatgpt-codex-connector[bot]",
      prUrl: "https://github.com/acme/api/pull/143",
      activityUrl: "https://github.com/acme/api/pull/143#discussion_r55",
      branch: "feature/opt-planner",
      baseBranch: "main",
      headSha: "sha-head-143",
      path: "src/engine.ts",
      line: 108,
    });

    // Verify raw body / descriptions are completely absent
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("SQL injection");
    expect(serialized).not.toContain("INTERNAL ONLY");
    expect(serialized).not.toContain("PR body that should not leak");
  });

  it("rejects an invalid signature on a Codex review event and emits nothing", async () => {
    const emitted: WakeEvent[] = [];
    const ctx: SourceContext = {
      logger,
      emit: (event) => emitted.push(event),
    };
    const source = new GithubWebhookSource(sourceId, { mode: "listen" }, secrets, ctx);
    const rawBody = JSON.stringify(reviewCommentPayload);
    const invalidSignature = sign("wrong-secret", rawBody);

    const result = await source.handleWebhook({
      eventName: "pull_request_review_comment",
      deliveryId: "deliv-rev-2",
      signature: invalidSignature,
      rawBody,
    });

    expect(result.status).toBe(401);
    expect(result.message).toContain("signature verification failed");
    expect(emitted).toHaveLength(0);
  });

  it("rejects missing signature or headers and emits nothing", async () => {
    const emitted: WakeEvent[] = [];
    const ctx: SourceContext = {
      logger,
      emit: (event) => emitted.push(event),
    };
    const source = new GithubWebhookSource(sourceId, { mode: "listen" }, secrets, ctx);
    const rawBody = JSON.stringify(reviewCommentPayload);

    // Missing signature header
    const noSig = await source.handleWebhook({
      eventName: "pull_request_review_comment",
      deliveryId: "deliv-rev-3",
      signature: undefined,
      rawBody,
    });
    expect(noSig.status).toBe(401);
    expect(emitted).toHaveLength(0);

    // Missing eventName header
    const noEvent = await source.handleWebhook({
      eventName: undefined,
      deliveryId: "deliv-rev-4",
      signature: sign(secret, rawBody),
      rawBody,
    });
    expect(noEvent.status).toBe(400);
    expect(emitted).toHaveLength(0);
  });

  it("accepts a valid signed ping event and emits nothing", async () => {
    const emitted: WakeEvent[] = [];
    const ctx: SourceContext = {
      logger,
      emit: (event) => emitted.push(event),
    };
    const source = new GithubWebhookSource(sourceId, { mode: "listen" }, secrets, ctx);
    const rawBody = JSON.stringify({ zen: "Responsive is better than fast.", hook_id: 1234 });
    const signature = sign(secret, rawBody);

    const result = await source.handleWebhook({
      eventName: "ping",
      deliveryId: "ping-1",
      signature,
      rawBody,
    });

    expect(result).toEqual({ status: 200, message: "pong" });
    expect(emitted).toHaveLength(0);
  });
});
