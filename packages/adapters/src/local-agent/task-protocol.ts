import { z } from "zod";
import { taskGrantSchema } from "./grant.js";

/**
 * A task the cloud sends to a computer, and the events it sends back.
 *
 * The task carries the grant it must run under, so the device can enforce it without
 * asking the cloud about every action. The events carry summaries, never frames: the
 * screen stays on the computer.
 */

export const localAgentTaskSchema = z.object({
  /** Identifies the task. The device never runs the same task id twice. */
  taskId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(20_000),
  /** The bot the task belongs to, for auditing and for memory. */
  botId: z.string().min(1).max(256),
  grant: taskGrantSchema,
  model: z.object({
    provider: z.string().min(1).max(64),
    id: z.string().min(1).max(256),
    /** Names a model connection stored on the computer. Never carries the key itself. */
    connectionRef: z.string().min(1).max(128).optional(),
  }),
  budget: z.object({
    maxSteps: z.number().int().positive().max(200),
    maxSeconds: z.number().int().positive().max(86_400),
    maxTokens: z.number().int().positive().max(10_000_000).optional(),
  }),
  context: z
    .object({
      /** Memory documents to read from this computer. */
      memoryPaths: z.array(z.string().min(1).max(4096)).max(32).optional(),
      /** Files on this computer the task may read. */
      attachments: z
        .array(z.object({ name: z.string().min(1).max(256), path: z.string().min(1).max(4096) }))
        .max(32)
        .optional(),
    })
    .optional(),
});
export type LocalAgentTask = z.infer<typeof localAgentTaskSchema>;

export const taskEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), at: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal("step"),
    at: z.string().min(1).max(64),
    index: z.number().int().nonnegative(),
    /** What the device did, in a few words. */
    action: z.string().min(1).max(64),
    /** A short description. Never coordinates, never typed text, never a frame. */
    summary: z.string().max(2000),
  }),
  z.object({
    kind: z.literal("blocked"),
    at: z.string().min(1).max(64),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("progress"),
    at: z.string().min(1).max(64),
    message: z.string().max(2000),
  }),
  z.object({
    kind: z.literal("finished"),
    at: z.string().min(1).max(64),
    answer: z.string().max(20_000),
    summary: z.string().max(2000).optional(),
  }),
  z.object({
    kind: z.literal("failed"),
    at: z.string().min(1).max(64),
    error: z.string().min(1).max(2000),
  }),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;

/** The events that end a task. */
export function isTerminalTaskEvent(event: TaskEvent): boolean {
  return event.kind === "finished" || event.kind === "failed";
}

/**
 * What a computer says about a task it was given.
 *
 * The cloud polls a task from another process than the one holding the socket, so it
 * cannot read the live session. It asks the computer instead, which remembers how the
 * task ended.
 */
export const taskStatusSchema = z.object({
  taskId: z.string().min(1).max(128),
  state: z.enum(["running", "finished", "failed", "unknown"]),
  /** The answer of a finished task. */
  answer: z.string().max(20_000).optional(),
  /** Why a failed task failed. */
  error: z.string().max(2000).optional(),
  /** The last few things the task did, as the computer already reported them. */
  steps: z.number().int().nonnegative().max(200).optional(),
  /**
   * The action the task is waiting for the person to approve. Present only while a
   * task is stopped at an action it may not take alone.
   */
  awaitingApproval: z
    .object({
      action: z.string().min(1).max(64),
      summary: z.string().min(1).max(2000),
      detail: z.string().max(4000).optional(),
    })
    .optional(),
});
export type TaskStatus = z.infer<typeof taskStatusSchema>;
