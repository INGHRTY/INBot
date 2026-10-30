import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { TaskGrant } from "./local-agent/grant.js";
import type { ActionApprovalDecision } from "./local-agent/grant-protocol.js";
import type { LocalAgentTask, TaskStatus } from "./local-agent/task-protocol.js";
import { UserDeviceOfflineError } from "./user-device-gateway.js";
import type { UserDeviceGateway, UserDeviceTaskCommand } from "./user-device-protocol.js";

/** How long a status question to the computer may take. */
const STATUS_TIMEOUT_MS = 20_000;
/** How long an instruction handed to a running task may take to be accepted. */
const REPLY_TIMEOUT_MS = 20_000;

export interface LocalDeviceCloudAgentOptions {
  devices: UserDeviceGateway;
  /** The grant a task runs under. The computer enforces it; the cloud only sends it. */
  grant: (context: AdapterContext) => TaskGrant | Promise<TaskGrant>;
  /** Which model connection on the computer the task uses. */
  model: (context: AdapterContext) => { provider: string; id: string; connectionRef?: string };
  budget?: { maxSteps: number; maxSeconds: number };
}

/**
 * Runs a task on the person's own computer.
 *
 * The computer runs the whole loop: it reads its own screen, talks to its own model, and
 * reports back an answer and a few one-line steps. Nothing but the task goes out and
 * nothing but text comes back.
 *
 * A task's id is stable across polls, so a repeated launch replays the result instead of
 * doing the work twice.
 */
export class LocalDeviceCloudAgentProvider implements CloudAgentProvider {
  constructor(private readonly options: LocalDeviceCloudAgentOptions) {}

  describe() {
    return {
      id: "local-device",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: false },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const task = await this.taskFor(request, context);
    const signal = signalFor(request.signal, context.signal, STATUS_TIMEOUT_MS);
    try {
      const handle = await this.options.devices.task(context.userId, task, signal);
      // The task runs on the computer, and every later poll asks the computer how it
      // ended, so nothing here needs the updates. Draining them keeps them from piling
      // up on a task that runs for minutes.
      void drain(handle.updates(signal));
    } catch (error) {
      throw refusal(error);
    }
    return {
      id: task.taskId,
      url: "",
      title: request.prompt.split(/\r?\n/, 1)[0]?.slice(0, 80) ?? "Task",
      status: "running",
    };
  }

  async get(id: string, context: AdapterContext): Promise<CloudAgentSnapshot> {
    const status = await this.status(id, context);
    return {
      id,
      url: "",
      title: "",
      status: statusState(status),
      ...(status.answer !== undefined ? { result: status.answer } : {}),
      ...(status.awaitingApproval ? { awaitingApproval: status.awaitingApproval } : {}),
      latestRunId: id,
    };
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const delivered = await this.command(id, context, { type: "reply", text: request.prompt });
    if (!delivered) {
      // A task that is over cannot take an instruction, and waiting will not change that.
      throw new CloudAgentRequestRejected("not_found");
    }
    return { id, url: "", title: "", status: "running", latestRunId: id };
  }

  async cancel(id: string, context: AdapterContext): Promise<CloudAgentSnapshot> {
    // A task that already ended cannot be cancelled; either way the computer says where
    // it ended up, which is what the poller stores.
    await this.command(id, context, { type: "cancel" }).catch(() => false);
    return this.get(id, context);
  }

  /** Tells a running task something, or reports that nothing is running to tell. */
  private async command(
    taskId: string,
    context: AdapterContext,
    command: UserDeviceTaskCommand,
  ): Promise<boolean> {
    try {
      return await this.options.devices.taskCommand(context.userId, taskId, command);
    } catch (error) {
      if (error instanceof UserDeviceOfflineError) {
        throw new CloudAgentRetryLater("unavailable", 30_000);
      }
      throw refusal(error);
    }
  }

  /** Answers a permission request the computer raised. False when the task is gone. */
  async decide(
    taskId: string,
    decision: ActionApprovalDecision,
    context: AdapterContext,
  ): Promise<boolean> {
    return this.command(taskId, context, { type: "decision", decision });
  }

  private async status(taskId: string, context: AdapterContext): Promise<TaskStatus> {
    const signal = signalFor(undefined, context.signal, STATUS_TIMEOUT_MS);
    try {
      let found: TaskStatus | undefined;
      for await (const value of this.options.devices.request<TaskStatus>(
        context.userId,
        { method: "taskStatus", botId: context.botId ?? "", taskId },
        signal,
      )) {
        found = value;
      }
      return found ?? { taskId, state: "unknown" };
    } catch (error) {
      if (error instanceof UserDeviceOfflineError) {
        // The task cannot still be running on a computer that is not connected.
        return { taskId, state: "unknown" };
      }
      throw refusal(error);
    }
  }

  private async taskFor(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<LocalAgentTask> {
    const grant = await this.options.grant(context);
    return {
      taskId: request.idempotencyKey,
      prompt: request.prompt,
      botId: context.botId ?? "",
      grant,
      model: this.options.model(context),
      budget: this.options.budget ?? { maxSteps: 40, maxSeconds: 600 },
    };
  }
}

/** Reads an update stream to its end and keeps nothing. */
async function drain(updates: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const update of updates) void update;
  } catch {
    // The connection went away; the next status poll reports what happened.
  }
}

/** A status the cloud can act on. A task it cannot see is not running any more. */
function statusState(status: TaskStatus): CloudAgentStatus {
  if (status.state === "finished") return "finished";
  if (status.state === "failed") return "failed";
  if (status.state === "running") return "running";
  // The computer no longer knows this task, so nothing will report it again.
  return "failed";
}

/** Turns a transport failure into the refusal the poller understands. */
function refusal(error: unknown): Error {
  if (error instanceof UserDeviceOfflineError) {
    // The computer is not connected. A later poll may find it again.
    return new CloudAgentRetryLater("unavailable", 60_000);
  }
  if (error instanceof CloudAgentRetryLater || error instanceof CloudAgentRequestRejected) {
    return error;
  }
  getLogger().warn("local device task failed to reach the computer");
  return new CloudAgentRetryLater("unavailable", 30_000);
}

function signalFor(
  requestSignal: AbortSignal | undefined,
  contextSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  return AbortSignal.any([
    ...(requestSignal ? [requestSignal] : []),
    ...(contextSignal ? [contextSignal] : []),
    AbortSignal.timeout(timeoutMs),
  ]);
}
