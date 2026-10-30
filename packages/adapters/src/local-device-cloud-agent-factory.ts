import type { AdapterContext } from "@rakazo/adapter-kit";
import type { CloudAgentConnection, CloudAgentProviders } from "./cloud-agent-factory.js";
import { createCloudAgentProviders } from "./cloud-agent-factory.js";
import type { TaskGrant } from "./local-agent/grant.js";
import { TASK_GRANT_MAX_HOURS, taskGrantCeiling } from "./local-agent/grant.js";
import { LocalDeviceCloudAgentProvider } from "./local-device-cloud-agent.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

/** How long a dispatched task's grant lasts, so a forgotten task cannot act forever. */
export const LOCAL_TASK_GRANT_HOURS = TASK_GRANT_MAX_HOURS;

/**
 * The grant a cloud-dispatched task runs under.
 *
 * Everything starts denied and everything else asks: a person's own computer is only
 * touched after they allow that specific action, on a card that names it. Reading the
 * screen needs no approval because it changes nothing and they already turned this
 * computer on for bots; where those pixels go is the model tier's business. This is the
 * ceiling the computer itself enforces, so widening it here widens nothing.
 */
export function localTaskGrant(now = new Date()): TaskGrant {
  return taskGrantCeiling(now);
}

/** The registry a composition root passes to the executor, job handlers, and router. */
export function createLocalDeviceCloudAgents(deps: {
  /** The operator's own provider, if this deployment configured one. */
  deployment: CloudAgentConnection | null;
  /** The computer gateway; absent when user devices are turned off. */
  devices?: UserDeviceGateway;
  grant?: (context: AdapterContext) => TaskGrant;
}): CloudAgentProviders {
  return createCloudAgentProviders({
    deployment: deps.deployment,
    ...(deps.devices ? { devices: deps.devices } : {}),
    localDevice: (deviceId) =>
      deps.devices
        ? new LocalDeviceCloudAgentProvider({
            devices: deps.devices,
            deviceId,
            grant: deps.grant ?? (() => localTaskGrant()),
            budget: { maxSteps: 40, maxSeconds: 600 },
          })
        : null,
  });
}
