import type { ComputerAction } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { type HostFrame, HostScreen, type HostScreenBackend } from "./host-screen.js";

const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a", "hex"));

function backend(overrides: Partial<HostScreenBackend> = {}) {
  const injected: ComputerAction[] = [];
  const state: HostScreenBackend = {
    async capture(): Promise<HostFrame> {
      return { image: png, mimeType: "image/png", width: 1440, height: 900 };
    },
    async inject(action) {
      injected.push(action);
    },
    async frontmost() {
      return { id: "42", title: "Safari" };
    },
    ...overrides,
  };
  return { state, injected };
}

describe("host screen permissions", () => {
  type Permissions =
    NonNullable<HostScreenBackend["permissions"]> extends () => infer P ? P : never;
  const screenWith = (permissions: Permissions) =>
    new HostScreen({
      async capture() {
        return { image: new Uint8Array(), mimeType: "image/png", width: 1, height: 1 };
      },
      async inject() {},
      async frontmost() {
        return null;
      },
      ...(permissions ? { permissions: () => permissions } : {}),
    });

  it("names the permission to turn on, and nothing when it is granted", () => {
    const denied = screenWith({ screen: "denied", accessibility: "denied" });
    expect(denied.permissionProblem(["screen"])).toContain("Screen Recording");
    expect(denied.permissionProblem(["accessibility"])).toContain("Accessibility");
    const granted = screenWith({ screen: "granted", accessibility: "granted" });
    expect(granted.permissionProblem(["screen", "accessibility"])).toBeUndefined();
  });

  it("does not block a platform that cannot report permissions", () => {
    // Windows and Linux have no per-application TCC gate, so a missing report is not a denial.
    expect(new HostScreen(backend().state).permissionProblem(["screen"])).toBeUndefined();
  });

  it("treats a permission the system has not answered yet as not granted", () => {
    expect(
      screenWith({ screen: "unknown", accessibility: "granted" }).permissionProblem(["screen"]),
    ).toContain("Screen Recording");
  });
});

describe("host screen", () => {
  it("captures a frame with the frontmost window", async () => {
    const { state } = backend();
    const observation = await new HostScreen(state).observe();
    expect(observation.width).toBe(1440);
    expect(observation.height).toBe(900);
    expect(observation.activeWindow).toEqual({ id: "42", title: "Safari" });
    expect(observation.image).toEqual(png);
    expect(observation.frameId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("runs the actions in order and returns the resulting frame", async () => {
    const { state, injected } = backend();
    const result = await new HostScreen(state).act(
      [
        { kind: "pointer", x: 10, y: 20, type: "click" },
        { kind: "wait", ms: 100 },
      ],
      { settleMs: 0 },
    );
    expect(injected.map((action) => action.kind)).toEqual(["pointer"]);
    expect(result.completed).toBe(2);
    expect(result.observation?.width).toBe(1440);
  });

  it("skips the observation when the caller does not want one", async () => {
    const { state } = backend();
    const result = await new HostScreen(state).act([{ kind: "wait", ms: 10 }], {
      settleMs: 0,
      observe: false,
    });
    expect(result.completed).toBe(1);
    expect(result.observation).toBeUndefined();
  });

  it("refuses a batch larger than the action limit", async () => {
    const { state } = backend();
    const actions = Array.from({ length: 25 }, () => ({ kind: "wait", ms: 1 }) as ComputerAction);
    await expect(new HostScreen(state).act(actions)).rejects.toThrow(/24 actions/);
  });
});
