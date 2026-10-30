import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostComputerRequest } from "./host-computer-protocol.js";
import { localAgentTaskSchema } from "./local-agent/task-protocol.js";
import { userDeviceClientMessage, userDeviceServerMessage } from "./user-device-protocol.js";

/** The message unions as they were before tasks existed. */
const legacyServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request"),
    id: z.string().min(1).max(64),
    request: hostComputerRequest,
  }),
  z.object({ type: z.literal("cancel"), id: z.string().min(1).max(64) }),
  z.object({ type: z.literal("revoked") }),
]);
const legacyClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame"), id: z.string().min(1).max(64), frame: z.unknown() }),
]);

const task = {
  taskId: "task-1",
  prompt: "Open Safari",
  botId: "bot-1",
  grant: { preapproved: {}, onDemand: "ask", denied: {}, expiresAt: "2030-01-01T00:00:00.000Z" },
  model: { provider: "openai-compatible", id: "gpt" },
  budget: { maxSteps: 10, maxSeconds: 300 },
};

describe("device task messages", () => {
  it("a computer that predates tasks ignores them", () => {
    expect(legacyServerMessage.safeParse({ type: "task", id: "a", task }).success).toBe(false);
    expect(legacyServerMessage.safeParse({ type: "taskCancel", id: "a" }).success).toBe(false);
  });

  it("a server that predates tasks ignores what the computer sends", () => {
    expect(
      legacyClientMessage.safeParse({
        type: "taskEvent",
        id: "a",
        event: { kind: "started", at: "2026-01-01T00:00:00.000Z" },
      }).success,
    ).toBe(false);
    expect(
      legacyClientMessage.safeParse({
        type: "taskApproval",
        id: "a",
        request: { approvalId: "x", at: "2026-01-01T00:00:00.000Z", action: "click", summary: "s" },
      }).success,
    ).toBe(false);
  });

  it("reads the task messages when both sides know them", () => {
    expect(userDeviceServerMessage.safeParse({ type: "task", id: "a", task }).success).toBe(true);
    expect(userDeviceServerMessage.safeParse({ type: "taskCancel", id: "a" }).success).toBe(true);
    expect(
      userDeviceServerMessage.safeParse({ type: "taskReply", id: "a", text: "go on" }).success,
    ).toBe(true);
    expect(
      userDeviceServerMessage.safeParse({
        type: "taskDecision",
        id: "a",
        decision: { approvalId: "x", allowed: true },
      }).success,
    ).toBe(true);
    expect(
      userDeviceClientMessage.safeParse({
        type: "taskEvent",
        id: "a",
        event: { kind: "started", at: "2026-01-01T00:00:00.000Z" },
      }).success,
    ).toBe(true);
  });

  it("accepts a task that names no model, so the computer picks its own", () => {
    const parsed = userDeviceServerMessage.safeParse({
      type: "task",
      id: "1",
      task: {
        taskId: "task-1",
        prompt: "Open Safari",
        botId: "bot-1",
        grant: {
          preapproved: {},
          onDemand: "ask",
          denied: {},
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        budget: { maxSteps: 10, maxSeconds: 300 },
      },
    });
    expect(parsed.success).toBe(true);
    // The model key is absent, not null, so an older server cannot send a wrong one.
    expect(parsed.success && parsed.data.type === "task" && parsed.data.task.model).toBeUndefined();
  });

  it("refuses a task that names no grant", () => {
    const { grant: _grant, ...withoutGrant } = task;
    expect(localAgentTaskSchema.safeParse(withoutGrant).success).toBe(false);
  });

  it("refuses a grant that never expires", () => {
    expect(
      localAgentTaskSchema.safeParse({
        ...task,
        grant: { ...task.grant, expiresAt: "" },
      }).success,
    ).toBe(false);
  });
});
