import { z } from "zod";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { hostComputerRequest } from "./host-computer-protocol.js";
import type {
  ActionApprovalDecision,
  ActionApprovalRequest,
} from "./local-agent/grant-protocol.js";
import {
  actionApprovalDecisionSchema,
  actionApprovalRequestSchema,
} from "./local-agent/grant-protocol.js";
import type { LocalAgentTask, TaskEvent } from "./local-agent/task-protocol.js";
import { localAgentTaskSchema, taskEventSchema } from "./local-agent/task-protocol.js";

/**
 * The messages between the cloud and a computer.
 *
 * A computer that predates the task messages ignores them: the union below has no branch
 * for them, so the message fails to parse and the receiver drops it. The same holds in the
 * other direction, so a new computer can talk to a server that has not caught up.
 */

export const userDeviceServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request"),
    id: z.string().min(1).max(64),
    request: hostComputerRequest,
  }),
  z.object({ type: z.literal("cancel"), id: z.string().min(1).max(64) }),
  z.object({ type: z.literal("revoked") }),
  /** Starts a task on the computer. */
  z.object({
    type: z.literal("task"),
    id: z.string().min(1).max(64),
    task: localAgentTaskSchema,
  }),
  /** Adds an instruction to a running task. */
  z.object({
    type: z.literal("taskReply"),
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(20_000),
  }),
  /** Stops a running task. */
  z.object({ type: z.literal("taskCancel"), id: z.string().min(1).max(64) }),
  /** Answers a permission request the computer raised. */
  z.object({
    type: z.literal("taskDecision"),
    id: z.string().min(1).max(64),
    decision: actionApprovalDecisionSchema,
  }),
]);
export type UserDeviceServerMessage = z.infer<typeof userDeviceServerMessage>;

/** One HostComputerFrame per message, tagged with the request id. */
export const userDeviceClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame"), id: z.string().min(1).max(64), frame: z.unknown() }),
  /** Progress or the result of a task. */
  z.object({
    type: z.literal("taskEvent"),
    id: z.string().min(1).max(64),
    event: taskEventSchema,
  }),
  /** A task that needs the user's permission before it goes on. */
  z.object({
    type: z.literal("taskApproval"),
    id: z.string().min(1).max(64),
    request: actionApprovalRequestSchema,
  }),
]);
export type UserDeviceClientMessage = z.infer<typeof userDeviceClientMessage>;

export interface UserDevice {
  deviceId: string;
  name: string;
  platform: string;
}

/** What a running task reports back to the cloud. */
export const userDeviceTaskUpdateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), event: taskEventSchema }),
  z.object({ kind: z.literal("approval"), request: actionApprovalRequestSchema }),
]);
export type UserDeviceTaskUpdate = z.infer<typeof userDeviceTaskUpdateSchema>;

/** A running task on one computer. */
export interface UserDeviceTaskHandle {
  /** What the computer reports, until the task ends or the session is closed. */
  updates(signal: AbortSignal): AsyncIterable<UserDeviceTaskUpdate>;
  /** Answers a permission request. */
  decide(decision: ActionApprovalDecision): void;
  /** Stops the task on the computer. */
  cancel(): void;
}

/** How runs reach the requesting user's connected device, from any API or worker process. */
export interface UserDeviceGateway {
  connected(userId: string): Promise<UserDevice | null>;
  /** Paired and not revoked, connected or not. */
  hasDevice(userId: string): Promise<boolean>;
  /**
   * Streams HostComputerFrame values for one request. Throws when the device is offline,
   * revoked, or disconnects mid-request; a command is never retried after a lost response.
   * Pass `deviceId` to keep every request of one operation on the same computer.
   */
  request<T>(
    userId: string,
    request: HostComputerRequest,
    signal: AbortSignal,
    deviceId?: string,
  ): AsyncIterable<T>;
  /**
   * Starts a task on the user's computer. Throws when the device is offline or revoked.
   */
  task(
    userId: string,
    task: LocalAgentTask,
    signal: AbortSignal,
    deviceId?: string,
  ): Promise<UserDeviceTaskHandle>;
}
