import type { RakazoDesktopModelInput } from "@rakazo/contracts";

const MAX_PROVIDER = 64;
const MAX_MODEL = 200;
const MAX_URL = 2048;
const MAX_KEY = 4000;

/**
 * Checks what the settings page sends before a key is encrypted or a connection is stored.
 *
 * The page is this app's own, but it runs remote content, so nothing about a model
 * connection is taken on trust: a wrong provider or a file URL fails here, not mid-task.
 */
export function parseDeviceModelInput(input: unknown): RakazoDesktopModelInput {
  if (!input || typeof input !== "object") throw new Error("No model connection was given");
  const record = input as Record<string, unknown>;
  const provider = text(record.provider, MAX_PROVIDER).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider)) throw new Error("That provider name is not valid");
  const modelId = text(record.modelId, MAX_MODEL);
  const baseUrl = record.baseUrl === undefined ? undefined : serverUrl(record.baseUrl);
  const apiKey = record.apiKey === undefined ? undefined : key(record.apiKey);
  return {
    provider,
    modelId,
    acceptsImages: record.acceptsImages !== false,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("A required field is missing");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error("A required field is missing");
  return trimmed;
}

function serverUrl(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_URL)
    throw new Error("That server URL is not valid");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("That server URL is not valid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
    throw new Error("That server URL is not valid");
  return url.toString().replace(/\/$/, "");
}

function key(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_KEY || !value.trim())
    throw new Error("That API key is not valid");
  return value.trim();
}
