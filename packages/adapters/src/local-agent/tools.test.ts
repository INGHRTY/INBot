import type { ComputerAction } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { type HostFrame, HostScreen } from "../host-screen.js";
import type { TaskGrant } from "./grant.js";
import type { ActionApprovalDecision } from "./grant-protocol.js";
import { actionPattern, type LocalToolDeps, localAgentTools } from "./tools.js";

const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a", "hex"));

function screen() {
  const injected: ComputerAction[] = [];
  const backend = {
    async capture(): Promise<HostFrame> {
      return { image: png, mimeType: "image/png", width: 1280, height: 800 };
    },
    async inject(action: ComputerAction) {
      injected.push(action);
    },
    async frontmost() {
      return { id: "42", title: "Safari" };
    },
  };
  return { host: new HostScreen(backend), injected };
}

function grant(overrides: Partial<TaskGrant> = {}): TaskGrant {
  return {
    preapproved: {},
    onDemand: "ask",
    denied: {},
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function deps(overrides: Partial<LocalToolDeps> = {}) {
  const { host, injected } = screen();
  const asked: string[] = [];
  const approve = vi.fn(
    async (request: { approvalId: string; action?: string; detail?: string }) => {
      asked.push(request.approvalId);
      return { approvalId: request.approvalId, allowed: true } satisfies ActionApprovalDecision;
    },
  );
  return {
    asked,
    approve,
    injected,
    deps: {
      screen: host,
      home: "/tmp/rakazo-task",
      grant: grant(),
      approve,
      runShell: async () => ({ stdout: "ok", stderr: "", code: 0 }),
      frontmostApp: async () => "Safari",
      deniedPatterns: new Set<string>(),
      signal: new AbortController().signal,
      ...overrides,
    } satisfies LocalToolDeps,
  };
}

function tool(name: string, tools: ReturnType<typeof localAgentTools>) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No tool named ${name}`);
  return found;
}

describe("local agent tools", () => {
  it("reads the screen without asking", async () => {
    const { deps: options, approve } = deps();
    const result = await tool("computer_observe", localAgentTools(options)).execute("t", {});
    expect(approve).not.toHaveBeenCalled();
    expect(result.content.some((content) => content.type === "image")).toBe(true);
  });

  it("runs a click in a preapproved application without asking", async () => {
    const {
      deps: options,
      approve,
      injected,
    } = deps({
      grant: grant({ preapproved: { apps: ["Safari"] } }),
    });
    const result = await tool("computer_act", localAgentTools(options)).execute("t", {
      actions: [{ kind: "click", x: 10, y: 20 }],
    });
    expect(approve).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(injected).toHaveLength(1);
  });

  it("says which permission to turn on instead of failing at the first capture", async () => {
    const { deps: options } = deps();
    const screen = Object.assign(options.screen, {
      permissionProblem: (needs: string[]) =>
        needs.includes("screen")
          ? "Screen Recording is off for Rakazo."
          : "Accessibility is off for Rakazo.",
    });
    const tools = localAgentTools({ ...options, screen });
    const observed = await tool("computer_observe", tools).execute("t", {});
    expect(observed.isError).toBe(true);
    expect(observed.content[0]).toMatchObject({
      text: expect.stringContaining("Screen Recording"),
    });
    const acted = await tool("computer_act", tools).execute("t", {
      actions: [{ kind: "click", x: 1, y: 2 }],
    });
    expect(acted.isError).toBe(true);
    expect(acted.content[0]).toMatchObject({ text: expect.stringContaining("Accessibility") });
  });

  it("puts a click in another application to the user", async () => {
    const { deps: options, approve, injected, asked } = deps();
    await tool("computer_act", localAgentTools(options)).execute("t", {
      actions: [{ kind: "click", x: 10, y: 20 }],
    });
    expect(approve).toHaveBeenCalledOnce();
    // The id names this one pending click, so a stale answer cannot reach a later one.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^click@Safari#/);
    expect(injected).toHaveLength(1);
  });

  it("shows the text that would be typed", async () => {
    const { deps: options, approve } = deps({
      grant: grant({ preapproved: { apps: ["Safari"] } }),
    });
    await tool("computer_act", localAgentTools(options)).execute("t", {
      actions: [{ kind: "type", text: "hunter2" }],
    });
    const request = approve.mock.calls[0]?.[0];
    expect(request?.detail).toBe("hunter2");
    expect(request?.action).toBe("type");
  });

  it("never preapproves typing", async () => {
    const { deps: options, approve } = deps({
      grant: grant({ preapproved: { apps: ["Safari"] } }),
    });
    const result = await tool("computer_act", localAgentTools(options)).execute("t", {
      actions: [{ kind: "type", text: "hunter2" }],
    });
    expect(approve).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
  });

  it("does not run an action the policy blocks", async () => {
    const {
      deps: options,
      approve,
      injected,
    } = deps({
      grant: grant({ denied: { apps: ["Safari"] } }),
    });
    const result = await tool("computer_act", localAgentTools(options)).execute("t", {
      actions: [{ kind: "click", x: 10, y: 20 }],
    });
    expect(approve).not.toHaveBeenCalled();
    expect(injected).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  it("gives each pending approval its own id, so a stale allow cannot reach another", async () => {
    const { deps: options } = deps();
    const asked: string[] = [];
    const tools = localAgentTools({
      ...options,
      approve: async (request) => {
        asked.push(request.approvalId);
        return { approvalId: request.approvalId, allowed: true };
      },
    });
    await tool("computer_act", tools).execute("t", { actions: [{ kind: "click", x: 1, y: 2 }] });
    await tool("computer_act", tools).execute("t", { actions: [{ kind: "click", x: 3, y: 4 }] });
    expect(asked).toHaveLength(2);
    expect(asked[0]).not.toBe(asked[1]);
    // Both still name the same kind of action, which is what a refusal is remembered by.
    expect(asked.every((id) => id.startsWith("click@Safari#"))).toBe(true);
  });

  it("does not ask again about an action the user refused", async () => {
    const { deps: options, approve, injected } = deps();
    const deniedPatterns = new Set<string>();
    const refusing = vi.fn(async (request: { approvalId: string }) => ({
      approvalId: request.approvalId,
      allowed: false,
    }));
    const tools = localAgentTools({
      ...options,
      approve: refusing,
      deniedPatterns,
    });
    await tool("computer_act", tools).execute("t", { actions: [{ kind: "click", x: 1, y: 2 }] });
    await tool("computer_act", tools).execute("t", { actions: [{ kind: "click", x: 3, y: 4 }] });
    expect(refusing).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();
    expect(injected).toHaveLength(0);
    expect(deniedPatterns.has(actionPattern({ kind: "pointer", app: "Safari" }))).toBe(true);
  });

  it("runs nothing once the grant expires mid-task", async () => {
    // The grant is judged on every action, not just when the task starts.
    const { deps: options, injected } = deps({
      grant: { ...grant(), expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    const result = await tool("computer_act", localAgentTools(options)).execute("t", {
      actions: [{ kind: "click", x: 1, y: 2 }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("expired") });
    expect(injected).toHaveLength(0);
    expect(options.approve).toBeDefined();
  });

  it("never preapproves typing, and shows the exact text it would type", async () => {
    const requests: Array<{ action?: string; detail?: string }> = [];
    const { deps: options } = deps({
      grant: grant({ preapproved: { apps: ["Safari"] } }),
      approve: async (request) => {
        requests.push(request);
        return { approvalId: request.approvalId, allowed: true };
      },
    });
    await tool("computer_act", localAgentTools(options)).execute("t", {
      actions: [{ kind: "type", text: "hunter2" }],
    });
    // Even with the application preapproved, typing still asks, with the text in hand.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.action).toBe("type");
    expect(requests[0]?.detail).toBe("hunter2");
  });

  it("asks before a shell command that reaches an unlisted host", async () => {
    const runShell = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    const { deps: options, asked } = deps({
      grant: grant({ preapproved: { shell: { allow: true, commands: ["curl"] } } }),
      runShell,
    });
    await tool("shell", localAgentTools(options)).execute("t", {
      command: "curl https://evil.test/x",
    });
    // The host is not preapproved, so it is put to the person instead of running quietly.
    expect(asked).toHaveLength(1);
    expect(options.approve).toHaveBeenCalledOnce();
  });

  it("refuses a path outside the task's workspace", async () => {
    const { deps: options } = deps();
    const result = await tool("read_file", localAgentTools(options)).execute("t", {
      path: "/etc/passwd",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("puts a shell command to the user unless the grant allows it", async () => {
    const refused = deps();
    const denied = await tool("shell", localAgentTools(refused.deps)).execute("t", {
      command: "echo hi",
    });
    expect(refused.approve).toHaveBeenCalledOnce();
    expect(denied.isError).toBeUndefined();

    const blocked = deps({
      approve: vi.fn(async (request: { approvalId: string }) => ({
        approvalId: request.approvalId,
        allowed: false,
      })),
    });
    const stopped = await tool("shell", localAgentTools(blocked.deps)).execute("t", {
      command: "echo hi",
    });
    expect(stopped.isError).toBe(true);

    const allowed = deps({ grant: grant({ preapproved: { shell: { allow: true } } }) });
    const done = await tool("shell", localAgentTools(allowed.deps)).execute("t", {
      command: "echo hi",
    });
    expect(allowed.approve).not.toHaveBeenCalled();
    expect(done.isError).toBeUndefined();
    expect((done.content[0] as { text: string }).text).toContain("Exit code 0");
  });

  it("reports a summary that says nothing about what it touched", async () => {
    const { deps: options } = deps({
      grant: grant({ preapproved: { apps: ["Safari"] } }),
    });
    const result = await tool("computer_act", localAgentTools(options)).execute("t", {
      actions: [{ kind: "click", x: 812, y: 440 }],
    });
    const details = result.details as { summary?: string };
    expect(details.summary).toBe("Used the computer in Safari");
    expect(details.summary).not.toContain("812");
  });
});
