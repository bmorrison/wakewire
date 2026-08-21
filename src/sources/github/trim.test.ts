import { describe, expect, it } from "vitest";
import { trimGithubEvent } from "./trim.js";

describe("trimGithubEvent — push", () => {
  const payload = {
    ref: "refs/heads/main",
    compare: "https://github.com/acme/api/compare/aaa...bbb",
    repository: { full_name: "acme/api", private: true, description: "SECRET DESCRIPTION" },
    pusher: { name: "glenn", email: "glenn@example.com" },
    commits: [
      {
        id: "abc123",
        message: "fix: a bug",
        author: { name: "glenn", email: "g@x" },
        added: ["a.ts"],
        removed: [],
        modified: ["b.ts", "c.ts"],
      },
      {
        id: "def456",
        message: "m".repeat(1000),
        author: { name: "sam" },
        added: [],
        removed: ["gone.ts"],
        modified: [],
      },
    ],
  };

  it("keeps only the whitelisted push fields", () => {
    const event = trimGithubEvent({ eventName: "push", deliveryId: "d-1", payload });
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("push");
    expect(event?.deliveryId).toBe("d-1");
    expect(event?.payload).toMatchObject({
      repo: "acme/api",
      branch: "main",
      pusher: "glenn",
      compareUrl: "https://github.com/acme/api/compare/aaa...bbb",
      commitCount: 2,
    });
    expect(JSON.stringify(event?.payload)).not.toContain("SECRET DESCRIPTION");
    expect(JSON.stringify(event?.payload)).not.toContain("glenn@example.com");
  });

  it("truncates commit messages at 500 chars and counts changed files", () => {
    const event = trimGithubEvent({ eventName: "push", deliveryId: "d-1", payload });
    if (!event) throw new Error("Expected a trimmed push event");
    const commits = event.payload.commits as Array<Record<string, unknown>>;
    const secondCommit = commits[1];
    if (!secondCommit) throw new Error("Expected a second commit");
    expect(commits[0]).toEqual({
      sha: "abc123",
      author: "glenn",
      message: "fix: a bug",
      filesChanged: 3,
    });
    expect((secondCommit.message as string).length).toBeLessThanOrEqual(
      500 + "… [truncated]".length,
    );
    expect(secondCommit.message as string).toContain("[truncated]");
    expect(secondCommit.filesChanged).toBe(1);
  });

  it("caps commits at 20 and records the truncation", () => {
    const many = {
      ...payload,
      commits: Array.from({ length: 30 }, (_, i) => ({
        id: `c${i}`,
        message: "x",
        author: { name: "a" },
      })),
    };
    const event = trimGithubEvent({ eventName: "push", deliveryId: "d-2", payload: many });
    if (!event) throw new Error("Expected a trimmed push event");
    expect((event.payload.commits as unknown[]).length).toBe(20);
    expect(event.payload.commitCount).toBe(30);
    expect(event.payload.commitsTruncatedTo).toBe(20);
    expect(event.summary).toBe("30 commits pushed to acme/api:main by glenn");
  });
});

