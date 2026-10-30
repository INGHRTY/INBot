import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import type { UserDeviceSummary } from "@rakazo/contracts";
import { USER_DEVICE_CONNECT_PATH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { HostComputerFrame, HostComputerRequest } from "./host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_BYTES,
  hostComputerDeadlineMs,
  hostComputerRequest,
} from "./host-computer-protocol.js";
import type {
  ActionApprovalDecision,
  ActionApprovalRequest,
} from "./local-agent/grant-protocol.js";
import { actionApprovalDecisionSchema } from "./local-agent/grant-protocol.js";
import type { LocalAgentTask, TaskEvent } from "./local-agent/task-protocol.js";
import { isTerminalTaskEvent, localAgentTaskSchema } from "./local-agent/task-protocol.js";
import type {
  UserDevice,
  UserDeviceGateway,
  UserDeviceTaskHandle,
  UserDeviceTaskUpdate,
} from "./user-device-protocol.js";
import { userDeviceClientMessage, userDeviceTaskUpdateSchema } from "./user-device-protocol.js";

/** Internal API endpoints other processes forward to. Not under /api, so the public proxy never routes them. */
export const USER_DEVICE_FORWARD_PATH = "/internal/user-devices/request";
export const USER_DEVICE_TASK_PATH = "/internal/user-devices/task";
export const USER_DEVICE_TASK_COMMAND_PATH = "/internal/user-devices/task-command";
export const USER_DEVICE_DISCONNECT_PATH = "/internal/user-devices/disconnect";
export const USER_DEVICE_OFFLINE_MESSAGE =
  "Your computer is not connected. Open the Rakazo desktop app.";
const DISCONNECTED_MESSAGE = "Your computer disconnected. Check the result before retrying.";
const REVOKED_MESSAGE = "This computer was disconnected from Rakazo.";
export const USER_DEVICE_LIMIT = 10;
const PING_INTERVAL_MS = 25_000;
/** A connection row older than this has lost its holding process. */
const STALE_AFTER_MS = 3 * PING_INTERVAL_MS;
const MAX_MESSAGE_BYTES = HOST_COMPUTER_MAX_BYTES + 64 * 1024;

export class UserDeviceOfflineError extends Error {
  constructor(message = USER_DEVICE_OFFLINE_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserDeviceOfflineError";
  }
}

export function createUserDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashUserDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function userDeviceBearer(header: string | null | undefined): string | null {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header ?? "");
  return match?.[1] ?? null;
}

/** API and worker share ENCRYPTION_KEY; forwarding uses a key derived from it for this purpose only. */
export function userDeviceForwardSecret(encryptionKey: string): string {
  return createHmac("sha256", encryptionKey).update("rakazo:user-device-forward:v1").digest("hex");
}

export function validUserDeviceForwardSecret(expected: string, header: string | null | undefined) {
  const supplied = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The base URL other processes reach this API process at; a bound wildcard host uses the first network address. */
export function userDeviceInternalAddress(host: string, port: number): string {
  let address = host;
  if (!host || host === "0.0.0.0" || host === "::") {
    const candidates = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry && !entry.internal);
    address =
      candidates.find((entry) => entry?.family === "IPv4")?.address ??
      candidates.find((entry) => entry?.family === "IPv6" && !entry.address.startsWith("fe80"))
        ?.address ??
      "127.0.0.1";
  }
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}

/** The subset of a `ws` socket the hub uses, so tests can pass a fake. */
export interface UserDeviceSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "pong", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface AuthenticatedDevice {
  id: string;
  userId: string;
  name: string;
  platform: string;
}

interface LiveDevice {
  device: AuthenticatedDevice;
  connectionId: string;
  socket: UserDeviceSocket;
  pending: Map<string, PendingQueue>;
  tasks: Map<string, DeviceTask>;
  alive: boolean;
}

export interface UserDeviceRoute {
  deviceId: string;
  userId: string;
  connectionId: string;
}

