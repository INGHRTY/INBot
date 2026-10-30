// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { CloudAgentCard } from "./CloudAgentCard";

const card = (overrides: Partial<Extract<MessageBlock, { kind: "cloud_agent" }>> = {}) =>
  ({
    kind: "cloud_agent",
    agentId: "agent-1",
    title: "Open Safari",
    status: "running",
    url: "",
    ...overrides,
  }) satisfies Extract<MessageBlock, { kind: "cloud_agent" }>;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(block: Extract<MessageBlock, { kind: "cloud_agent" }>) {
  act(() => root.render(<CloudAgentCard block={block} />));
  return container;
}

it("shows the action a task is waiting to be allowed to take", () => {
  const view = render(
    card({
      awaitingApproval: {
        action: "type",
        summary: "Type in Safari",
        detail: "hunter2",
      },
    }),
  );
  expect(view.textContent).toContain("Type in Safari");
  // The text that would be typed is shown, because a person cannot judge it otherwise.
  expect(view.textContent).toContain("hunter2");
});

it("shows what the task answered", () => {
  const view = render(card({ status: "finished", result: "Safari is open." }));
  expect(view.textContent).toContain("Safari is open.");
});

it("shows neither while the task has nothing to report", () => {
  const view = render(card());
  expect(view.querySelector("[data-testid='cloud-agent-awaiting']")).toBeNull();
  expect(view.textContent).not.toContain("Safari is open.");
});
