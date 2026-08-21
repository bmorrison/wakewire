import { describe, expect, it } from "vitest";
import { buildRouteCreateBody } from "./route-add.js";

describe("buildRouteCreateBody", () => {
  it("returns instructions when target is this-thread", () => {
    const result = buildRouteCreateBody({
      name: "route",
      source: "github",
      match: { repo: "acme/api" },
      target: { type: "this-thread" },
    });
    expect(result.instructions).toContain("CODEX_THREAD_ID");
    expect(result.body).toBeUndefined();
  });

  it("returns error when target.type is thread without threadId", () => {
    const result = buildRouteCreateBody({
      name: "route",
      source: "github",
      match: { repo: "acme/api" },
      target: { type: "thread" },
    });
    expect(result.error).toContain("threadId");
    expect(result.body).toBeUndefined();
  });

  it("returns error when target.type is new-thread without cwd", () => {
    const result = buildRouteCreateBody({
      name: "route",
      source: "github",
      match: { repo: "acme/api" },
      target: { type: "new-thread" },
    });
    expect(result.error).toContain("cwd");
    expect(result.body).toBeUndefined();
  });

  it("serializes route create body with omitted optional values", () => {
    const result = buildRouteCreateBody({
      name: "gh",
      source: "github",
      match: { repo: "acme/api" },
      target: { type: "thread", threadId: "t-1" },
    });
    expect(result.error).toBeUndefined();
    expect(result.body).toEqual({
      name: "gh",
      source: "github",
      match: { repo: "acme/api" },
      target: { type: "thread", threadId: "t-1" },
    });
  });

  it("serializes route create body with networkAccess: false, networkAccess: true, and settleSeconds", () => {
    const withFalse = buildRouteCreateBody({
      name: "gh",
      source: "github",
      match: { repo: "acme/api" },
      target: { type: "thread", threadId: "t-1" },
      networkAccess: false,
      settleSeconds: 45,
    });
    expect(withFalse.body).toMatchObject({
      networkAccess: false,
      settleSeconds: 45,
    });

    const withTrue = buildRouteCreateBody({
      name: "gh review",
      source: "github",
      match: {
        repo: "acme/api",
        events: ["pull_request_review.submitted"],
        pullRequests: [143],
        actors: ["chatgpt-codex-connector[bot]"],
      },
      target: { type: "thread", threadId: "t-1" },
      sandbox: "workspace-write",
      networkAccess: true,
      settleSeconds: 45,
    });
    expect(withTrue.body).toEqual({
      name: "gh review",
      source: "github",
      match: {
        repo: "acme/api",
        events: ["pull_request_review.submitted"],
        pullRequests: [143],
        actors: ["chatgpt-codex-connector[bot]"],
      },
      target: { type: "thread", threadId: "t-1" },
      sandbox: "workspace-write",
      networkAccess: true,
      settleSeconds: 45,
    });
  });
});
