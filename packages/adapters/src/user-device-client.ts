import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import WebSocket from "ws";
import type { HostComputerFrame } from "./host-computer-protocol.js";
import { HOST_COMPUTER_MAX_BYTES } from "./host-computer-protocol.js";
import type { HostComputerCall } from "./host-computer-runner.js";
import { createHostComputerRunner } from "./host-computer-runner.js";
import type {
  ActionApprovalDecision,
  ActionApprovalRequest,
} from "./local-agent/grant-protocol.js";
import type { LocalAgentTask, TaskEvent, TaskStatus } from "./local-agent/task-protocol.js";
import { isTerminalTaskEvent } from "./local-agent/task-protocol.js";
import type { UserDeviceClientMessage } from "./user-device-protocol.js";
import { userDeviceServerMessage } from "./user-device-protocol.js";

/** One frame or request plus its small envelope, in either direction. */
export const USER_DEVICE_MAX_MESSAGE_BYTES = HOST_COMPUTER_MAX_BYTES + 4096;
const PING_INTERVAL_MS = 30_000;
const BUSY_MESSAGE = "Local computer is busy. Try again shortly.";
const NOT_ALLOWED_MESSAGE = "Not allowed on this computer";
const NO_TASKS_MESSAGE = "This computer cannot run tasks yet.";

/** What a running task can do while it runs. */
export interface UserDeviceTaskControl {
  /** Aborted when the task is cancelled or the connection drops. */
  signal: AbortSignal;
  /** Reports progress to the cloud. */
  event(event: TaskEvent): void;
  /** Asks the user to approve one action and waits for the answer. */
  approve(request: ActionApprovalRequest): Promise<ActionApprovalDecision>;
  /** Waits for the next instruction from the cloud, or undefined when the task ends. */
  nextInstruction(): Promise<string | undefined>;
}

export interface UserDeviceTaskResult {
  answer: string;
  summary?: string;
}

/** Runs one task on this computer. The cloud only sees what the task reports. */
export interface UserDeviceTaskRunner {
  run(task: LocalAgentTask, control: UserDeviceTaskControl): Promise<UserDeviceTaskResult>;
}

/** What this computer knows about the tasks it was given, so a request can ask. */
export interface UserDeviceTaskReader {
  status(taskId: string): TaskStatus | undefined;
}

export interface UserDeviceClientOptions {
  serverUrl: string;
  token: string;
  root: string;
  /** The server revoked the device or rejected its token. The client has already stopped. */
  onRevoked: () => void;
  /** Whether this computer lets the server's bots run anything. Asked before every request. */
  authorize: () => Promise<boolean>;
  /** Runs tasks the cloud sends. Without one the device reports that it cannot run them. */
  runTask?: UserDeviceTaskRunner;
  retryMs?: { min: number; max: number };
}

/** One task in flight on this computer. */
interface RunningTask {
  controller: AbortController;
  /** Instructions the cloud sent that the task has not read yet. */
  instructions: string[];
  /** Resolvers waiting for the next instruction. */
  waiting: ((text: string | undefined) => void)[];
  /** Resolvers waiting for the user's answer. */
  approvals: Map<
    string,
    { approvalId: string; resolve: (decision: ActionApprovalDecision) => void }
  >;
  finished: boolean;
  /** How many actions the task has reported. */
  steps: number;
}

/**
 * Connects outbound to a Rakazo server so its bots can use this computer. The server never
 * connects in. Runs only while started; `close` stops every command and the connection, and
 * `cancelAll` stops every command and refuses requests still waiting on `authorize`.
 */
