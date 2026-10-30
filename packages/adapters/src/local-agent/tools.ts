import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ComputerAction, ComputerObservation } from "@rakazo/adapter-kit";
import { parseComputerActions } from "../computer-tools.js";
import { isAllowedDesktopPath } from "../desktop-sandbox-paths.js";
import type { HostScreen } from "../host-screen.js";
import type { GrantSubject, TaskGrant } from "./grant.js";
import { checkGrant } from "./grant.js";
import type { ActionApprovalDecision, ActionApprovalRequest } from "./grant-protocol.js";

/** Largest file the task may read or write in one go. */
const MAX_FILE_BYTES = 1024 * 1024;

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface LocalToolDeps {
  /** The screen of this computer. */
  screen: HostScreen;
  /** The folder the task works in. */
  home: string;
  /** The grant the task runs under. */
  grant: TaskGrant;
  /** Asks the user to approve one action. */
  approve: (request: ActionApprovalRequest) => Promise<ActionApprovalDecision>;
  /** Runs a shell command in the task's folder. */
  runShell: (command: string, cwd: string) => Promise<ShellResult>;
  /** The application in front, for the grant and for the approval card. */
  frontmostApp: () => Promise<string | undefined>;
  /** Action patterns the user already refused in this task. */
  deniedPatterns: Set<string>;
  signal: AbortSignal;
}

type Gate = { outcome: "allowed" } | { outcome: "refused"; reason: string };

/**
 * The tools the local agent has on this computer.
 *
 * Every action goes through the task grant first, and an action the grant does not
 * preapprove is put to the user with the action itself, not with the task as a whole.
 */