/**
 * Holds the live device sockets of one API process. Connections are recorded in the database
 * with this process's internal address so the worker and other API processes can forward.
 */
export class UserDeviceHub {
  readonly address: string;
  private readonly live = new Map<string, LiveDevice>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      address: string;
      pingIntervalMs?: number;
    },
  ) {
    this.address = deps.address;
    this.timer = setInterval(() => void this.heartbeat(), deps.pingIntervalMs ?? PING_INTERVAL_MS);
    this.timer.unref();
  }

  async authenticate(header: string | null | undefined): Promise<AuthenticatedDevice | null> {
    const token = userDeviceBearer(header);
    if (!token) return null;
    const hash = hashUserDeviceToken(token);
    const device = await runAsSystem("authenticate a user device", () =>
      this.deps.prisma.userDevice.findUnique({
        where: { tokenHash: hash },
        select: {
          id: true,
          userId: true,
          name: true,
          platform: true,
          tokenHash: true,
          revokedAt: true,
        },
      }),
    );
    // The lookup is by hash; compare again in constant time so a lookup quirk never authorizes.
    if (!device || device.revokedAt) return null;
    if (!timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(hash))) return null;
    return { id: device.id, userId: device.userId, name: device.name, platform: device.platform };
  }

  /** Node `upgrade` listener for the device socket path; every other upgrade is refused. */
  handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Until ws takes over the socket, a client reset (say during the token lookup) would
    // otherwise crash the process.
    const onError = (error: Error) =>
      getLogger().warn("user device upgrade socket error", { error });
    socket.on("error", onError);
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const path = new URL(request.url ?? "/", "http://device").pathname;
    if (path !== USER_DEVICE_CONNECT_PATH || this.closed) return reject(404, "Not Found");
    void this.authenticate(request.headers.authorization)
      .then((device) => {
        if (!device) return reject(401, "Unauthorized");
        socket.off("error", onError);
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          void this.attach(device, ws).catch((error) => {
            getLogger().error("user device attach failed", error);
            ws.close(1011, "Unavailable");
          });
        });
      })
      .catch((error) => {
        getLogger().error("user device upgrade failed", error);
        reject(500, "Internal Server Error");
      });
  };

  /** Registers a connected device socket; a newer socket for the same device replaces the older. */
  async attach(device: AuthenticatedDevice, socket: UserDeviceSocket): Promise<string> {
    const connectionId = randomUUID();
    const entry: LiveDevice = {
      device,
      connectionId,
      socket,
      pending: new Map(),
      tasks: new Map(),
      alive: true,
    };
    const previous = this.live.get(device.id);
    this.live.set(device.id, entry);
    if (previous) this.drop(previous, DISCONNECTED_MESSAGE, [4000, "Replaced"]);
    socket.on("pong", () => {
      entry.alive = true;
    });
    socket.on("message", (data) => this.receive(entry, data));
    // An oversized or malformed frame must close this device, never crash the process.
    socket.on("error", (error) => {
      getLogger().warn("user device socket error", { error });
      socket.terminate();
    });
    socket.on("close", () => {
      if (this.live.get(device.id) !== entry) return;
      this.drop(entry, DISCONNECTED_MESSAGE);
    });
    const now = new Date();
    await runAsSystem("record a user device connection", () =>
      this.deps.prisma.$transaction(async (tx) => {
        await tx.userDeviceConnection.upsert({
          where: { deviceId: device.id },
          create: {
            deviceId: device.id,
            connectionId,
            address: this.address,
            connectedAt: now,
            heartbeatAt: now,
          },
          update: { connectionId, address: this.address, connectedAt: now, heartbeatAt: now },
        });
        await tx.userDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } });
      }),
    );
    return connectionId;
  }

  holds(route: UserDeviceRoute): boolean {
    const entry = this.live.get(route.deviceId);
    return Boolean(
      entry && entry.connectionId === route.connectionId && entry.device.userId === route.userId,
    );
  }

  /** Raw HostComputerFrame values from the device for one request. */
  async *frames(
    route: UserDeviceRoute,
    request: HostComputerRequest,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    const entry = this.live.get(route.deviceId);
    if (!entry || !this.holds(route)) throw new UserDeviceOfflineError();
    signal.throwIfAborted();
    const id = randomUUID();
    const queue = new PendingQueue();
    entry.pending.set(id, queue);
    const abort = () => queue.fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let finished = false;
    try {
      entry.socket.send(JSON.stringify({ type: "request", id, request }));
      for await (const frame of queue) {
        if (isTerminal(frame)) finished = true;
        yield frame;
        if (finished) return;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      entry.pending.delete(id);
      // Aborted, timed out, or the consumer stopped early: tell the device to stop the work.
      if (!finished && !queue.lost && this.live.get(route.deviceId) === entry) {
        try {
          entry.socket.send(JSON.stringify({ type: "cancel", id }));
        } catch {
          // The socket is closing; its close handler fails the rest.
        }
      }
    }
  }

  /** NDJSON stream of frames for a forwarded request; a failure becomes an error frame. */
  stream(route: UserDeviceRoute, request: HostComputerRequest, signal: AbortSignal): Response {
    if (!this.holds(route)) return new Response(null, { status: 409 });
    const controller = new AbortController();
    const linked = AbortSignal.any([signal, controller.signal]);
    const iterator = this.frames(route, request, linked)[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const next = await iterator.next();
          if (next.done) stream.close();
          else stream.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch (error) {
          const message = error instanceof Error ? error.message : DISCONNECTED_MESSAGE;
          stream.enqueue(encoder.encode(`${JSON.stringify({ error: message })}\n`));
          stream.close();
        }
      },
      async cancel(reason) {
        controller.abort(reason);
        await iterator.return?.();
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  }

  /**
   * Starts a task on a device and returns a handle for what it reports.
   *
   * The task runs on the computer; the cloud only sends it and reads what comes back. No
   * frame ever crosses this channel.
   */
  startTask(
    route: UserDeviceRoute,
    id: string,
    task: LocalAgentTask,
    signal: AbortSignal,
  ): UserDeviceTaskHandle {
    const entry = this.live.get(route.deviceId);
    if (!entry || !this.holds(route)) throw new UserDeviceOfflineError();
    signal.throwIfAborted();
    const session = new DeviceTask(entry.socket, id, task);
    entry.tasks.set(id, session);
    // A task that outlives its caller stops on the device rather than running on alone.
    signal.addEventListener("abort", () => session.cancel(), { once: true });
    try {
      entry.socket.send(JSON.stringify({ type: "task", id, task }));
    } catch (error) {
      entry.tasks.delete(id);
      throw new UserDeviceOfflineError(undefined, { cause: error });
    }
    return {
      updates: (updateSignal) => session.updates(updateSignal),
      decide: (decision) => session.decide(decision),
      cancel: () => session.cancel(),
    };
  }

  /** NDJSON stream of what a task reports; used when another process asked for the task. */
  taskStream(
    route: UserDeviceRoute,
    id: string,
    task: LocalAgentTask,
    signal: AbortSignal,
  ): Response {
    if (!this.holds(route)) return new Response(null, { status: 409 });
    const controller = new AbortController();
    const linked = AbortSignal.any([signal, controller.signal]);
    const handle = this.startTask(route, id, task, linked);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          for await (const update of handle.updates(linked)) {
            stream.enqueue(encoder.encode(`${JSON.stringify({ id, update })}\n`));
          }
          stream.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : DISCONNECTED_MESSAGE;
          stream.enqueue(encoder.encode(`${JSON.stringify({ error: message })}\n`));
          stream.close();
        }
      },
      async cancel(reason) {
        controller.abort(reason);
        handle.cancel();
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  }

  /** Applies a command to a task that runs on a device this process holds. */
  taskCommand(route: UserDeviceRoute, id: string, command: UserDeviceTaskCommand): boolean {
    const entry = this.live.get(route.deviceId);
    if (!entry || !this.holds(route)) return false;
    const session = entry.tasks.get(id);
    if (!session) return false;
    if (command.type === "decision") session.decide(command.decision);
    else if (command.type === "reply") session.reply(command.text);
    else session.cancel();
    return true;
  }

  /** Closes this process's socket for a device and fails its in-flight requests. */
  disconnect(deviceId: string): void {
    const entry = this.live.get(deviceId);
    if (!entry) return;
    try {
      entry.socket.send(JSON.stringify({ type: "revoked" }));
    } catch {
      // Closing anyway.
    }
    this.drop(entry, REVOKED_MESSAGE, [4001, "Revoked"]);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    const entries = [...this.live.values()];
    for (const entry of entries)
      this.drop(entry, DISCONNECTED_MESSAGE, [1001, "Server restarting"]);
    this.wss.close();
    if (entries.length)
      await runAsSystem("forget user device connections", () =>
        this.deps.prisma.userDeviceConnection.deleteMany({
          where: { connectionId: { in: entries.map((entry) => entry.connectionId) } },
        }),
      ).catch(() => undefined);
  }

  private receive(entry: LiveDevice, data: unknown) {
    const text = String(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const message = userDeviceClientMessage.safeParse(parsed);
    if (!message.success) return;
    if (message.data.type === "frame") {
      entry.pending.get(message.data.id)?.push(message.data.frame, text.length);
      return;
    }
    const session = entry.tasks.get(message.data.id);
    if (!session) return;
    if (message.data.type === "taskEvent") {
      session.push({ kind: "event", event: message.data.event });
      if (isTerminalTaskEvent(message.data.event)) entry.tasks.delete(message.data.id);
      return;
    }
    session.push({ kind: "approval", request: message.data.request });
  }

  /** Forgets a connection and fails its requests; without a close code the socket is dead and is terminated. */
  private drop(entry: LiveDevice, message: string, close?: [code: number, reason: string]) {
    if (this.live.get(entry.device.id) === entry) this.live.delete(entry.device.id);
    for (const queue of entry.pending.values()) queue.fail(new Error(message), true);
    entry.pending.clear();
    for (const task of entry.tasks.values()) task.fail(new Error(message));
    entry.tasks.clear();
    try {
      if (close) entry.socket.close(...close);
      else entry.socket.terminate();
    } catch {
      entry.socket.terminate();
    }
    void runAsSystem("forget a user device connection", () =>
      this.deps.prisma.userDeviceConnection.deleteMany({
        where: { connectionId: entry.connectionId },
      }),
    ).catch((error) => getLogger().warn("user device connection cleanup failed", { error }));
  }

  private async heartbeat() {
    const entries = [...this.live.values()];
    for (const entry of entries) {
      if (!entry.alive) {
        this.drop(entry, DISCONNECTED_MESSAGE);
        continue;
      }
      entry.alive = false;
      try {
        entry.socket.ping();
      } catch {
        this.drop(entry, DISCONNECTED_MESSAGE);
      }
    }
    const live = [...this.live.values()];
    if (!live.length) return;
    try {
      const now = new Date();
      const revoked = await runAsSystem("refresh user device connections", () =>
        this.deps.prisma.$transaction(async (tx) => {
          await tx.userDeviceConnection.updateMany({
            where: { connectionId: { in: live.map((entry) => entry.connectionId) } },
            data: { heartbeatAt: now },
          });
          await tx.userDevice.updateMany({
            where: { id: { in: live.map((entry) => entry.device.id) } },
            data: { lastSeenAt: now },
          });
          return tx.userDevice.findMany({
            where: { id: { in: live.map((entry) => entry.device.id) }, revokedAt: { not: null } },
            select: { id: true },
          });
        }),
      );
      // A revoke whose direct disconnect did not reach this process still closes here.
      for (const device of revoked) this.disconnect(device.id);
    } catch (error) {
      getLogger().warn("user device heartbeat failed", { error });
    }
  }
}

/**
 * Reaches the requesting user's connected device from any API or worker process: directly when
 * this process holds the socket, otherwise over internal HTTP to the process that does.
 */
export class UserDevices implements UserDeviceGateway {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      /** userDeviceForwardSecret(ENCRYPTION_KEY). */
      forwardSecret: string;
      /** Present in API processes, which hold device sockets. */
      hub?: UserDeviceHub;
      fetch?: typeof fetch;
    },
  ) {
    this.fetch = deps.fetch ?? fetch;
  }

  async connected(userId: string): Promise<UserDevice | null> {
    const route = await this.route(userId);
    return route && { deviceId: route.deviceId, name: route.name, platform: route.platform };
  }

  /** The user's paired devices, newest first, each with its own live connection. */
  async list(userId: string): Promise<UserDeviceSummary[]> {
    const devices = await runAsSystem("list a user's devices", () =>
      this.deps.prisma.userDevice.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          connections: {
            where: { heartbeatAt: { gt: new Date(Date.now() - STALE_AFTER_MS) } },
            select: { deviceId: true },
          },
        },
      }),
    );
    return devices.map((device) => ({
      deviceId: device.id,
      name: device.name,
      connected: device.connections.length > 0,
    }));
  }

  async hasDevice(userId: string): Promise<boolean> {
    const device = await runAsSystem("find a user's paired device", () =>
      this.deps.prisma.userDevice.findFirst({
        where: { userId, revokedAt: null },
        select: { id: true },
      }),
    );
    return Boolean(device);
  }

  async *request<T>(
    userId: string,
    request: HostComputerRequest,
    signal: AbortSignal,
    deviceId?: string,
  ): AsyncIterable<T> {
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > HOST_COMPUTER_MAX_BYTES)
      throw new Error("Request to your computer is too large");
    const route = await this.route(userId, deviceId);
    if (!route) throw new UserDeviceOfflineError();
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(hostComputerDeadlineMs(request)),
    ]);
    const target = { deviceId: route.deviceId, userId, connectionId: route.connectionId };
    const frames = this.deps.hub?.holds(target)
      ? this.deps.hub.frames(target, request, deadline)
      : this.forward(route.address, target, request, deadline);
    yield* framesToValues<T>(frames, deadline);
  }

  /**
   * Starts a task on the user's computer.
   *
   * The device belongs to a person, not to a deployment, so this is resolved per user and
   * works from any API or worker process: when the socket lives elsewhere the task is
   * forwarded to the process that holds it.
   */
  async task(
    userId: string,
    task: LocalAgentTask,
    signal: AbortSignal,
    deviceId?: string,
  ): Promise<UserDeviceTaskHandle> {
    const route = await this.route(userId, deviceId);
    if (!route) throw new UserDeviceOfflineError();
    const id = randomUUID();
    const target = { deviceId: route.deviceId, userId, connectionId: route.connectionId };
    if (this.deps.hub?.holds(target)) {
      return this.deps.hub.startTask(target, id, task, signal);
    }
    return this.forwardTask(route.address, target, id, task, signal);
  }

  /** Closes the device's socket wherever it is held. Best effort; heartbeats close it otherwise. */
  async disconnect(deviceId: string): Promise<void> {
    this.deps.hub?.disconnect(deviceId);
    const connection = await runAsSystem("find a user device connection", () =>
      this.deps.prisma.userDeviceConnection.findUnique({ where: { deviceId } }),
    );
    if (!connection || connection.address === this.deps.hub?.address) return;
    await this.fetch(new URL(USER_DEVICE_DISCONNECT_PATH, connection.address), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.deps.forwardSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    })
      .then((response) => response.body?.cancel())
      .catch((error) => getLogger().warn("user device disconnect forward failed", { error }));
  }

  /** Runs a task on a device whose socket lives in another process. */
  private async forwardTask(
    address: string,
    target: UserDeviceRoute,
    id: string,
    task: LocalAgentTask,
    signal: AbortSignal,
  ): Promise<UserDeviceTaskHandle> {
    let response: Response;
    try {
      response = await this.fetch(new URL(USER_DEVICE_TASK_PATH, address), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.deps.forwardSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...target, id, task }),
        signal,
        redirect: "error",
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new UserDeviceOfflineError(undefined, { cause: error });
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new UserDeviceOfflineError();
    }
    const lines = ndjson(response.body, signal);
    return {
      updates: () => taskUpdates(lines),
      decide: (decision) => {
        void this.command(address, target, id, { type: "decision", decision });
      },
      cancel: () => {
        void this.command(address, target, id, { type: "cancel" });
      },
    };
  }

  /** Sends a command to the process that holds the device's socket. */
  private async command(
    address: string,
    target: UserDeviceRoute,
    id: string,
    command: UserDeviceTaskCommand,
  ): Promise<void> {
    await this.fetch(new URL(USER_DEVICE_TASK_COMMAND_PATH, address), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.deps.forwardSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...target, id, command }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
      .then((response) => response.body?.cancel())
      .catch((error) => getLogger().warn("user device task command forward failed", { error }));
  }

  private async route(userId: string, deviceId?: string) {
    const connection = await runAsSystem("find a user's connected device", () =>
      this.deps.prisma.userDeviceConnection.findFirst({
        where: {
          heartbeatAt: { gt: new Date(Date.now() - STALE_AFTER_MS) },
          device: { userId, revokedAt: null },
          ...(deviceId ? { deviceId } : {}),
        },
        orderBy: { connectedAt: "desc" },
        include: { device: { select: { name: true, platform: true } } },
      }),
    );
    if (!connection) return null;
    return {
      deviceId: connection.deviceId,
      connectionId: connection.connectionId,
      address: connection.address,
      name: connection.device.name,
      platform: connection.device.platform,
    };
  }

  private async *forward(
    address: string,
    route: UserDeviceRoute,
    request: HostComputerRequest,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    let response: Response;
    try {
      response = await this.fetch(new URL(USER_DEVICE_FORWARD_PATH, address), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.deps.forwardSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...route, request }),
        signal,
        redirect: "error",
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new UserDeviceOfflineError(undefined, { cause: error });
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new UserDeviceOfflineError();
    }
    yield* ndjson(response.body, signal);
  }
}

