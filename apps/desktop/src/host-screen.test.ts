import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureScreen = vi.fn();
const macosCursorPosition = vi.fn();
const macosFrontmostWindow = vi.fn();
const macosInject = vi.fn();

vi.mock("./screen-capture.js", () => ({
  captureScreen: () => captureScreen(),
  screenRecordingStatus: () => "granted",
}));
vi.mock("./macos-native.js", () => ({
  macosAccessibilityTrusted: () => true,
  macosCursorPosition: () => macosCursorPosition(),
  macosFrontmostWindow: () => macosFrontmostWindow(),
  macosInject: (action: unknown) => macosInject(action),
}));

import { createDesktopHostScreen } from "./host-screen.js";

const platform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  captureScreen.mockReset();
  macosCursorPosition.mockReset();
  macosFrontmostWindow.mockReset();
  macosInject.mockReset();
  captureScreen.mockResolvedValue({
    frame: { image: new Uint8Array([1, 2, 3]), mimeType: "image/png", width: 1280, height: 720 },
    display: { id: 4, origin: { x: 100, y: 50 }, width: 1280, height: 720 },
  });
  macosCursorPosition.mockReturnValue({ x: 340, y: 210 });
  macosFrontmostWindow.mockReturnValue({ id: "42", title: "Safari" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
});

describe("desktop host screen", () => {
  it("reports the pointer relative to the captured display", async () => {
    const screen = createDesktopHostScreen();
    const observation = await screen.observe();
    expect(observation.cursor).toEqual({ x: 240, y: 160 });
    expect(observation.activeWindow).toEqual({ id: "42", title: "Safari" });
  });

  it("turns frame coordinates into screen coordinates", async () => {
    const screen = createDesktopHostScreen();
    await screen.observe();
    await screen.act([{ kind: "pointer", x: 240, y: 160, type: "click" }], { settleMs: 0 });
    expect(macosInject).toHaveBeenCalledWith({
      kind: "pointer",
      x: 340,
      y: 210,
      type: "click",
    });
  });

  it("moves the scroll position to screen coordinates too", async () => {
    const screen = createDesktopHostScreen();
    await screen.observe();
    await screen.act([{ kind: "scroll", direction: "down", amount: 2, x: 240, y: 160 }], {
      settleMs: 0,
      observe: false,
    });
    expect(macosInject).toHaveBeenCalledWith({
      kind: "scroll",
      direction: "down",
      amount: 2,
      x: 340,
      y: 210,
    });
  });

  it("keeps a scroll without a position where it is", async () => {
    const screen = createDesktopHostScreen();
    await screen.observe();
    await screen.act([{ kind: "scroll", direction: "up" }], { settleMs: 0, observe: false });
    expect(macosInject).toHaveBeenCalledWith({ kind: "scroll", direction: "up" });
  });
});
