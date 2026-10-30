import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DeviceModelConnection } from "@rakazo/adapters/local-agent";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";
import type { DeviceTokenCipher } from "./user-device.js";

const STORE_FILE = "device-models.json";
const MAX_STORE_BYTES = 256 * 1024;

/** A model connection the person set up on this computer. */
export interface StoredModelConnection {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  /** Where the provider lives, for a custom or local endpoint. */
  baseUrl?: string;
  /** Whether the model reads images. */
  acceptsImages: boolean;
  reasoning?: boolean;
}

interface StoredEntry extends StoredModelConnection {
  /** The key, encrypted with this computer's own keychain. */
  apiKey?: string;
}

/**
 * The model connections stored on this computer.
 *
 * The key never leaves the device: it is written with the computer's keychain and read
 * back only when a task runs. The cloud learns the connection's name and nothing else.
 */
export class DeviceModelStore {
  constructor(
    private readonly userDataDir: string,
    private readonly cipher: DeviceTokenCipher,
  ) {}

  private get file() {
    return path.join(this.userDataDir, STORE_FILE);
  }

  /** The connections on this computer, without their keys. */
  async list(): Promise<StoredModelConnection[]> {
    const entries = await this.entries();
    return entries.map(({ apiKey: _apiKey, ...entry }) => entry);
  }

  /** Adds or replaces a connection. The key is optional for a local model server. */
  async save(connection: Omit<StoredModelConnection, "id"> & { id?: string }, apiKey?: string) {
    const entries = await this.entries();
    const id = connection.id ?? randomUUID();
    const entry: StoredEntry = {
      id,
      label: connection.label,
      provider: connection.provider,
      modelId: connection.modelId,
      ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
      acceptsImages: connection.acceptsImages,
      ...(connection.reasoning ? { reasoning: true } : {}),
    };
    if (apiKey) {
      if (!(await this.cipher.available())) {
        throw new Error("Secure storage is unavailable");
      }
      entry.apiKey = (await this.cipher.encrypt(apiKey)).toString("base64");
    }
    const next = [...entries.filter((candidate) => candidate.id !== id), entry];
    await this.write(next);
    return id;
  }

  async remove(id: string): Promise<void> {
    const entries = await this.entries();
    await this.write(entries.filter((entry) => entry.id !== id));
  }

  /**
   * The connection a task uses when the cloud does not name one.
   *
   * A person who set up a single connection means that one. With several, the cloud must
   * say which, so this refuses rather than picking one they did not choose.
   */
  async defaultConnection(): Promise<string | undefined> {
    const entries = await this.entries();
    return entries.length === 1 ? entries[0]!.id : undefined;
  }

  /** The connection and its key, ready for the agent to use. */
  async resolve(id: string): Promise<DeviceModelConnection> {
    const entry = (await this.entries()).find((candidate) => candidate.id === id);
    if (!entry) throw new Error("That model connection is not on this computer");
    const apiKey = entry.apiKey
      ? await this.cipher.decrypt(Buffer.from(entry.apiKey, "base64"))
      : undefined;
    return {
      provider: entry.provider,
      modelId: entry.modelId,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      acceptsImages: entry.acceptsImages,
      ...(entry.reasoning ? { reasoning: true } : {}),
    };
  }

  private async entries(): Promise<StoredEntry[]> {
    const raw = await readPrivateFile(this.file, MAX_STORE_BYTES);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is StoredEntry =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as StoredEntry).id === "string" &&
          typeof (entry as StoredEntry).modelId === "string",
      );
    } catch {
      return [];
    }
  }

  private async write(entries: StoredEntry[]): Promise<void> {
    await writePrivateFile(this.file, JSON.stringify(entries));
  }
}
