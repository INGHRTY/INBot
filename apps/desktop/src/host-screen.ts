import type { ComputerAction } from "@rakazo/adapter-kit";
import { HostScreen } from "@rakazo/adapters/host-screen";
import {
  macosAccessibilityTrusted,
  macosCursorPosition,
  macosFrontmostWindow,
  macosInject,
} from "./macos-native.js";
import { captureScreen, screenRecordingStatus } from "./screen-capture.js";

/** What macOS allows this app to do right now. */
export function desktopScreenAccess() {
  return {
    /** Reading the screen. */
    screen: screenRecordingStatus(),
    /** Controlling other applications. */
    accessibility: macosAccessibilityTrusted() ? "granted" : "denied",
  };
}

/**
 * The screen of this computer, as the local agent and remote control see it.
 *
 * Only macOS can do this today: it needs the capture and accessibility permissions that
 * the system keeps per application.
 */
export function createDesktopHostScreen(): HostScreen {
  if (process.platform !== "darwin") {
    throw new Error("Screen control is only available on macOS");
  }
  // Pointer coordinates arrive in the frame's own space, so they need the display origin.
  let origin = { x: 0, y: 0 };
  return new HostScreen({
    async capture() {
      const captured = await captureScreen();
      origin = captured.display.origin;
      const cursor = macosCursorPosition();
      return {
        ...captured.frame,
        ...(cursor ? { cursor: { x: cursor.x - origin.x, y: cursor.y - origin.y } } : {}),
      };
    },
    async inject(action) {
      await macosInject(toGlobal(action));
    },
    async frontmost() {
      return macosFrontmostWindow() ?? null;
    },
  });

  function toGlobal(action: ComputerAction): ComputerAction {
    if (action.kind === "pointer") {
      return { ...action, x: action.x + origin.x, y: action.y + origin.y };
    }
    if (action.kind === "scroll" && action.x !== undefined && action.y !== undefined) {
      return { ...action, x: action.x + origin.x, y: action.y + origin.y };
    }
    return action;
  }
}