describe("trimGithubEvent — pull_request / issues / fallback", () => {
  it("trims pull_request events with the action in the kind", () => {
    const event = trimGithubEvent({
      eventName: "pull_request",
      deliveryId: "d-3",
      payload: {
        action: "opened",
        number: 42,
        repository: { full_name: "acme/api" },
        pull_request: {
          title: "Add feature",
          body: "please review",
          html_url: "https://github.com/acme/api/pull/42",
          user: { login: "glenn" },
          head: { ref: "feat/x" },
          base: { ref: "main" },
        },
      },
    });
    expect(event?.kind).toBe("pull_request.opened");
    expect(event?.summary).toBe("PR #42 opened on acme/api: Add feature");
    expect(event?.payload).toMatchObject({
      number: 42,
      author: "glenn",
      branch: "feat/x",
      baseBranch: "main",
    });
  });

  it("trims issues events", () => {
    const event = trimGithubEvent({
      eventName: "issues",
      deliveryId: "d-4",
      payload: {
        action: "closed",
        repository: { full_name: "acme/api" },
        issue: { number: 7, title: "Bug", user: { login: "sam" }, html_url: "u", body: "b" },
      },
    });
    expect(event?.kind).toBe("issues.closed");
    expect(event?.summary).toContain("Issue #7 closed");
  });

  it("falls back to a minimal payload for other events", () => {
    const event = trimGithubEvent({
      eventName: "watch",
      deliveryId: "d-5",
      payload: { action: "started", repository: { full_name: "acme/api" }, sender: { login: "x" } },
    });
    expect(event?.kind).toBe("watch.started");
    expect(event?.payload).toEqual({ repo: "acme/api", action: "started" });
  });

  it("returns null for events without a repository", () => {
    expect(trimGithubEvent({ eventName: "meta", deliveryId: "d", payload: {} })).toBeNull();
  });

  it("tolerates missing fields with safe fallbacks", () => {
    const push = trimGithubEvent({
      eventName: "push",
      deliveryId: "d-6",
      payload: { repository: { full_name: "acme/api" }, commits: [{}, "garbage"] },
    });
    if (!push) throw new Error("Expected a trimmed push event");
    expect(push.payload).toMatchObject({
      repo: "acme/api",
      branch: "",
      pusher: "unknown",
      commitCount: 2,
    });
    expect((push.payload.commits as unknown[])[1]).toEqual({});
    expect((push.payload.commits as Array<Record<string, unknown>>)[0]).toEqual({
      sha: "",
      author: "unknown",
      message: "",
      filesChanged: 0,
    });

    const pr = trimGithubEvent({
      eventName: "pull_request",
      deliveryId: "d-7",
      payload: { repository: { full_name: "acme/api" }, pull_request: {} },
    });
    expect(pr?.kind).toBe("pull_request");
    expect(pr?.summary).toContain("PR #?");
    expect(pr?.payload).toMatchObject({ number: null, author: "unknown", title: "" });

    const issue = trimGithubEvent({
      eventName: "issues",
      deliveryId: "d-8",
      payload: { repository: { full_name: "acme/api" } },
    });
    expect(issue?.payload).toMatchObject({ number: null, author: "unknown" });

    const tag = trimGithubEvent({
      eventName: "push",
      deliveryId: "d-9",
      payload: { repository: { full_name: "acme/api" }, ref: "refs/tags/v1.0.0" },
    });
    expect(tag?.payload.branch).toBe("v1.0.0");
  });
});

