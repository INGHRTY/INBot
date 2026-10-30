import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceModelStore } from "./device-model-credentials.js";
import type { DeviceTokenCipher } from "./user-device.js";

/** A cipher that hides the key from anyone who opens the file. */
const cipher: DeviceTokenCipher = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(value).reverse(),
  decrypt: async (value) =>
    Buffer.from(Buffer.from(value.toString("base64"), "base64").reverse()).toString("utf8"),
};

describe("device model store", () => {
  let dir: string;
  let store: DeviceModelStore;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-device-model-")));
    store = new DeviceModelStore(dir, cipher);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("keeps the key on the computer and out of the listing", async () => {
    const id = await store.save(
      {
        label: "My model",
        provider: "openai-compatible",
        modelId: "gpt-5",
        baseUrl: "https://models.example.com/v1",
        acceptsImages: true,
      },
      "sk-secret-value",
    );
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, label: "My model", modelId: "gpt-5" });
    expect(JSON.stringify(listed)).not.toContain("sk-secret-value");

    const resolved = await store.resolve(id);
    expect(resolved.apiKey).toBe("sk-secret-value");
    expect(resolved.baseUrl).toBe("https://models.example.com/v1");
    expect(resolved.acceptsImages).toBe(true);
  });

  it("does not write the key in the clear", async () => {
    await store.save(
      {
        label: "My model",
        provider: "openai-compatible",
        modelId: "gpt-5",
        acceptsImages: false,
      },
      "sk-secret-value",
    );
    const stored = await readFile(path.join(dir, "device-models.json"), "utf8");
    expect(stored).not.toContain("sk-secret-value");
  });

  it("stores a local model without a key", async () => {
    const id = await store.save({
      label: "Ollama",
      provider: "openai-compatible",
      modelId: "qwen3",
      baseUrl: "http://127.0.0.1:11434/v1",
      acceptsImages: false,
    });
    const resolved = await store.resolve(id);
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  it("uses the only connection as the default, and refuses to pick among several", async () => {
    await expect(store.defaultConnection()).resolves.toBeUndefined();
    const only = await store.save({
      label: "My model",
      provider: "openai-compatible",
      modelId: "gpt-5",
      acceptsImages: false,
    });
    await expect(store.defaultConnection()).resolves.toBe(only);
    await store.save({
      label: "Work model",
      provider: "openai-compatible",
      modelId: "gpt-4.1",
      acceptsImages: false,
    });
    // Two connections means the person must choose, not that one is guessed.
    await expect(store.defaultConnection()).resolves.toBeUndefined();
  });

  it("removes a connection", async () => {
    const id = await store.save({
      label: "My model",
      provider: "openai-compatible",
      modelId: "gpt-5",
      acceptsImages: false,
    });
    await store.remove(id);
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.resolve(id)).rejects.toThrow("not on this computer");
  });
});
