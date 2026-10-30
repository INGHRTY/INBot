import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { BoundDeviceModel } from "./model.js";
import type { LocalAgentTask, TaskEvent } from "./task-protocol.js";

export interface LocalAgentRun {
  /** The task to run. */
  task: LocalAgentTask;
  /** The tools the agent has on this computer. */
  tools: AgentTool[];
  /** The model the agent talks to. */
  model: BoundDeviceModel;
  /** The system prompt for this computer. */
  systemPrompt: string;
  /** Reports progress to the cloud. Never carries a frame, a coordinate, or typed text. */
  onEvent: (event: TaskEvent) => void;
  /** Stops the run when the task is cancelled. */
  signal: AbortSignal;
  /** Waits for the next instruction the cloud adds to this task, if any. */
  nextInstruction?: () => Promise<string | undefined>;
}

export interface LocalAgentResult {
  answer: string;
  summary?: string;
}

/**
 * Runs one task on this computer.
 *
 * The loop is deliberately small: it holds one model, one set of tools and one budget.
 * Everything else the server's runtime does — approvals, effects, memory, subagents —
 * either has no counterpart here or lives inside the tools.
 */
export async function runLocalAgent(run: LocalAgentRun): Promise<LocalAgentResult> {
  const { task } = run;
  const agent = new Agent({
    sessionId: `device:${task.taskId}`,
    // The cloud can add instructions, but never steers a turn that is already running.
    steeringMode: "one-at-a-time",
    initialState: {
      systemPrompt: run.systemPrompt,
      tools: run.tools,
      model: run.model.model,
    },
    streamFn: (model, context, options) =>
      run.model.models.stream(model, context, {
        ...options,
        // The key is this computer's own; it is never written to a log or a result.
        ...(run.model.apiKey ? { apiKey: run.model.apiKey } : {}),
      }),
    getApiKey: async () => run.model.apiKey,
  });

  let steps = 0;
  // A budget stop is not a failure: the run ends with whatever the agent managed to do.
  let stopped: "budget" | "deadline" | "cancelled" | undefined;
  agent.subscribe(async (event) => {
    if (event.type === "tool_execution_start") {
      steps += 1;
      if (steps > task.budget.maxSteps) {
        stopped = "budget";
        agent.abort();
      }
      return;
    }
    if (event.type !== "tool_execution_end") return;
    const at = new Date().toISOString();
    if (event.isError) {
      run.onEvent({
        kind: "blocked",
        at,
        reason: safeSummary(event.result) ?? "The action did not run",
      });
      return;
    }
    run.onEvent({
      kind: "step",
      at,
      index: Math.max(steps - 1, 0),
      action: event.toolName,
      summary: safeSummary(event.result) ?? event.toolName,
    });
  });

  // A person can add an instruction while the task runs. It joins the conversation as
  // their own words, and never steers a turn that is already in flight.
  const instructions = run.nextInstruction
    ? (async () => {
        for (
          let text = await run.nextInstruction!();
          text !== undefined && !stopped;
          text = await run.nextInstruction!()
        ) {
          if (!text.trim()) continue;
          agent.steer({ role: "user", content: text, timestamp: Date.now() });
        }
      })()
    : undefined;
  instructions?.catch(() => undefined);

  const deadline = setTimeout(() => {
    stopped ??= "deadline";
    agent.abort();
  }, task.budget.maxSeconds * 1000);
  deadline.unref?.();
  const onAbort = () => {
    stopped ??= "cancelled";
    agent.abort();
  };
  run.signal.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt(task.prompt);
  } finally {
    clearTimeout(deadline);
    run.signal.removeEventListener("abort", onAbort);
    await agent.waitForIdle().catch(() => undefined);
  }

  if (stopped === "cancelled") throw new Error("The task was cancelled");
  const failure = agent.state.errorMessage;
  if (failure && stopped === undefined) throw new Error(failure);
  const answer = lastAssistantText(agent.state.messages);
  return { answer };
}

/**
 * The one line the cloud learns about an action.
 *
 * It comes from the tool, which knows what it did and what is safe to say. It never
 * carries a coordinate, a typed text, a command, or a frame.
 */
function safeSummary(result: unknown): string | undefined {
  const details = (result as { details?: { summary?: unknown } } | undefined)?.details;
  const summary = details?.summary;
  return typeof summary === "string" && summary.length > 0 ? summary : undefined;
}

function lastAssistantText(messages: readonly { role: string; content: unknown }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = contentText(message.content as never);
    if (text.trim()) return text.trim();
  }
  return "";
}