/** Body of a forwarded request; the forward secret authorizes it. */
export const userDeviceForwardBody = z.object({
  deviceId: z.string().min(1).max(64),
  userId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(64),
  request: hostComputerRequest,
});

/** What the cloud can tell a running task. */
export const userDeviceTaskCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("decision"), decision: actionApprovalDecisionSchema }),
  z.object({ type: z.literal("reply"), text: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal("cancel") }),
]);
export type UserDeviceTaskCommand = z.infer<typeof userDeviceTaskCommandSchema>;

/** Body of a task another process asks this one to run on its device. */
export const userDeviceTaskBody = z.object({
  deviceId: z.string().min(1).max(64),
  userId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(64),
  id: z.string().min(1).max(64),
  task: localAgentTaskSchema,
});

/** Body of a command for a task another process is running. */
export const userDeviceTaskCommandBody = z.object({
  deviceId: z.string().min(1).max(64),
  userId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(64),
  id: z.string().min(1).max(64),
  command: userDeviceTaskCommandSchema,
});

async function* framesToValues<T>(
  frames: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncIterable<T> {
  for await (const raw of frames) {
    signal.throwIfAborted();
    const frame = hostFrame<T>(raw);
    if (!frame) throw new Error("Your computer sent an invalid response");
    if ("error" in frame) throw new Error(frame.error);
    if ("heartbeat" in frame) continue;
    if ("done" in frame) return;
    yield frame.value;
  }
  signal.throwIfAborted();
  throw new Error(DISCONNECTED_MESSAGE);
}

function hostFrame<T>(value: unknown): HostComputerFrame<T> | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (typeof frame.error === "string") return { error: frame.error };
  if (frame.heartbeat === true) return { heartbeat: true };
  if (frame.done === true) return { done: true };
  if ("value" in frame) return { value: frame.value as T };
  return null;
}

