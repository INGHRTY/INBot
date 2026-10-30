import type {
  ComputerAction,
  ComputerActionResult,
  ComputerObservation,
} from "@rakazo/adapter-kit";
import { boundedComputerActions, clampRounded, computerObservation } from "./computer-support.js";

/** One captured frame of the host screen. */
export interface HostFrame {
  image: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  cursor?: { x: number; y: number };
}

/** The application in front, when the platform can name it. */
export interface HostWindow {
  /** Process identifier of the frontmost application. */
  id: string;
  title?: string;
}

/** A permission the system grants per application, not per request. */
export type HostPermission = "screen" | "accessibility";

export type HostPermissionState = "granted" | "denied" | "unknown";

/** What the platform allows this app to do right now. */
export type HostPermissions = Record<HostPermission, HostPermissionState>;

/** The platform primitives a host screen is built from. */
export interface HostScreenBackend {
  capture(): Promise<HostFrame>;
  inject(action: ComputerAction): Promise<void>;
  frontmost(): Promise<HostWindow | null>;
  /**
   * What the system currently allows. A task that needs a permission the person has not
   * granted should say which one, rather than fail at the first capture.
   */
  permissions?(): HostPermissions;
}

/**
 * A reason the person can act on, or undefined when this computer may proceed.
 *
 * Reading the screen needs Screen Recording and acting on it needs Accessibility; both are
 * granted per application in System Settings, so the message names the one to turn on.
 */
export function hostPermissionProblem(
  permissions: HostPermissions | undefined,
  needs: readonly HostPermission[],
): string | undefined {
  if (!permissions) return undefined;
  for (const permission of needs) {
    const state = permissions[permission];
    if (state === "granted") continue;
    return permission === "screen"
      ? "Screen Recording is off for Rakazo. Turn it on in System Settings, Privacy and Security, then run the task again."
      : "Accessibility is off for Rakazo. Turn it on in System Settings, Privacy and Security, then run the task again.";
  }
  return undefined;
}

export const HOST_SCREEN_DEFAULT_SETTLE_MS = 350;
export const HOST_SCREEN_MAX_SETTLE_MS = 5_000;

/**
 * Screen capture and input injection on one computer. The platform specifics stay behind
 * {@link HostScreenBackend}, so the same screen drives the local agent and remote control.
 */
export class HostScreen {
  constructor(private readonly backend: HostScreenBackend) {}

  /** A reason this computer cannot take the given kind of action, if it cannot. */
  permissionProblem(needs: readonly HostPermission[]): string | undefined {
    return hostPermissionProblem(this.backend.permissions?.(), needs);
  }

  async observe(): Promise<ComputerObservation> {
    const frame = await this.backend.capture();
    const window = await this.backend.frontmost();
    return computerObservation(frame.image, {
      mimeType: frame.mimeType,
      width: frame.width,
      height: frame.height,
      ...(frame.cursor ? { cursor: frame.cursor } : {}),
      ...(window ? { activeWindow: window } : {}),
    });
  }

  /** Runs the actions in order, lets the screen settle, and returns the resulting frame. */
  async act(
    actions: readonly ComputerAction[],
    options: { settleMs?: number; observe?: boolean } = {},
  ): Promise<ComputerActionResult> {
    const bounded = boundedComputerActions(actions);
    for (const action of bounded) {
      // Waiting belongs to the screen, not to the platform that draws it.
      if (action.kind === "wait") {
        await new Promise((resolve) => setTimeout(resolve, clampRounded(action.ms, 0, 5_000)));
        continue;
      }
      await this.backend.inject(action);
    }
    const settleMs = clampRounded(
      options.settleMs ?? HOST_SCREEN_DEFAULT_SETTLE_MS,
      0,
      HOST_SCREEN_MAX_SETTLE_MS,
    );
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (options.observe === false) return { completed: bounded.length };
    return { completed: bounded.length, observation: await this.observe() };
  }

  frontmost(): Promise<HostWindow | null> {
    return this.backend.frontmost();
  }
}
