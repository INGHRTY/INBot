import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { TaskGrant } from "./local-agent/grant.js";
import type { TaskStatus } from "./local-agent/task-protocol.js";
import { LocalDeviceCloudAgentProvider } from "./local-device-cloud-agent.js";
import { UserDeviceOfflineError } from "./user-device-gateway.js";
import type {
  UserDeviceGateway,
  UserDeviceTaskCommand,
  UserDeviceTaskHandle,
} from "./user-device-protocol.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};

const grant: TaskGrant = {
  preapproved: {},
  onDemand: "ask",
  denied: {},
  expiresAt: "2030-01-01T00:00:00.000Z",
};

function device(overrides: Partial<UserDeviceGateway> = {}) {
  const started: unknown[] = [];
  const commands: Array<{ taskId: string; command: UserDeviceTaskCommand }> = [];
  let status: TaskStatus = { taskId: "task-1", state: "running" };
  const handle: UserDeviceTaskHandle = {
    updates: () => (async function* () {})(),
    decide: () => undefined,
    cancel: () => undefined,
  };
  const gateway: UserDeviceGateway = {
    connected: async () => ({ deviceId: "device-1", name: "Mac", platform: "darwin" }),
    hasDevice: async () => true,
    request: async function* <T>(): AsyncIterable<T> {
      yield status as T;
    },
    taskCommand: async (userId: string, taskId: string, command: UserDeviceTaskCommand) => {
      commands.push({ taskId, command });
      return true;
    },
    task: async (_userId, task) => {
      started.push(task);
      return handle;
    },
    ...overrides,
  };
  return {
    gateway,
    started,
    commands,
    setStatus: (next: TaskStatus) => {
      status = next;
    },
  };
}

function provider(gateway: UserDeviceGateway) {
  return new LocalDeviceCloudAgentProvider({
    devices: gateway,
    grant: () => grant,
    model: () => ({ provider: "openai", id: "gpt", connectionRef: "ref-1" }),
    budget: { maxSteps: 10, maxSeconds: 60 },
  });
}

describe("local device cloud agent", () => {
  it("sends the task's grant and model connection to the computer", async () => {
    const { gateway, started } = device();
    await provider(gateway).launch({ idempotencyKey: "task-1", prompt: "Open Safari" }, context);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      taskId: "task-1",
      prompt: "Open Safari",
      botId: "bot",
      grant,
      model: { provider: "openai", id: "gpt", connectionRef: "ref-1" },
      budget: { maxSteps: 10, maxSeconds: 60 },
    });
  });

  it("reports a running task as running", async () => {
    const { gateway } = device();
    const snapshot = await provider(gateway).get("task-1", context);
    expect(snapshot).toMatchObject({ id: "task-1", status: "running" });
  });

  it("brings the answer back with a finished task", async () => {
    const { gateway, setStatus } = device();
    setStatus({ taskId: "task-1", state: "finished", answer: "Safari is open" });
    const snapshot = await provider(gateway).get("task-1", context);
    expect(snapshot.status).toBe("finished");
    expect(snapshot.result).toBe("Safari is open");
  });

  it("carries the action the task is waiting to be allowed to take", async () => {
    const { gateway, setStatus } = device();
    setStatus({
      taskId: "task-1",
      state: "running",
      awaitingApproval: { action: "type", summary: "Type in Safari", detail: "hunter2" },
    });
    const snapshot = await provider(gateway).get("task-1", context);
    expect(snapshot.awaitingApproval).toEqual({
      action: "type",
      summary: "Type in Safari",
      detail: "hunter2",
    });
  });

  it("reports a failed task as failed", async () => {
    const { gateway, setStatus } = device();
    setStatus({ taskId: "task-1", state: "failed", error: "The screen was locked" });
    const snapshot = await provider(gateway).get("task-1", context);
    expect(snapshot.status).toBe("failed");
  });

  it("treats a task the computer forgot as no longer running", async () => {
    const { gateway, setStatus } = device();
    setStatus({ taskId: "task-1", state: "unknown" });
    const snapshot = await provider(gateway).get("task-1", context);
    expect(snapshot.status).toBe("failed");
  });

  it("hands an instruction to the running task", async () => {
    const { gateway, commands } = device();
    await provider(gateway).reply("task-1", { prompt: "Also check the inbox" }, context);
    expect(commands).toEqual([
      { taskId: "task-1", command: { type: "reply", text: "Also check the inbox" } },
    ]);
  });

  it("refuses to reply to a task that is over", async () => {
    const { gateway } = device({ taskCommand: async () => false });
    await expect(
      provider(gateway).reply("task-1", { prompt: "Keep going" }, context),
    ).rejects.toBeInstanceOf(CloudAgentRequestRejected);
  });

  it("stops the task when the cloud cancels it", async () => {
    const { gateway, commands, setStatus } = device();
    setStatus({ taskId: "task-1", state: "finished", answer: "done" });
    const snapshot = await provider(gateway).cancel("task-1", context);
    expect(commands).toEqual([{ taskId: "task-1", command: { type: "cancel" } }]);
    expect(snapshot.status).toBe("finished");
  });

  it("answers a permission request the computer raised", async () => {
    const { gateway, commands } = device();
    await provider(gateway).decide(
      "task-1",
      { approvalId: "click@Safari", allowed: true },
      context,
    );
    expect(commands).toEqual([
      {
        taskId: "task-1",
        command: { type: "decision", decision: { approvalId: "click@Safari", allowed: true } },
      },
    ]);
  });

  it("asks again later when the computer is not connected", async () => {
    const { gateway } = device({
      request: (): AsyncIterable<never> => ({
        [Symbol.asyncIterator]: () => {
          throw new UserDeviceOfflineError();
        },
      }),
    });
    const snapshot = await provider(gateway).get("task-1", context);
    expect(snapshot.status).toBe("failed");
  });

  it("waits rather than failing when the launch cannot reach the computer", async () => {
    const { gateway } = device({
      task: vi.fn(async () => {
        throw new UserDeviceOfflineError();
      }) as unknown as UserDeviceGateway["task"],
    });
    await expect(
      provider(gateway).launch({ idempotencyKey: "task-1", prompt: "Open Safari" }, context),
    ).rejects.toMatchObject({ name: "CloudAgentRetryLater", retryAfterMs: 60_000 });
  });
});