function isTerminal(frame: unknown) {
  const parsed = hostFrame(frame);
  return !parsed || "error" in parsed || "done" in parsed;
}

/** Turns the forwarded task stream into the updates the cloud reads. */
async function* taskUpdates(lines: AsyncIterable<unknown>): AsyncIterable<UserDeviceTaskUpdate> {
  for await (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const record = line as { error?: unknown; update?: unknown };
    if (typeof record.error === "string") throw new Error(record.error);
    const update = userDeviceTaskUpdateSchema.safeParse(record.update);
    if (!update.success) continue;
    yield update.data;
  }
}

async function* ndjson(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        if (newline > MAX_MESSAGE_BYTES)
          throw new Error("Response from your computer is too large");
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        yield JSON.parse(line) as unknown;
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_MESSAGE_BYTES)
        throw new Error("Response from your computer is too large");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Buffers device frames for one request until its consumer reads them. */
class PendingQueue implements AsyncIterable<unknown> {
  private readonly items: Array<{ frame: unknown; size: number }> = [];
  private bytes = 0;
  private error: unknown;
  private failed = false;
  private ended = false;
  /** The connection went away, so there is no device to cancel on. */
  lost = false;
  private wake?: () => void;

  push(frame: unknown, size: number) {
    if (this.failed || this.ended) return;
    this.bytes += size;
    if (this.bytes > 2 * MAX_MESSAGE_BYTES) {
      this.fail(new Error("Response from your computer is too large"));
      return;
    }
    this.items.push({ frame, size });
    this.wake?.();
  }

