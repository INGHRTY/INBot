import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { CursorCloudAgentEmulator, EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import {
  cloudAgentsEnabled,
  createCloudAgentConnection,
  createCloudAgentProviders,
  LOCAL_DEVICE_KEY_PREFIX,
  localDeviceProviderKey,
} from "./cloud-agent-factory.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { LOCAL_TASK_GRANT_HOURS, localTaskGrant } from "./local-device-cloud-agent-factory.js";

const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

function create() {
  const provider = new EmulatorCloudAgentProvider(
    new CursorCloudAgentEmulator({ autoFinishAfterGets: null }),
  );
  return {
    provider,
    complete: (id: string, failed = false) => provider.emulator.complete(id, { failed }),
  };
}

describe("cloud agent conformance over the Cursor wire emulator (offline)", () => {
  it("replays launch without duplicate agents and preserves a finished run through a follow-up", async () => {
    const { provider, complete } = create();
    const request = {
      idempotencyKey: "create-1",
      prompt: "Add a README",
      repository: "https://github.com/example/demo",
      openPr: true,
    };
    const first = await provider.launch(request, ctx);
    expect(first.status).toBe("running");
    expect((await provider.launch(request, ctx)).id).toBe(first.id);
    complete(first.id);
    const done = await provider.get(first.id, ctx);
    expect(done).toMatchObject({ status: "finished", branch: "emulator/task" });
    expect(done.prUrl).toContain("/pull/");
    const followup = await provider.reply(first.id, { prompt: "Also add tests" }, ctx);
    expect(followup.latestRunId).not.toBe(first.latestRunId);
    expect((await provider.get(first.id, ctx, first.latestRunId)).status).toBe("finished");
    expect((await provider.get(first.id, ctx, followup.latestRunId)).status).toBe("running");
    expect((await provider.cancel(first.id, ctx)).status).toBe("cancelled");
    expect((await provider.cancel(first.id, ctx)).status).toBe("cancelled");
  });
  it("rejects concurrent follow-ups and observes failures", async () => {
    const { provider, complete } = create();
    const first = await provider.launch({ idempotencyKey: "busy", prompt: "Task" }, ctx);
    await expect(provider.reply(first.id, { prompt: "Busy" }, ctx)).rejects.toThrow();
    complete(first.id, true);
    expect((await provider.get(first.id, ctx)).status).toBe("failed");
  });
  it("honors abort and does not open a PR when disabled", async () => {
    const { provider, complete } = create();
    await expect(
      provider.launch(
        { idempotencyKey: "aborted", prompt: "Task" },
        { ...ctx, signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    const first = await provider.launch(
      {
        idempotencyKey: "no-pr",
        prompt: "Task",
        openPr: false,
        repository: "https://github.com/example/demo",
      },
      ctx,
    );
    complete(first.id);
    expect((await provider.get(first.id, ctx)).prUrl).toBeUndefined();
  });
});

describe("cloud agent composition", () => {
  it("fails closed without explicit credential and Space configuration", () => {
    for (const source of [
      {},
      { CLOUD_AGENT_PROVIDER: "bogus" },
      { CLOUD_AGENT_PROVIDER: "cursor" },
      { CLOUD_AGENT_PROVIDER: "cursor", CURSOR_API_KEY: "fake-key" },
    ]) {
      expect(resolveCloudAgentProvider(source)).toBe("none");
      expect(createCloudAgentConnection(source)).toBeNull();
    }
    const connection = createCloudAgentConnection({
      CLOUD_AGENT_PROVIDER: "cursor",
      CURSOR_API_KEY: "fake-key",
      CLOUD_AGENT_SPACE_ID: "test-space",
    })!;
    expect(cloudAgentsEnabled(connection, "test-space")).toBe(true);
    expect(cloudAgentsEnabled(connection, "other-space")).toBe(false);
    expect(connection.key).not.toContain("fake-key");
    const rotated = createCloudAgentConnection({
      CLOUD_AGENT_PROVIDER: "cursor",
      CURSOR_API_KEY: "other-fake-key",
      CLOUD_AGENT_SPACE_ID: "test-space",
    })!;
    expect(rotated.key).not.toBe(connection.key);
  });
  it("never grants an unscoped live provider access", () => {
    expect(
      cloudAgentsEnabled(
        { provider: new CursorCloudAgentProvider({ apiKey: "fake-key" }), key: "test" },
        "test-space",
      ),
    ).toBe(false);
    expect(
      cloudAgentsEnabled(
        createCloudAgentConnection({ CLOUD_AGENT_PROVIDER: "emulator" }),
        "test-space",
      ),
    ).toBe(true);
  });
});

describe("cloud agent providers", () => {
  const spaceId = "test-space";
  const userId = "test-user";

  function deployment() {
    return createCloudAgentConnection({ CLOUD_AGENT_PROVIDER: "emulator" })!;
  }
  function device(connected: string | null) {
    return {
      connected: async (id: string) =>
        connected && id === userId ? { deviceId: connected } : null,
    };
  }

  it("offers the deployment provider first and the person's computer when it is connected", async () => {
    const own = { provider: {} as never, key: localDeviceProviderKey("device-1") };
    const providers = createCloudAgentProviders({
      deployment: deployment(),
      devices: device("device-1"),
      localDevice: () => own.provider,
    });
    expect(await providers.available(spaceId, userId)).toBe(true);
    expect(await providers.keyFor(spaceId, userId)).toBe(deployment().key);
    expect(await providers.forUser(userId)).toEqual(own);
  });

  it("falls back to the person's computer when the deployment has none", async () => {
    const own = { provider: {} as never, key: localDeviceProviderKey("device-1") };
    const providers = createCloudAgentProviders({
      deployment: null,
      devices: device("device-1"),
      localDevice: () => own.provider,
    });
    expect(await providers.keyFor(spaceId, userId)).toBe(own.key);
    expect(await providers.forKey(spaceId, userId, own.key)).toEqual(own);
  });

  it("offers nothing when the person has no connected computer and no deployment provider", async () => {
    const providers = createCloudAgentProviders({
      deployment: null,
      devices: device(null),
      localDevice: () => ({}) as never,
    });
    expect(await providers.available(spaceId, userId)).toBe(false);
    expect(await providers.keyFor(spaceId, userId)).toBeUndefined();
  });

  it("never hands an agent to a provider whose key it was not created with", async () => {
    const providers = createCloudAgentProviders({
      deployment: deployment(),
      devices: device("device-1"),
      localDevice: () => ({}) as never,
    });
    expect(await providers.forKey(spaceId, userId, "local-device:other-device")).toBeNull();
  });

  it("tells reconciliation to look for the deployment key and every device key", () => {
    const providers = createCloudAgentProviders({
      deployment: deployment(),
      devices: device("device-1"),
      localDevice: () => ({}) as never,
    });
    expect(providers.keys()).toEqual({
      exact: [deployment().key],
      prefixes: [LOCAL_DEVICE_KEY_PREFIX],
    });
  });
});

describe("the grant a dispatched task runs under", () => {
  it("starts denied, asks for every action, and expires", () => {
    const now = new Date("2026-10-30T00:00:00.000Z");
    const grant = localTaskGrant(now);
    expect(grant.preapproved).toEqual({});
    expect(grant.onDemand).toBe("ask");
    expect(grant.denied).toEqual({});
    // An hour is long enough for a task and short enough that a forgotten one stops.
    expect(new Date(grant.expiresAt).getTime() - now.getTime()).toBe(
      LOCAL_TASK_GRANT_HOURS * 60 * 60_000,
    );
  });
});
