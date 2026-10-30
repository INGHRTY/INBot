import path from "node:path";
import { createLocalAgentRunner, runTaskShell } from "@rakazo/adapters/local-agent";
import type { UserDeviceTaskRunner } from "@rakazo/adapters/user-device-client";
import { DeviceModelStore } from "./device-model-credentials.js";
import { createDesktopHostScreen } from "./host-screen.js";
import type { DeviceTokenCipher } from "./user-device.js";

/**
 * Runs the tasks the cloud sends to this computer.
 *
 * The model connection comes from this computer's own store, so the key never travels,
 * and the shell runs with a minimal environment in the task's own folder.
 */
export function createDesktopTaskRunner(deps: {
  userDataDir: string;
  cipher: DeviceTokenCipher;
}): UserDeviceTaskRunner {
  const models = new DeviceModelStore(deps.userDataDir, deps.cipher);
  const home = path.join(deps.userDataDir, "tasks");
  return createLocalAgentRunner({
    screen: createDesktopHostScreen(),
    home,
    connection: (reference) => models.resolve(reference),
    runShell: (command, cwd) => runTaskShell(command, cwd),
  });
}