  /** No more items will arrive; the consumer can finish. */
  end() {
    if (this.failed || this.ended) return;
    this.ended = true;
    this.wake?.();
  }

  fail(error: unknown, lost = false) {
    if (this.failed) return;
    this.failed = true;
    this.lost = lost;
    this.error = error;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.failed) throw this.error;
      const next = this.items.shift();
      if (next) {
        this.bytes -= next.size;
        yield next.frame;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * One task running on a device.
 *
 * The cloud reads what the device reports and answers the permission requests it raises.
 * Nothing about the screen leaves the computer.
 */
class DeviceTask {
  private readonly queue = new PendingQueue();
  private readonly approvals = new Map<string, ActionApprovalRequest>();

  constructor(
    private readonly socket: UserDeviceSocket,
    readonly id: string,
    readonly task: LocalAgentTask,
  ) {}

  push(update: UserDeviceTaskUpdate) {
    if (update.kind === "approval") this.approvals.set(update.request.approvalId, update.request);
    this.queue.push(update, JSON.stringify(update).length);
    // A task that finished has nothing more to say.
    if (update.kind === "event" && isTerminalTaskEvent(update.event)) this.queue.end();
  }

  /** The answer only reaches the device when it answers a request this task raised. */
  decide(decision: ActionApprovalDecision) {
    if (!this.approvals.has(decision.approvalId)) return;
    this.approvals.delete(decision.approvalId);
    this.send({ type: "taskDecision", id: this.id, decision });
  }

  reply(text: string) {
    this.send({ type: "taskReply", id: this.id, text });
  }

  cancel() {
    this.send({ type: "taskCancel", id: this.id });
  }

  fail(error: Error) {
    this.queue.fail(error, true);
  }

  updates(signal: AbortSignal): AsyncIterable<UserDeviceTaskUpdate> {
    const queue = this.queue;
    const abort = () => queue.fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    return (async function* () {
      try {
        for await (const update of queue) {
          signal.throwIfAborted();
          yield update as UserDeviceTaskUpdate;
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
    })();
  }

  private send(message: Record<string, unknown>) {
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // The socket is closing; its close handler fails the task.
    }
  }
}