export function localAgentTools(deps: LocalToolDeps): AgentTool[] {
  return [
    {
      name: "computer_observe",
      label: "computer_observe",
      description:
        "Capture the current screen of this computer. Returns the frame and the window in front. Observe before any coordinate-based action, and again whenever something else may have changed the screen.",
      parameters: Type.Object({}),
      async execute() {
        const observation = await deps.screen.observe();
        return {
          content: observationContent(observation),
          details: {
            summary: "Looked at the screen",
            width: observation.width,
            height: observation.height,
            activeWindow: observation.activeWindow,
          },
        };
      },
    },
    {
      name: "computer_act",
      label: "computer_act",
      description:
        "Perform up to 24 ordered desktop actions and return the resulting screen. Action kinds: click, move, down, up, type, key, scroll, wait, focus, open, launch. Batch only predictable actions; stop before an outcome you need to inspect. Coordinates are pixels in the last frame you saw.",
      parameters: Type.Object({
        actions: Type.Array(
          Type.Object({
            kind: Type.String(),
            x: Type.Optional(Type.Number()),
            y: Type.Optional(Type.Number()),
            button: Type.Optional(Type.String()),
            text: Type.Optional(Type.String()),
            key: Type.Optional(Type.String()),
            modifiers: Type.Optional(Type.Array(Type.String())),
            direction: Type.Optional(Type.String()),
            amount: Type.Optional(Type.Number()),
            ms: Type.Optional(Type.Number()),
            application: Type.Optional(Type.String()),
            path: Type.Optional(Type.String()),
          }),
        ),
        observe: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        const raw = (params as { actions?: unknown }).actions;
        let actions: ComputerAction[];
        try {
          actions = parseComputerActions(raw);
        } catch (error) {
          return refused(error instanceof Error ? error.message : "Those actions are not valid");
        }
        const application = await deps.frontmostApp();
        for (const action of actions) {
          const request = approvalFor(action, application);
          if (!request) continue;
          const verdict = await gate(deps, subjectFor(action, application), request);
          if (verdict.outcome === "refused") return refused(verdict.reason);
        }
        const result = await deps.screen.act(actions, {
          observe: (params as { observe?: boolean }).observe !== false,
        });
        const observation = result.observation;
        return {
          content: observation
            ? observationContent(observation)
            : [{ type: "text", text: `Completed ${result.completed} actions.` }],
          details: {
            summary: application ? `Used the computer in ${application}` : "Used the computer",
            completed: result.completed,
          },
        };
      },
    },
    {
      name: "shell",
      label: "shell",
      description:
        "Run a shell command on this computer and return its output. Use it for work that does not need the screen. The command runs with your account's permissions.",
      parameters: Type.Object({
        command: Type.String(),
        cwd: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const command = String((params as { command?: unknown }).command ?? "").trim();
        if (!command) return refused("The command is empty");
        const folder = resolveInside(deps.home, String((params as { cwd?: unknown }).cwd ?? ""));
        if (!folder) return refused("That folder is outside the task's workspace");
        const verdict = await gate(
          deps,
          { kind: "shell", command },
          {
            at: new Date().toISOString(),
            action: "shell",
            summary: `Run a shell command`,
            detail: command,
          },
        );
        if (verdict.outcome === "refused") return refused(verdict.reason);
        const result = await deps.runShell(command, folder);
        return {
          content: [
            {
              type: "text",
              text: `Exit code ${result.code}\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.slice(
                0,
                20_000,
              ),
            },
          ],
          details: { summary: "Ran a shell command", code: result.code },
        };
      },
    },
    {
      name: "read_file",
      label: "read_file",
      description:
        "Read a file from this computer. Paths are relative to the task's workspace unless they are absolute.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) {
        const target = resolveInside(deps.home, String((params as { path?: unknown }).path ?? ""));
        if (!target) return refused("That path is outside the task's workspace");
        const verdict = await gate(
          deps,
          { kind: "read", path: target },
          {
            at: new Date().toISOString(),
            action: "read",
            summary: "Read a file",
            detail: target,
          },
        );
        if (verdict.outcome === "refused") return refused(verdict.reason);
        try {
          const info = await stat(target);
          if (!info.isFile()) return refused("That path is not a file");
          if (info.size > MAX_FILE_BYTES) return refused("That file is too large to read");
          const content = await readFile(target, "utf8");
          return {
            content: [{ type: "text", text: content }],
            details: { summary: "Read a file", bytes: info.size },
          };
        } catch {
          return refused("That file could not be read");
        }
      },
    },
    {
      name: "write_file",
      label: "write_file",
      description:
        "Write a file on this computer, replacing it when it already exists. Paths are relative to the task's workspace unless they are absolute.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_id, params) {
        const target = resolveInside(deps.home, String((params as { path?: unknown }).path ?? ""));
        if (!target) return refused("That path is outside the task's workspace");
        const content = String((params as { content?: unknown }).content ?? "");
        if (Buffer.byteLength(content) > MAX_FILE_BYTES)
          return refused("That file is too large to write");
        const verdict = await gate(
          deps,
          { kind: "write", path: target },
          {
            at: new Date().toISOString(),
            action: "write",
            summary: "Write a file",
            detail: target,
          },
        );
        if (verdict.outcome === "refused") return refused(verdict.reason);
        try {
          await writeFile(target, content, "utf8");
          return {
            content: [
              { type: "text", text: `Wrote ${Buffer.byteLength(content)} bytes to ${target}` },
            ],
            details: { summary: "Wrote a file", path: target },
          };
        } catch {
          return refused("That file could not be written");
        }
      },
    },
    {
      name: "list_files",
      label: "list_files",
      description:
        "List the files and folders in a folder on this computer. Paths are relative to the task's workspace unless they are absolute.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      async execute(_id, params) {
        const target = resolveInside(deps.home, String((params as { path?: unknown }).path ?? ""));
        if (!target) return refused("That path is outside the task's workspace");
        const verdict = await gate(
          deps,
          { kind: "read", path: target },
          {
            at: new Date().toISOString(),
            action: "list",
            summary: "List a folder",
            detail: target,
          },
        );
        if (verdict.outcome === "refused") return refused(verdict.reason);
        try {
          const entries = await readdir(target, { withFileTypes: true });
          const listing = entries
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort()
            .join("\n");
          return {
            content: [{ type: "text", text: listing || "(empty)" }],
            details: { summary: "Listed a folder", path: target, count: entries.length },
          };
        } catch {
          return refused("That folder could not be listed");
        }
      },
    },
    {
      name: "open_path",
      label: "open_path",
      description: "Open a file on this computer with the application that handles it.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) {
        const target = resolveInside(deps.home, String((params as { path?: unknown }).path ?? ""));
        if (!target) return refused("That path is outside the task's workspace");
        const verdict = await gate(
          deps,
          { kind: "open", path: target },
          {
            at: new Date().toISOString(),
            action: "open",
            summary: "Open a file",
            detail: target,
          },
        );
        if (verdict.outcome === "refused") return refused(verdict.reason);
        await deps.screen.act([{ kind: "open", path: target }], { observe: false });
        return {
          content: [{ type: "text", text: `Opened ${target}` }],
          details: { summary: "Opened a file", path: target },
        };
      },
    },
    {
      name: "launch_app",
      label: "launch_app",
      description: "Launch an application on this computer, or bring it to the front.",
      parameters: Type.Object({
        application: Type.String(),
        uri: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const application = String((params as { application?: unknown }).application ?? "").trim();
        if (!application) return refused("No application was named");
        const uri = (params as { uri?: unknown }).uri;
        const verdict = await gate(
          deps,
          { kind: "launch", application },
          {
            at: new Date().toISOString(),
            action: "launch",
            summary: `Launch ${application}`,
            detail: uri ? `${application} ${uri}` : application,
          },
        );
        if (verdict.outcome === "refused") return refused(verdict.reason);
        await deps.screen.act(
          [{ kind: "launch", application, ...(uri ? { uri: String(uri) } : {}) }],
          { observe: false },
        );
        return {
          content: [{ type: "text", text: `Launched ${application}` }],
          details: { summary: `Launched ${application}`, application },
        };
      },
    },
  ];
}

/**
 * Judges one action and, when the grant does not preapprove it, puts it to the user.
 *
 * A refusal is remembered for the rest of the task, so the same kind of action does not
 * come back for approval over and over.
 */
async function gate(
  deps: LocalToolDeps,
  subject: GrantSubject,
  request: Omit<ActionApprovalRequest, "approvalId">,
): Promise<Gate> {
  const decision = checkGrant(deps.grant, subject);
  if (decision.outcome === "allowed") return { outcome: "allowed" };
  if (decision.outcome === "denied") return { outcome: "refused", reason: decision.reason };
  const pattern = actionPattern(subject);
  if (deps.deniedPatterns.has(pattern)) {
    return {
      outcome: "refused",
      reason: "The user declined this kind of action earlier in this task.",
    };
  }
  const answer = await deps.approve({ ...request, approvalId: pattern });
  if (!answer.allowed) {
    deps.deniedPatterns.add(pattern);
    return { outcome: "refused", reason: answer.reason ?? "The user declined this action." };
  }
  return { outcome: "allowed" };
}

/** The shape of an action, so a refusal covers the same kind of action and not just one. */
export function actionPattern(subject: GrantSubject): string {
  switch (subject.kind) {
    case "pointer":
      return `click@${subject.app ?? "unknown"}`;
    case "scroll":
      return `scroll@${subject.app ?? "unknown"}`;
    case "type":
      return "type";
    case "key":
      return subject.modifiers?.length
        ? `key:${subject.modifiers.join("+")}`
        : `key:${subject.key}`;
    case "launch":
    case "focus":
      return `app:${subject.application}`;
    case "open":
    case "read":
    case "write":
      return `${subject.kind}:${subject.path}`;
    case "shell":
      return `shell:${subject.command.split(/\s+/)[0] ?? ""}`;
    case "network":
      return `network:${subject.host}`;
    case "observe":
      return "observe";
  }
}

function subjectFor(action: ComputerAction, application?: string): GrantSubject {
  switch (action.kind) {
    case "pointer":
      return { kind: "pointer", app: application };
    case "scroll":
      return { kind: "scroll", app: application };
    case "clipboard":
      return { kind: "type", app: application, text: action.text };
    case "key":
      return { kind: "key", app: application, key: action.key, modifiers: action.modifiers };
    case "open":
      return { kind: "open", path: action.path };
    case "launch":
      return { kind: "launch", application: action.application };
    case "focus":
      return { kind: "focus", application: action.application };
    case "wait":
      return { kind: "observe" };
  }
}

/** The approval card for one action. Waiting is not an action that needs one. */
function approvalFor(
  action: ComputerAction,
  application?: string,
): Omit<ActionApprovalRequest, "approvalId"> | undefined {
  const at = new Date().toISOString();
  switch (action.kind) {
    case "pointer":
      return {
        at,
        action: "click",
        summary: application
          ? `Click in ${application} at (${action.x}, ${action.y})`
          : `Click at (${action.x}, ${action.y})`,
        application,
      };
    case "scroll":
      return {
        at,
        action: "scroll",
        summary: application ? `Scroll in ${application}` : "Scroll on the screen",
        application,
      };
    case "clipboard":
      return {
        at,
        action: "type",
        summary: application ? `Type in ${application}` : "Type on the screen",
        application,
        // The user cannot judge a coordinate, so they see the text itself.
        detail: action.text,
      };
    case "key":
      return {
        at,
        action: "key",
        summary: application ? `Press a key in ${application}` : "Press a key",
        application,
        detail: [...(action.modifiers ?? []), action.key].join("+"),
      };
    case "open":
      return { at, action: "open", summary: `Open ${action.path}`, detail: action.path };
    case "launch":
      return { at, action: "launch", summary: `Launch ${action.application}` };
    case "focus":
      return { at, action: "focus", summary: `Bring ${action.application} to the front` };
    case "wait":
      return undefined;
  }
}

/** The text and the image the model gets back from a frame. */
function observationContent(observation: ComputerObservation) {
  const window = observation.activeWindow?.title;
  return [
    {
      type: "text" as const,
      text: `Screen ${observation.width}x${observation.height}${window ? `, ${window} in front` : ""}.`,
    },
    {
      type: "image" as const,
      data: Buffer.from(observation.image).toString("base64"),
      mimeType: observation.mimeType,
    },
  ];
}

function refused(reason: string) {
  return {
    content: [{ type: "text" as const, text: reason }],
    details: { refused: true },
    isError: true,
  };
}

/** Resolves a path inside the task's workspace, or nothing when it points outside. */
function resolveInside(home: string, target: string): string | undefined {
  const wanted = target.trim();
  const resolved = path.resolve(home, wanted || ".");
  if (!isAllowedDesktopPath(resolved, [home])) return undefined;
  return resolved;
}
