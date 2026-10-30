import { z } from "zod";

/**
 * Asking the user to approve one action.
 *
 * The device sends the request when an action is not preapproved, and waits for the
 * answer. The request carries the action itself, so the user can judge it rather than
 * approve a whole task on trust.
 */

export const actionApprovalRequestSchema = z.object({
  /** Identifies this request within the task. */
  approvalId: z.string().min(1).max(64),
  at: z.string().min(1).max(64),
  /** What the device wants to do: "click", "type", "shell", "write", ... */
  action: z.string().min(1).max(64),
  /** One line the user can read at a glance. */
  summary: z.string().min(1).max(2000),
  /** The application the action happens in. */
  application: z.string().max(256).optional(),
  /**
   * The detail the user cannot see otherwise: the text that would be typed, the command
   * that would run, the path that would be written.
   */
  detail: z.string().max(4000).optional(),
});
export type ActionApprovalRequest = z.infer<typeof actionApprovalRequestSchema>;

export const actionApprovalDecisionSchema = z.object({
  approvalId: z.string().min(1).max(64),
  allowed: z.boolean(),
  /** Why the user said no. Shown to the agent so it can try something else. */
  reason: z.string().max(500).optional(),
});
export type ActionApprovalDecision = z.infer<typeof actionApprovalDecisionSchema>;