export function startUserDeviceClient(options: UserDeviceClientOptions) {
  const retry = options.retryMs ?? { min: 1_000, max: 60_000 };
  /** Every task this computer ran, so a status request can answer for one. */
  const taskStatuses = new Map<string, TaskStatus>();
  const taskReader: UserDeviceTaskReader = {
    status(taskId) {
      const known = taskStatuses.get(taskId);
      return known ? { ...known } : undefined;
    },
  };
  const runner = createHostComputerRunner({ root: options.root, tasks: taskReader });
  runner.setEnabled(true);
  const url = new URL(USER_DEVICE_CONNECT_PATH, options.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let refuseWaiting: (() => void) | undefined;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnectTimer);
    runner.close();
    socket?.terminate();
  }

  function cancelAll() {
    if (stopped) return;
    refuseWaiting?.();
    runner.setEnabled(false);
    runner.setEnabled(true);
  }
  function revoked() {
    if (stopped) return;
    stop();
    options.onRevoked();
  }

  function scheduleReconnect() {
    if (stopped) return;
    // Full jitter keeps many devices from reconnecting in lockstep after a server restart.
    const ceiling = Math.min(retry.max, retry.min * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(connect, retry.min / 2 + Math.random() * ceiling);
    reconnectTimer.unref();
  }

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${options.token}` },
      maxPayload: USER_DEVICE_MAX_MESSAGE_BYTES,
      handshakeTimeout: 15_000,
      followRedirects: false,
      perMessageDeflate: false,
    });
    socket = ws;
    const calls = new Map<
      string,
      { call: HostComputerCall; cancelled: boolean; settled: boolean }
    >();
    const authorizing = new Set<string>();
    const runningTasks = new Map<string, RunningTask>();
    /** The result of a task that already ran, so a repeat does not run it again. */
    const completed = new Map<string, TaskEvent>();
    let alive = true;
    let openedAt = 0;
    let ping: NodeJS.Timeout | undefined;
    refuseWaiting = () => {
      for (const id of authorizing)
        void send(id, { error: NOT_ALLOWED_MESSAGE }).catch(() => undefined);
      authorizing.clear();
    };

    ws.on("unexpected-response", (request, response) => {
      request.destroy();
      ws.terminate();
      if (response.statusCode === 401) revoked();
    });
    ws.on("open", () => {
      openedAt = Date.now();
      // A silent network drop otherwise leaves the device looking connected for hours.
      ping = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
      ping.unref();
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", () => {
      /* "close" follows and reconnects. */
    });
    ws.on("close", () => {
      clearInterval(ping);
      // A lost response is never retried, so in-flight work stops with the connection.
      for (const { call } of calls.values()) call.abort();
      calls.clear();
      // A task that loses its connection cannot report anything, so it stops here.
      for (const task of runningTasks.values()) task.controller.abort();
      runningTasks.clear();
      if (socket === ws) {
        socket = undefined;
        refuseWaiting = undefined;
      }
      if (openedAt && Date.now() - openedAt >= PING_INTERVAL_MS) attempt = 0;
      scheduleReconnect();
    });
    ws.on("message", (data, isBinary) => {
      alive = true;
      if (isBinary) return;
      let message: ReturnType<typeof userDeviceServerMessage.parse>;
      try {
        const parsed = userDeviceServerMessage.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) return;
        message = parsed.data;
      } catch {
        return;
      }
      if (message.type === "revoked") {
        revoked();
        return;
      }
      if (message.type === "task") {
        void startTask(message.id, message.task);
        return;
      }
      if (message.type === "taskReply") {
        const task = runningTasks.get(message.id);
        if (task) deliverInstruction(task, message.text);
        return;
      }
      if (message.type === "taskCancel") {
        runningTasks.get(message.id)?.controller.abort();
        return;
      }
      if (message.type === "taskDecision") {
        runningTasks
          .get(message.id)
          ?.approvals.get(message.decision.approvalId)
          ?.resolve(message.decision);
        return;
      }
      if (message.type === "cancel") {
        authorizing.delete(message.id);
        const entry = calls.get(message.id);
        if (entry) {
          entry.cancelled = true;
          entry.call.abort();
        }
        return;
      }
      if (calls.has(message.id) || authorizing.has(message.id)) return;
      void handle(message.id, message.request);
    });

    function send(id: string, frame: HostComputerFrame<unknown>) {
      const entry = calls.get(id);
      let body = JSON.stringify({ type: "frame", id, frame } satisfies UserDeviceClientMessage);
      if (Buffer.byteLength(body) > USER_DEVICE_MAX_MESSAGE_BYTES) {
        frame = { error: "Local computer response is too large" };
        body = JSON.stringify({ type: "frame", id, frame } satisfies UserDeviceClientMessage);
        entry?.call.abort();
      }
      if (entry && ("done" in frame || "error" in frame)) entry.settled = true;
      return new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Local computer disconnected"));
          return;
        }
        ws.send(body, (error) => (error ? reject(error) : resolve()));
      });
    }

    async function handle(id: string, request: unknown) {
      authorizing.add(id);
      const allowed = await options.authorize().catch(() => false);
      if (!authorizing.delete(id) || socket !== ws) return;
      if (!allowed) {
        await send(id, { error: NOT_ALLOWED_MESSAGE }).catch(() => undefined);
        return;
      }
      const call = runner.begin();
      if (!call) {
        await send(id, { error: BUSY_MESSAGE }).catch(() => undefined);
        return;
      }
      const entry = { call, cancelled: false, settled: false };
      calls.set(id, entry);
      try {
        const outcome = await call.run(request, {
          open() {},
          write: (frame) => (call.signal.aborted ? undefined : send(id, frame)),
        });
        let refusal: string | undefined;
        if (outcome === "invalid") refusal = "Local computer request is invalid";
        else if (outcome === "busy") refusal = BUSY_MESSAGE;
        else if (outcome === "disabled" || call.signal.aborted)
          refusal = "Local computer operation stopped";
        if (refusal && !entry.cancelled && !entry.settled) await send(id, { error: refusal });
      } catch {
        /* The connection closed; the server fails the request. */
      } finally {
        call.end();
        if (calls.get(id) === entry) calls.delete(id);
      }
    }

    function sendTaskMessage(message: UserDeviceClientMessage) {
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > USER_DEVICE_MAX_MESSAGE_BYTES) {
        return Promise.reject(new Error("Local computer response is too large"));
      }
      return new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Local computer disconnected"));
          return;
        }
        ws.send(body, (error) => (error ? reject(error) : resolve()));
      });
    }

    /**
     * Runs one task. A task id that already ran replays its result instead of running
     * again, so a repeated dispatch never does the work twice.
     */
    async function startTask(id: string, task: LocalAgentTask) {
      const previous = completed.get(task.taskId);
      if (previous) {
        await sendTaskMessage({ type: "taskEvent", id, event: previous }).catch(() => undefined);
        return;
      }
      // The task is registered before anything is awaited, so a cancel that arrives while
      // the computer is still asking the user is not lost.
      const running: RunningTask = {
        controller: new AbortController(),
        instructions: [],
        waiting: [],
        approvals: new Map(),
        finished: false,
        steps: 0,
      };
      runningTasks.set(id, running);
      taskStatuses.set(task.taskId, { taskId: task.taskId, state: "running" });
      const control: UserDeviceTaskControl = {
        signal: running.controller.signal,
        event(event) {
          if (isTerminalTaskEvent(event)) {
            running.finished = true;
            completed.set(task.taskId, event);
            taskStatuses.set(task.taskId, statusFrom(task.taskId, event, running.steps));
          } else if (event.kind === "step") {
            running.steps += 1;
          }
          void sendTaskMessage({ type: "taskEvent", id, event }).catch(() => undefined);
        },
        async approve(request) {
          const answer = new Promise<ActionApprovalDecision>((resolve) => {
            running.approvals.set(request.approvalId, { approvalId: request.approvalId, resolve });
          });
          await sendTaskMessage({ type: "taskApproval", id, request }).catch(() => undefined);
          const decision = await Promise.race([
            answer,
            aborted(running.controller.signal).then(() => undefined),
          ]);
          running.approvals.delete(request.approvalId);
          // A cancelled task refuses rather than waits for an answer that will not come.
          return decision ?? { approvalId: request.approvalId, allowed: false };
        },
        nextInstruction() {
          const queued = running.instructions.shift();
          if (queued !== undefined) return Promise.resolve(queued);
          if (running.finished || running.controller.signal.aborted) {
            return Promise.resolve(undefined);
          }
          return new Promise((resolve) => running.waiting.push(resolve));
        },
      };
      try {
        const allowed = await options.authorize().catch(() => false);
        if (running.controller.signal.aborted) return;
        if (!allowed) {
          await sendTaskMessage({
            type: "taskEvent",
            id,
            event: { kind: "failed", at: new Date().toISOString(), error: NOT_ALLOWED_MESSAGE },
          }).catch(() => undefined);
          return;
        }
        const runner = options.runTask;
        if (!runner) {
          await sendTaskMessage({
            type: "taskEvent",
            id,
            event: { kind: "failed", at: new Date().toISOString(), error: NO_TASKS_MESSAGE },
          }).catch(() => undefined);
          return;
        }
        const result = await runner.run(task, control);
        const event: TaskEvent = {
          kind: "finished",
          at: new Date().toISOString(),
          answer: result.answer,
          ...(result.summary ? { summary: result.summary } : {}),
        };
        if (!running.finished) {
          running.finished = true;
          completed.set(task.taskId, event);
          taskStatuses.set(task.taskId, statusFrom(task.taskId, event, running.steps));
          await sendTaskMessage({ type: "taskEvent", id, event }).catch(() => undefined);
        }
      } catch (error) {
        const event: TaskEvent = {
          kind: "failed",
          at: new Date().toISOString(),
          error: error instanceof Error ? error.message : "The task failed",
        };
        if (!running.finished) {
          running.finished = true;
          completed.set(task.taskId, event);
          taskStatuses.set(task.taskId, statusFrom(task.taskId, event, running.steps));
          await sendTaskMessage({ type: "taskEvent", id, event }).catch(() => undefined);
        }
      } finally {
        // Nobody waits for an answer to a task that is over.
        for (const resolve of running.waiting.splice(0)) resolve(undefined);
        for (const pending of running.approvals.values()) {
          pending.resolve({ approvalId: pending.approvalId, allowed: false });
        }
        running.approvals.clear();
        if (runningTasks.get(id) === running) runningTasks.delete(id);
      }
    }
  }

  connect();
  return { close: stop, cancelAll };
}

/**
 * What a finished task looks like to a status request.
 *
 * The answer travels through the event the cloud already got; a status request from
 * another process has to be told the same thing again.
 */
function statusFrom(taskId: string, event: TaskEvent, steps: number): TaskStatus {
  if (event.kind === "finished") {
    return {
      taskId,
      state: "finished",
      answer: event.answer,
      ...(steps ? { steps } : {}),
    };
  }
  if (event.kind === "failed") {
    return { taskId, state: "failed", error: event.error, ...(steps ? { steps } : {}) };
  }
  return { taskId, state: "running", ...(steps ? { steps } : {}) };
}

/** Hands an instruction to a task, or to whoever is waiting for one. */
function deliverInstruction(task: RunningTask, text: string) {
  const waiting = task.waiting.shift();
  if (waiting) {
    waiting(text);
    return;
  }
  task.instructions.push(text);
}

/** Rejects when the task is cancelled, so a waiting approval does not hang. */
function aborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("The task was cancelled"));
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("The task was cancelled")),
      { once: true },
    );
  });
}

export type UserDeviceClient = ReturnType<typeof startUserDeviceClient>;
