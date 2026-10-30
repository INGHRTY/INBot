import { createHash } from "node:crypto";
import type { CloudAgentProvider } from "@rakazo/adapter-kit";
import { EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import type { LocalDeviceCloudAgentProvider } from "./local-device-cloud-agent.js";

/** The composition root binds a credential to exactly one authorized Space. */
export interface CloudAgentConnection {
  provider: CloudAgentProvider;
  /** Opaque credential binding. Rotation fails closed for existing agents. */
  key: string;
  /** Only the offline emulator may be available in every Space. */
  spaceId?: string;
}

export function cloudAgentsEnabled(
  connection: CloudAgentConnection | null | undefined,
  spaceId: string,
) {
  return Boolean(
    connection &&
      (connection.spaceId === spaceId ||
        (!connection.spaceId && connection.provider.describe().capabilities.offline)),
  );
}

export function createCloudAgentConnection(
  source: NodeJS.ProcessEnv = process.env,
): CloudAgentConnection | null {
  const kind = resolveCloudAgentProvider(source);
  if (kind === "emulator") {
    return { provider: new EmulatorCloudAgentProvider(), key: "emulator" };
  }
  if (kind !== "cursor") return null;
  const apiKey = source.CURSOR_API_KEY!.trim();
  const spaceId = source.CLOUD_AGENT_SPACE_ID!.trim();
  return {
    provider: new CursorCloudAgentProvider({ apiKey }),
    key: `cursor:${createHash("sha256").update(apiKey).digest("hex")}`,
    spaceId,
  };
}

/** Prefix of every agent stored under a person's own computer. */
export const LOCAL_DEVICE_KEY_PREFIX = "local-device:";

/** The key an agent on a person's own computer is stored under. */
export function localDeviceProviderKey(deviceId: string) {
  return `${LOCAL_DEVICE_KEY_PREFIX}${deviceId}`;
}

/**
 * Every provider this deployment can run a cloud agent on.
 *
 * The deployment provider belongs to one Space. A person's own computer belongs to that
 * person, in any Space they belong to, so both can be offered at once: a bot picks the
 * one matching who it is running for.
 */
export interface CloudAgentProviders {
  /** The deployment-wide provider, when the operator configured one. */
  deployment?: CloudAgentConnection;
  /** This person's own computer, when they have one paired, allowed, and connected. */
  forUser(userId: string): Promise<CloudAgentConnection | undefined>;
  /** Whether a new agent can start for this Space and person. */
  available(spaceId: string, userId: string): Promise<boolean>;
  /** The provider key a new agent should be stored under for this person. */
  keyFor(spaceId: string, userId: string): Promise<string | undefined>;
  /** The provider a stored agent belongs to, by the key it was created with. */
  forKey(
    spaceId: string,
    userId: string,
    providerKey: string,
  ): Promise<CloudAgentConnection | null>;
  /** Provider keys reconciliation must look for, by exact match or prefix. */
  keys(): { exact: string[]; prefixes: string[] };
}

/** The provider a Space and person would use for a new agent. */
export async function resolveCloudAgent(
  providers: CloudAgentProviders | null | undefined,
  spaceId: string,
  userId: string,
): Promise<CloudAgentConnection | null> {
  if (!providers) return null;
  const key = await providers.keyFor(spaceId, userId).catch(() => undefined);
  if (!key) return null;
  return providers.forKey(spaceId, userId, key);
}

/**
 * A deployment that offers the configured provider and each person's own computer.
 *
 * The person's computer is only offered while it is connected: a bot never dispatches a
 * task to a Mac that cannot take it. A deployment with no operator provider is still
 * useful, because every person can then use their own computer.
 */
export function createCloudAgentProviders(deps: {
  deployment: CloudAgentConnection | null;
  /** The computer gateway; absent when user devices are turned off. */
  devices?: {
    connected(userId: string): Promise<{ deviceId: string } | null>;
  };
  /** Builds the provider for one connected computer. */
  localDevice?: (deviceId: string) => LocalDeviceCloudAgentProvider | null;
}): CloudAgentProviders {
  async function own(userId: string): Promise<CloudAgentConnection | undefined> {
    if (!deps.devices || !deps.localDevice) return undefined;
    const device = await deps.devices.connected(userId).catch(() => null);
    if (!device) return undefined;
    const provider = deps.localDevice(device.deviceId);
    return provider ? { provider, key: localDeviceProviderKey(device.deviceId) } : undefined;
  }
  return {
    ...(deps.deployment ? { deployment: deps.deployment } : {}),
    forUser: own,
    async available(spaceId, userId) {
      if (cloudAgentsEnabled(deps.deployment, spaceId)) return true;
      return Boolean(await own(userId));
    },
    async keyFor(spaceId, userId) {
      if (cloudAgentsEnabled(deps.deployment, spaceId)) return deps.deployment!.key;
      return (await own(userId))?.key;
    },
    async forKey(spaceId, userId, providerKey) {
      const deployment = deps.deployment;
      if (deployment?.key === providerKey && cloudAgentsEnabled(deployment, spaceId))
        return deployment;
      const mine = await own(userId);
      return mine?.key === providerKey ? mine : null;
    },
    keys() {
      // Device keys carry a device id, so reconciliation matches them by prefix.
      return {
        exact: deps.deployment ? [deps.deployment.key] : [],
        prefixes: [LOCAL_DEVICE_KEY_PREFIX],
      };
    },
  };
}
