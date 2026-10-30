import type { HostScreen } from "../host-screen.js";
import type { UserDeviceTaskControl, UserDeviceTaskRunner } from "../user-device-client.js";
import { runLocalAgent } from "./loop.js";
import type { DeviceModelConnection } from "./model.js";
import { bindDeviceModel } from "./model.js";
import { localAgentSystemPrompt } from "./system-prompt.js";
import type { ShellResult } from "./tools.js";
import { localAgentTools } from "./tools.js";

export interface LocalAgentRunnerDeps {
  /** The screen of this computer. */
  screen: HostScreen;
  /** The folder the task works in. */
  home: string;
  /** Reads a model connection stored on this computer, keychain included. */
  connection: (reference: string) => Promise<DeviceModelConnection>;
  /** The connection to use when the task names none: the one this computer defaults to. */
  defaultConnection?: () => Promise<string | undefined>;
  /** Runs a shell command in the task's folder. */
  runShell: (command: string, cwd: string) => Promise<ShellResult>;
}

/**
 * Runs the tasks the cloud sends to this computer.
 *
 * The model connection, the key and the grant all stay here: the cloud sends a task, and
 * this computer decides what it may do with it. Asking the user to approve an action
 * goes back through the cloud, which owns the approval card.
 */
export function createLocalAgentRunner(deps: LocalAgentRunnerDeps): UserDeviceTaskRunner {
  return {
    async run(task, control: UserDeviceTaskControl) {
      const reference = task.model?.connectionRef ?? (await deps.defaultConnection?.());
      if (!reference) throw new Error("This computer has no model connection to run the task");
      const connection = await deps.connection(reference);
      const model = bindDeviceModel(connection);
      const deniedPatterns = new Set<string>();
      const tools = localAgentTools({
        screen: deps.screen,
        home: deps.home,
        grant: task.grant,
        approve: (request) => control.approve(request),
        runShell: deps.runShell,
        frontmostApp: async () => (await deps.screen.frontmost())?.title,
        deniedPatterns,
        signal: control.signal,
      });
      const result = await runLocalAgent({
        task,
        tools,
        model,
        systemPrompt: localAgentSystemPrompt(),
        onEvent: (event) => control.event(event),
        signal: control.signal,
        nextInstruction: () => control.nextInstruction(),
      });
      return { answer: result.answer, ...(result.summary ? { summary: result.summary } : {}) };
    },
  };
}

export { type LocalAgentResult, type LocalAgentRun, runLocalAgent } from "./loop.js";
export { bindDeviceModel, type DeviceModelConnection } from "./model.js";
export { runTaskShell } from "./shell.js";
export { LOCAL_AGENT_SYSTEM_PROMPT, localAgentSystemPrompt } from "./system-prompt.js";
export { actionPattern, type LocalToolDeps, localAgentTools, type ShellResult } from "./tools.js";
