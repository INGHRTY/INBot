import { spawn } from "node:child_process";
import {
  desktopProtectionGuardMessage,
  protectedComputerLifecycleRefusal,
} from "../desktop-command-guard.js";
import { hostCommandEnvironment } from "../sandbox-command-environment.js";
import type { ShellResult } from "./tools.js";

/** How long a task's shell command may run. */
const SHELL_TIMEOUT_MS = 60_000;
/** How much output a task's shell command may produce. */
const SHELL_OUTPUT_MAX_BYTES = 256 * 1024;

/**
 * Runs one shell command for a task.
 *
 * The command runs as the person who owns the computer, so the desktop-protection guard
 * refuses the commands that would restart its own apps, and the environment is the small
 * one a shell needs rather than everything this process holds.
 */
export async function runTaskShell(command: string, cwd: string): Promise<ShellResult> {
  const refusal = protectedComputerLifecycleRefusal(command);
  if (refusal) {
    return { stdout: "", stderr: desktopProtectionGuardMessage(refusal), code: 126 };
  }
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: hostCommandEnvironment({ env: {}, unsetEnv: [] }) as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        stdout,
        stderr: `${stderr}\nThe command ran too long and was stopped.`,
        code: 124,
      });
    }, SHELL_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < SHELL_OUTPUT_MAX_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < SHELL_OUTPUT_MAX_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ stdout, stderr: error.message, code: 127 }));
    child.on("close", (code) => finish({ stdout, stderr, code: code ?? 0 }));
  });
}