describe("trimGithubEvent — pull_request_review / pull_request_review_comment / issue_comment", () => {
  it("trims pull_request_review.submitted to exact PR pointer contract without body", () => {
    const event = trimGithubEvent({
      eventName: "pull_request_review",
      deliveryId: "prr-1",
      payload: {
        action: "submitted",
        repository: { full_name: "acme/api", description: "top secret" },
        sender: { login: "chatgpt-codex-connector[bot]", id: 12345 },
        review: {
          id: 99,
          state: "commented",
          html_url: "https://github.com/acme/api/pull/143#pullrequestreview-99",
          body: "Codex Review: Didn't find any major issues.",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
        pull_request: {
          number: 143,
          title: "Optimize query planner",
          body: "PR description",
          html_url: "https://github.com/acme/api/pull/143",
          head: { ref: "feature/opt-planner", sha: "sha-head-143" },
          base: { ref: "main" },
        },
      },
    });

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("pull_request_review.submitted");
    expect(event?.deliveryId).toBe("prr-1");
    expect(event?.source).toBe("github");
    expect(event?.summary).toBe(
      "PR #143 review submitted on acme/api by chatgpt-codex-connector[bot]",
    );
    expect(event?.payload).toEqual({
      repo: "acme/api",
      action: "submitted",
      number: 143,
      title: "Optimize query planner",
      actor: "chatgpt-codex-connector[bot]",
      prUrl: "https://github.com/acme/api/pull/143",
      activityUrl: "https://github.com/acme/api/pull/143#pullrequestreview-99",
      branch: "feature/opt-planner",
      baseBranch: "main",
      headSha: "sha-head-143",
      reviewState: "commented",
    });
    // Verify exact keys
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual(
      [
        "action",
        "activityUrl",
        "actor",
        "baseBranch",
        "branch",
        "headSha",
        "number",
        "prUrl",
        "repo",
        "reviewState",
        "title",
      ].sort(),
    );
    expect(JSON.stringify(event)).not.toContain("Didn't find any major issues");
    expect(JSON.stringify(event)).not.toContain("top secret");
  });

  it("trims pull_request_review_comment.created to exact comment pointer contract", () => {
    const event = trimGithubEvent({
      eventName: "pull_request_review_comment",
      deliveryId: "prrc-1",
      payload: {
        action: "created",
        repository: { full_name: "acme/api" },
        sender: { login: "chatgpt-codex-connector[bot]" },
        comment: {
          id: 88,
          html_url: "https://github.com/acme/api/pull/143#discussion_r88",
          path: "src/query.ts",
          line: 42,
          original_line: 40,
          body: "![P1 Badge](https://...) Possible SQL injection vulnerability",
        },
        pull_request: {
          number: 143,
          title: "Optimize query planner",
          html_url: "https://github.com/acme/api/pull/143",
          head: { ref: "feature/opt-planner", sha: "sha-head-143" },
          base: { ref: "main" },
        },
      },
    });

    expect(event?.kind).toBe("pull_request_review_comment.created");
    expect(event?.summary).toBe(
      "PR #143 review comment created on acme/api by chatgpt-codex-connector[bot]",
    );
    expect(event?.payload).toEqual({
      repo: "acme/api",
      action: "created",
      number: 143,
      title: "Optimize query planner",
      actor: "chatgpt-codex-connector[bot]",
      prUrl: "https://github.com/acme/api/pull/143",
      activityUrl: "https://github.com/acme/api/pull/143#discussion_r88",
      branch: "feature/opt-planner",
      baseBranch: "main",
      headSha: "sha-head-143",
      path: "src/query.ts",
      line: 42,
    });
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual(
      [
        "action",
        "activityUrl",
        "actor",
        "baseBranch",
        "branch",
        "headSha",
        "line",
        "number",
        "path",
        "prUrl",
        "repo",
        "title",
      ].sort(),
    );
    expect(JSON.stringify(event)).not.toContain("SQL injection");
  });

  it("falls back to original_line when line is null in review comment", () => {
    const event = trimGithubEvent({
      eventName: "pull_request_review_comment",
      deliveryId: "prrc-2",
      payload: {
        action: "created",
        repository: { full_name: "acme/api" },
        sender: { login: "reviewer" },
        comment: {
          html_url: "https://github.com/acme/api/pull/143#discussion_r89",
          path: "src/query.ts",
          line: null,
          original_line: 55,
        },
        pull_request: {
          number: 143,
          title: "PR",
          html_url: "https://github.com/acme/api/pull/143",
          head: { ref: "feat", sha: "sha" },
          base: { ref: "main" },
        },
      },
    });

    expect(event?.payload.line).toBe(55);
  });

  it("trims issue_comment.created on a PR to exact PR comment pointer contract", () => {
    const event = trimGithubEvent({
      eventName: "issue_comment",
      deliveryId: "ic-1",
      payload: {
        action: "created",
        repository: { full_name: "acme/api" },
        sender: { login: "chatgpt-codex-connector[bot]" },
        issue: {
          number: 143,
          title: "Optimize query planner",
          html_url: "https://github.com/acme/api/pull/143",
          pull_request: {
            url: "https://api.github.com/repos/acme/api/pulls/143",
            html_url: "https://github.com/acme/api/pull/143",
          },
        },
        comment: {
          id: 77,
          html_url: "https://github.com/acme/api/pull/143#issuecomment-77",
          body: "Codex Review: Something went wrong.",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      },
    });

    expect(event?.kind).toBe("issue_comment.created");
    expect(event?.summary).toBe(
      "PR #143 comment created on acme/api by chatgpt-codex-connector[bot]",
    );
    expect(event?.payload).toEqual({
      repo: "acme/api",
      action: "created",
      number: 143,
      title: "Optimize query planner",
      actor: "chatgpt-codex-connector[bot]",
      prUrl: "https://github.com/acme/api/pull/143",
      activityUrl: "https://github.com/acme/api/pull/143#issuecomment-77",
    });
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual(
      ["action", "activityUrl", "actor", "number", "prUrl", "repo", "title"].sort(),
    );
    expect(JSON.stringify(event)).not.toContain("Something went wrong");
  });

  it("does not give PR fields to an issue_comment without issue.pull_request", () => {
    const event = trimGithubEvent({
      eventName: "issue_comment",
      deliveryId: "ic-2",
      payload: {
        action: "created",
        repository: { full_name: "acme/api" },
        sender: { login: "sam" },
        issue: {
          number: 50,
          title: "Plain issue",
          html_url: "https://github.com/acme/api/issues/50",
        },
        comment: {
          html_url: "https://github.com/acme/api/issues/50#issuecomment-1",
          body: "I have this problem too",
        },
      },
    });

    expect(event?.kind).toBe("issue_comment.created");
    expect(event?.payload).not.toHaveProperty("prUrl");
    expect(event?.payload).not.toHaveProperty("activityUrl");
  });

  it("falls back to review/comment author login when sender is missing", () => {
    const event = trimGithubEvent({
      eventName: "pull_request_review",
      deliveryId: "prr-2",
      payload: {
        action: "submitted",
        repository: { full_name: "acme/api" },
        review: {
          state: "approved",
          html_url: "https://github.com/acme/api/pull/143#pullrequestreview-100",
          user: { login: "fallback-reviewer" },
        },
        pull_request: {
          number: 143,
          title: "PR",
          html_url: "https://github.com/acme/api/pull/143",
          head: { ref: "feat", sha: "sha" },
          base: { ref: "main" },
        },
      },
    });

    expect(event?.payload.actor).toBe("fallback-reviewer");
  });
});
