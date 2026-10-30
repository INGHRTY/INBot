import { describe, expect, it } from "vitest";
import { cloudAgentBlockFromPayload, cloudAgentHttpsUrl } from "./cloud-agent.js";
import { projectMessages } from "./events.js";

describe("shared cloud agent projection", () => {
  it("updates an existing card when replaying durable events", () => {
    const base = { threadId: "thread", createdAt: "2026-01-01T00:00:00Z", botId: "bot" };
    const block = cloudAgentBlockFromPayload({
      agentId: "agent",
      title: "Task",
      status: "running",
      url: "https://example.test/agent",
    });
    const messages = projectMessages([
      {
        ...base,
        id: "first",
        seq: 1,
        type: "thread.message.created",
        payload: { messageId: "card", role: "bot", blocks: [block] },
      },
      {
        ...base,
        id: "second",
        seq: 2,
        type: "thread.cloud_agent",
        payload: {
          ...block,
          messageId: "card",
          status: "finished",
          prUrl: "https://example.test/pr",
        },
      },
    ]);
    expect(messages[0]?.blocks[0]).toMatchObject({
      status: "finished",
      prUrl: "https://example.test/pr",
    });
  });
  it("normalizes invalid statuses and excludes unsafe links on every surface", () => {
    expect(
      cloudAgentBlockFromPayload({
        status: "invalid",
        url: "javascript:alert(1)",
        prUrl: "http://example.test/pr",
      }),
    ).toMatchObject({ status: "running", url: "" });
    for (const url of [
      "javascript:alert(1)",
      "file:///tmp/fake",
      "https://user:password@example.test",
      "invalid",
    ])
      expect(cloudAgentHttpsUrl(url)).toBeUndefined();
  });
  it("carries the exact action a task waits on, and drops one that names no id", () => {
    const waiting = cloudAgentBlockFromPayload({
      status: "running",
      awaitingApproval: {
        approvalId: "type#1a2b3c4d",
        action: "type",
        summary: "Type in Safari",
        detail: "INV-2041",
      },
    });
    expect(waiting.awaitingApproval).toEqual({
      approvalId: "type#1a2b3c4d",
      action: "type",
      summary: "Type in Safari",
      detail: "INV-2041",
    });
    // An answer keyed to a stale action is worse than showing nothing, so a card without
    // an id is not shown as waiting at all.
    expect(
      cloudAgentBlockFromPayload({
        status: "running",
        awaitingApproval: { action: "type", summary: "Type in Safari" },
      }).awaitingApproval,
    ).toBeUndefined();
  });

  it("shows the answer a task gave, and nothing it did not", () => {
    expect(
      cloudAgentBlockFromPayload({ status: "finished", result: "Safari is open" }).result,
    ).toBe("Safari is open");
    expect(cloudAgentBlockFromPayload({ status: "running", result: "" }).result).toBeUndefined();
  });

  it("carries the computer's reason for refusing an action", () => {
    expect(
      cloudAgentBlockFromPayload({
        status: "running",
        blockedReason: "Network access is off for this task.",
      }).blockedReason,
    ).toBe("Network access is off for this task.");
    expect(cloudAgentBlockFromPayload({ status: "running" }).blockedReason).toBeUndefined();
  });
});
