import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { UserDeviceClient, UserDeviceTaskRunner } from "./user-device-client.js";
import { startUserDeviceClient, USER_DEVICE_MAX_MESSAGE_BYTES } from "./user-device-client.js";

const token = "device-token";
const nodeEnv: Record<string, string> = process.versions.electron
  ? { ELECTRON_RUN_AS_NODE: "1" }
  : {};

interface Frame {
  type: string;
  id: string;
  frame: Record<string, unknown>;
}

describe("user device client", () => {
  let root: string;
  let http: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let serverUrl: string;
  let upgrades: IncomingMessage[];
  let reject401: boolean;
  let client: UserDeviceClient | undefined;
  let revoked: ReturnType<typeof vi.fn<() => void>>;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-device-test-")));
    upgrades = [];
    reject401 = false;
    revoked = vi.fn<() => void>();
    http = createServer();
    wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      upgrades.push(request);
      if (
        reject401 ||
        request.url !== USER_DEVICE_CONNECT_PATH ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        sockets.push(ws);
        wss.emit("connection", ws);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    client?.close();
    client = undefined;
    for (const ws of wss.clients) ws.terminate();
    sockets.length = 0;
    wss.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  function start(authorize: () => Promise<boolean> = async () => true) {
    client = startUserDeviceClient({
      serverUrl,
      token,
      root,
      onRevoked: revoked,
      authorize,
      retryMs: { min: 20, max: 40 },
    });
  }
  async function connection(index = 0) {
    while (sockets.length <= index) await once(wss, "connection");
    return sockets[index]!;
  }
  function frames(ws: WebSocket) {
    const received: Frame[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString())));
    return received;
  }
  async function until(check: () => boolean) {
    await vi.waitFor(() => expect(check()).toBe(true), { timeout: 10_000, interval: 10 });
  }

  it("authenticates outbound and streams request frames back by id", async () => {
    start();
    const ws = await connection();
    expect(upgrades[0]!.headers.origin).toBeUndefined();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "a", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => received.some((frame) => frame.id === "a" && "done" in frame.frame));
    ws.send(
      JSON.stringify({
        type: "request",
        id: "b",
        request: {
          method: "execute",
          botId: "bot",
          command: { env: nodeEnv, argv: [process.execPath, "-e", "process.stdout.write('hi')"] },
        },
      }),
    );
    await until(() => received.some((frame) => frame.id === "b" && "done" in frame.frame));
    const values = received
      .filter((frame) => frame.id === "b" && "value" in frame.frame)
      .map((frame) => frame.frame.value);
    expect(values).toContainEqual({ type: "stdout", data: "hi" });
    expect(values.at(-1)).toMatchObject({ type: "exit", code: 0 });
  });

  it("stops a cancelled command without answering for it, and keeps serving", async () => {
    start();
    const ws = await connection();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "p", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => received.some((frame) => frame.id === "p" && "done" in frame.frame));
    ws.send(
      JSON.stringify({
        type: "request",
        id: "long",
        request: {
          method: "execute",
          botId: "bot",
          command: {
            env: nodeEnv,
            argv: [process.execPath, "-e", "console.log('started'); setInterval(() => {}, 1000)"],
          },
        },
      }),
    );
    await until(() =>
      received.some(
        (frame) =>
          frame.id === "long" && (frame.frame.value as { type?: string })?.type === "stdout",
      ),
    );
    ws.send(JSON.stringify({ type: "cancel", id: "long" }));
    ws.send(
      JSON.stringify({
        type: "request",
        id: "env",
        request: { method: "environment", botId: "x" },
      }),
    );
    await until(() => received.some((frame) => frame.id === "env" && "done" in frame.frame));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      received.some(
        (frame) => frame.id === "long" && ("done" in frame.frame || "error" in frame.frame),
      ),
    ).toBe(false);
  });

  it("asks before every request and refuses what this computer does not allow", async () => {
    let answer: (allowed: boolean) => void = () => undefined;
    const authorize = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    start(authorize);
    const ws = await connection();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "a", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => authorize.mock.calls.length === 1);
    expect(received).toEqual([]);
    answer(false);
    await until(() => received.length === 1);
    expect(received[0]).toEqual({
      type: "frame",
      id: "a",
      frame: { error: "Not allowed on this computer" },
    });

    ws.send(
      JSON.stringify({ type: "request", id: "b", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => authorize.mock.calls.length === 2);
    ws.send(JSON.stringify({ type: "cancel", id: "b" }));
    answer(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.filter((frame) => frame.id === "b")).toEqual([]);
  });

  it("stops running commands and refuses waiting requests on cancelAll, and keeps serving", async () => {
    let answer: (allowed: boolean) => void = () => undefined;
    let ask = false;
    start(() =>
      ask ? new Promise<boolean>((resolve) => (answer = resolve)) : Promise.resolve(true),
    );
    const ws = await connection();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "p", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => received.some((frame) => frame.id === "p" && "done" in frame.frame));
    ws.send(
      JSON.stringify({
        type: "request",
        id: "long",
        request: {
          method: "execute",
          botId: "bot",
          command: {
            env: nodeEnv,
            argv: [process.execPath, "-e", "console.log('started'); setInterval(() => {}, 1000)"],
          },
        },
      }),
    );
    await until(() =>
      received.some(
        (frame) =>
          frame.id === "long" && (frame.frame.value as { type?: string })?.type === "stdout",
      ),
    );
    ask = true;
    ws.send(
      JSON.stringify({
        type: "request",
        id: "wait",
        request: { method: "provision", botId: "bot" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    client!.cancelAll();
    await until(() => received.some((frame) => frame.id === "long" && "error" in frame.frame));
    await until(() => received.some((frame) => frame.id === "wait"));
    expect(received.find((frame) => frame.id === "wait")?.frame).toEqual({
      error: "Not allowed on this computer",
    });
    answer(true);
    ask = false;
    ws.send(
      JSON.stringify({
        type: "request",
        id: "env",
        request: { method: "environment", botId: "x" },
      }),
    );
    await until(() => received.some((frame) => frame.id === "env" && "done" in frame.frame));
    expect(received.filter((frame) => frame.id === "wait")).toHaveLength(1);
  });

  it("ignores malformed messages and refuses oversized ones by reconnecting", async () => {
    start();
    const ws = await connection();
    const received = frames(ws);
    ws.send("not json");
    ws.send(JSON.stringify({ type: "request", id: "x", request: { method: "rm", botId: "b" } }));
    ws.send("x".repeat(USER_DEVICE_MAX_MESSAGE_BYTES + 1));
    await connection(1);
    expect(received).toEqual([]);
    expect(revoked).not.toHaveBeenCalled();
  });

  it("reconnects after the connection drops, until closed", async () => {
    start();
    (await connection()).terminate();
    const second = await connection(1);
    client!.close();
    await once(second, "close");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(upgrades).toHaveLength(2);
  });

  it("stops for good when the server revokes the device", async () => {
    start();
    const ws = await connection();
    ws.send(JSON.stringify({ type: "revoked" }));
    await once(ws, "close");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(upgrades).toHaveLength(1);
  });

  it("treats a rejected token as revoked", async () => {
    reject401 = true;
    start();
    await until(() => revoked.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(upgrades).toHaveLength(1);
  });

  it("keeps quiet commands alive with heartbeat frames", async () => {
    start();
    const ws = await connection();
    const received = frames(ws);
    ws.send(
      JSON.stringify({ type: "request", id: "p", request: { method: "provision", botId: "bot" } }),
    );
    await until(() => received.some((frame) => frame.id === "p" && "done" in frame.frame));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      ws.send(
        JSON.stringify({
          type: "request",
          id: "quiet",
          request: {
            method: "execute",
            botId: "bot",
            command: {
              env: nodeEnv,
              argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
            },
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await vi.advanceTimersByTimeAsync(30_000);
      await until(() =>
        received.some((frame) => frame.id === "quiet" && frame.frame.heartbeat === true),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

const localTask = {
  taskId: "task-1",
  prompt: "Open Safari",
  botId: "bot-1",
  grant: {
    preapproved: {},
    onDemand: "ask",
    denied: {},
    expiresAt: "2030-01-01T00:00:00.000Z",
  },
  model: { provider: "openai-compatible", id: "gpt" },
  budget: { maxSteps: 10, maxSeconds: 300 },
};

describe("device tasks", () => {
  let root: string;
  let http: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let serverUrl: string;
  let client: UserDeviceClient | undefined;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-device-task-test-")));
    http = createServer();
    wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        sockets.push(ws);
        wss.emit("connection", ws);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    client?.close();
    client = undefined;
    for (const ws of wss.clients) ws.terminate();
    sockets.length = 0;
    wss.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  function start(
    runTask: UserDeviceTaskRunner,
    onTask?: (task: { taskId: string; running: boolean }) => void,
  ) {
    client = startUserDeviceClient({
      serverUrl,
      token,
      root,
      onRevoked: () => undefined,
      authorize: async () => true,
      runTask,
      approvalTimeoutMs: 200,
      ...(onTask ? { onTask } : {}),
    });
  }
  async function connection() {
    while (!sockets.length) await once(wss, "connection");
    return sockets[0]!;
  }
  function messages(ws: WebSocket) {
    const received: Record<string, unknown>[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString())));
    return received;
  }
  async function until(check: () => boolean) {
    await vi.waitFor(() => expect(check()).toBe(true), { timeout: 10_000, interval: 10 });
  }

  it("runs a task and reports what happened", async () => {
    start({
      async run(_task, control) {
        control.event({ kind: "started", at: "2026-01-01T00:00:00.000Z" });
        control.event({
          kind: "step",
          at: "2026-01-01T00:00:00.000Z",
          index: 0,
          action: "click",
          summary: "Clicked the address bar",
        });
        return { answer: "Safari is open" };
      },
    });
    const ws = await connection();
    const received = messages(ws);
    ws.send(JSON.stringify({ type: "task", id: "t1", task: localTask }));
    await until(() =>
      received.some(
        (message) =>
          message.type === "taskEvent" && (message.event as { kind: string }).kind === "finished",
      ),
    );
    const events = received
      .filter((message) => message.type === "taskEvent")
      .map((message) => message.event as { kind: string; answer?: string });
    expect(events.map((event) => event.kind)).toEqual(["started", "step", "finished"]);
    expect(events.at(-1)?.answer).toBe("Safari is open");
  });

  it("asks the cloud before an action and waits for the answer", async () => {
    let answered = false;
    start({
      async run(_task, control) {
        const decision = await control.approve({
          approvalId: "a1",
          at: "2026-01-01T00:00:00.000Z",
          action: "type",
          summary: "Type a password",
          detail: "hunter2",
        });
        answered = decision.allowed;
        return { answer: decision.allowed ? "typed" : "refused" };
      },
    });
    const ws = await connection();
    const received = messages(ws);
    ws.send(JSON.stringify({ type: "task", id: "t1", task: localTask }));
    await until(() => received.some((message) => message.type === "taskApproval"));
    const request = received.find((message) => message.type === "taskApproval")!.request as {
      approvalId: string;
      detail: string;
    };
    expect(request.approvalId).toBe("a1");
    expect(request.detail).toBe("hunter2");
    ws.send(
      JSON.stringify({
        type: "taskDecision",
        id: "t1",
        decision: { approvalId: request.approvalId, allowed: true },
      }),
    );
    await until(() =>
      received.some(
        (message) =>
          message.type === "taskEvent" && (message.event as { kind: string }).kind === "finished",
      ),
    );
    expect(answered).toBe(true);
  });

  it("does not run the same task twice", async () => {
    let runs = 0;
    start({
      async run() {
        runs += 1;
        return { answer: "done" };
      },
    });
    const ws = await connection();
    const received = messages(ws);
    ws.send(JSON.stringify({ type: "task", id: "t1", task: localTask }));
    await until(() => received.filter((message) => message.type === "taskEvent").length >= 1);
    ws.send(JSON.stringify({ type: "task", id: "t2", task: localTask }));
    await until(() => received.filter((message) => message.type === "taskEvent").length >= 2);
    expect(runs).toBe(1);
    const answers = received
      .filter((message) => message.type === "taskEvent")
      .map((message) => (message.event as { answer?: string }).answer);
    expect(answers).toEqual(["done", "done"]);
  });

  it("stops a cancelled task", async () => {
    let stopped = false;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    start({
      async run(_task, control) {
        started();
        await new Promise<void>((resolve) => {
          control.signal.addEventListener("abort", () => {
            stopped = true;
            resolve();
          });
        });
        return { answer: "stopped" };
      },
    });
    const ws = await connection();
    ws.send(JSON.stringify({ type: "task", id: "t1", task: localTask }));
    await running;
    ws.send(JSON.stringify({ type: "taskCancel", id: "t1" }));
    await until(() => stopped);
  });

  it("stops waiting for an approval nobody answers", async () => {
    let answered: boolean | undefined;
    start({
      async run(_task, control) {
        const decision = await control.approve({
          approvalId: "a1",
          at: "2026-01-01T00:00:00.000Z",
          action: "click",
          summary: "Click in Safari",
        });
        answered = decision.allowed;
        return { answer: "done" };
      },
    });
    const ws = await connection();
    const received = messages(ws);
    ws.send(JSON.stringify({ type: "task", id: "t1", task: localTask }));
    await until(() => received.some((message) => message.type === "taskApproval"));
    await until(() => answered !== undefined);
    // A question nobody answered is a refusal, never a silent allow.
    expect(answered).toBe(false);
  });

  it("stops every running task on request and keeps the connection", async () => {
    let stopped = false;
    const seen: Array<{ taskId: string; running: boolean }> = [];
    start(
      {
        async run(_task, control) {
          await new Promise<void>((resolve) => {
            control.signal.addEventListener("abort", () => {
              stopped = true;
              resolve();
            });
          });
          return { answer: "stopped" };
        },
      },
      (task) => seen.push(task),
    );
    const ws = await connection();
    const received = messages(ws);
    ws.send(JSON.stringify({ type: "task", id: "t1", task: localTask }));
    await until(() => seen.length === 1);
    client!.stopTasks();
    await until(() => stopped);
    // The connection survives, so a request still gets an answer.
    ws.send(
      JSON.stringify({
        type: "request",
        id: "env",
        request: { method: "environment", botId: "x" },
      }),
    );
    await until(() => received.some((message) => message.type === "frame"));
    await until(() => seen.length === 2);
    expect(seen).toEqual([
      { taskId: "task-1", running: true },
      { taskId: "task-1", running: false },
    ]);
  });

  it("reports that it cannot run a task when no runner is set", async () => {
    client = startUserDeviceClient({
      serverUrl,
      token,
      root,
      onRevoked: () => undefined,
      authorize: async () => true,
    });
    const ws = await connection();
    const received = messages(ws);
    ws.send(JSON.stringify({ type: "task", id: "t1", task: localTask }));
    await until(() =>
      received.some(
        (message) =>
          message.type === "taskEvent" && (message.event as { kind: string }).kind === "failed",
      ),
    );
    const event = received.find((message) => message.type === "taskEvent")!.event as {
      error: string;
    };
    expect(event.error).toContain("cannot run tasks");
  });
});
