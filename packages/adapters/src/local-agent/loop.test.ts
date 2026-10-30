import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ComputerAction } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { type HostFrame, HostScreen } from "../host-screen.js";
import { runLocalAgent } from "./loop.js";
import { bindDeviceModel } from "./model.js";
import type { TaskEvent } from "./task-protocol.js";
import { localAgentTools } from "./tools.js";

const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a", "hex"));

/** A model that asks for one screenshot and then answers. */
async function startModel(): Promise<{
  url: string;
  close: () => Promise<void>;
  calls: number[];
  /** Every message body the model was sent, in order. */
  bodies: string[];
}> {
  const calls: number[] = [];
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => bodies.push(Buffer.concat(chunks).toString("utf8")));
    calls.push(calls.length + 1);
    const choice =
      calls.length === 1
        ? {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "computer_observe", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          }
        : { delta: { role: "assistant", content: "Safari is open." }, finish_reason: "stop" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    bodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("local agent loop", () => {
  it("runs the tools and answers with what the model said", async () => {
    const model = await startModel();
    try {
      let captures = 0;
      const injected: ComputerAction[] = [];
      const host = new HostScreen({
        async capture(): Promise<HostFrame> {
          captures += 1;
          return { image: png, mimeType: "image/png", width: 1280, height: 800 };
        },
        async inject(action) {
          injected.push(action);
        },
        async frontmost() {
          return { id: "42", title: "Safari" };
        },
      });
      const events: TaskEvent[] = [];
      const bound = bindDeviceModel({
        provider: "openai-compatible",
        modelId: "fixture",
        baseUrl: model.url,
        apiKey: "test-key",
      });
      const result = await runLocalAgent({
        task: {
          taskId: "task-1",
          prompt: "Open Safari and tell me what you see.",
          botId: "bot-1",
          grant: {
            preapproved: {},
            onDemand: "ask",
            denied: {},
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
          model: { provider: "openai-compatible", id: "fixture", connectionRef: "ref-1" },
          budget: { maxSteps: 5, maxSeconds: 30 },
        },
        tools: localAgentTools({
          screen: host,
          home: "/tmp/rakazo-task",
          grant: {
            preapproved: {},
            onDemand: "ask",
            denied: {},
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
          approve: async (request) => ({ approvalId: request.approvalId, allowed: true }),
          runShell: async () => ({ stdout: "", stderr: "", code: 0 }),
          frontmostApp: async () => "Safari",
          deniedPatterns: new Set(),
          signal: new AbortController().signal,
        }),
        model: bound,
        systemPrompt: "You are working on one person's Mac.",
        onEvent: (event) => events.push(event),
        signal: new AbortController().signal,
      });

      expect(captures).toBe(1);
      expect(injected).toHaveLength(0);
      expect(result.answer).toBe("Safari is open.");
      const steps = events.filter((event) => event.kind === "step");
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        action: "computer_observe",
        summary: "Looked at the screen",
      });
    } finally {
      await model.close();
    }
  });

  it("adds an instruction the person sends while the task runs", async () => {
    const model = await startModel();
    try {
      const seen: string[] = [];
      const bound = bindDeviceModel({
        provider: "openai-compatible",
        modelId: "fixture",
        baseUrl: model.url,
        apiKey: "test-key",
      });
      let delivered = false;
      const result = await runLocalAgent({
        task: {
          taskId: "task-1",
          prompt: "Open Safari.",
          botId: "bot-1",
          grant: {
            preapproved: {},
            onDemand: "ask",
            denied: {},
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
          model: { provider: "openai-compatible", id: "fixture", connectionRef: "ref-1" },
          budget: { maxSteps: 5, maxSeconds: 30 },
        },
        tools: localAgentTools({
          screen: new HostScreen({
            async capture() {
              return { image: png, mimeType: "image/png", width: 1280, height: 800 };
            },
            async inject() {},
            async frontmost() {
              return { id: "42", title: "Safari" };
            },
          }),
          home: "/tmp/rakazo-task",
          grant: {
            preapproved: {},
            onDemand: "ask",
            denied: {},
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
          approve: async (request) => ({ approvalId: request.approvalId, allowed: true }),
          runShell: async () => ({ stdout: "", stderr: "", code: 0 }),
          frontmostApp: async () => "Safari",
          deniedPatterns: new Set(),
          signal: new AbortController().signal,
        }),
        model: bound,
        systemPrompt: "You are working on one person's Mac.",
        onEvent: (event) => {
          if (event.kind === "step") seen.push(event.summary);
        },
        signal: new AbortController().signal,
        nextInstruction: async () => {
          if (delivered) return undefined;
          delivered = true;
          return "Also open the address bar.";
        },
      });

      // The instruction reached the model as a person's words, not as tool output.
      expect(result.answer).toBe("Safari is open.");
      expect(seen).toEqual(["Looked at the screen"]);
      expect(model.calls.length).toBeGreaterThan(1);
      expect(model.bodies.join("\n")).toContain("Also open the address bar.");
    } finally {
      await model.close();
    }
  });

  it("stops when the task runs out of steps", async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "fixture",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "computer_observe", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const host = new HostScreen({
        async capture(): Promise<HostFrame> {
          return { image: png, mimeType: "image/png", width: 1280, height: 800 };
        },
        async inject() {},
        async frontmost() {
          return { id: "42", title: "Safari" };
        },
      });
      const bound = bindDeviceModel({
        provider: "openai-compatible",
        modelId: "fixture",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
      });
      const result = await runLocalAgent({
        task: {
          taskId: "task-2",
          prompt: "Look forever.",
          botId: "bot-1",
          grant: {
            preapproved: {},
            onDemand: "ask",
            denied: {},
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
          model: { provider: "openai-compatible", id: "fixture", connectionRef: "ref-1" },
          budget: { maxSteps: 1, maxSeconds: 30 },
        },
        tools: localAgentTools({
          screen: host,
          home: "/tmp/rakazo-task",
          grant: {
            preapproved: {},
            onDemand: "ask",
            denied: {},
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
          approve: async (request) => ({ approvalId: request.approvalId, allowed: true }),
          runShell: async () => ({ stdout: "", stderr: "", code: 0 }),
          frontmostApp: async () => "Safari",
          deniedPatterns: new Set(),
          signal: new AbortController().signal,
        }),
        model: bound,
        systemPrompt: "You are working on one person's Mac.",
        onEvent: () => undefined,
        signal: new AbortController().signal,
      });
      // The run stops after the budget, so the model never gets to answer.
      expect(result.answer).toBe("");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
