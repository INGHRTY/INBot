import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerLocalProvider } from "../pi-local-provider.js";
import { applyPiModelCompatibility } from "../pi-model-compat.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
  registerOpenAiCompatibleRuntime,
} from "../pi-openai-compatible-provider.js";

/**
 * A model connection stored on this computer.
 *
 * The key never leaves the device: it is read from the computer's own keychain when the
 * task runs and handed straight to the provider.
 */
export interface DeviceModelConnection {
  /** The provider that serves the model, such as "openai" or "openai-compatible". */
  provider: string;
  /** The model id that provider serves. */
  modelId: string;
  /** Where the provider lives. Only for a custom or local endpoint. */
  baseUrl?: string;
  /** The key, read from the keychain. Never sent to Rakazo. */
  apiKey?: string;
  /** Whether the model reads images, which a screen-reading task needs. */
  acceptsImages?: boolean;
  /** Whether the model reasons before answering. */
  reasoning?: boolean;
  /** A local model server may live on a private address. */
  allowPrivate?: boolean;
  maxTokens?: number;
  contextWindow?: number;
}

export interface BoundDeviceModel {
  models: Models;
  model: Model<Api>;
  /** The key the provider request carries. */
  apiKey?: string;
}

/**
 * Binds a connection to a model the agent can talk to.
 *
 * The catalog providers come from Pi; a custom endpoint is registered the same way the
 * server registers one, so the device and the server reach a provider the same way.
 */
export function bindDeviceModel(connection: DeviceModelConnection): BoundDeviceModel {
  if (!connection.modelId.trim()) throw new Error("The model connection names no model");
  let models = registerOpenAiCompatibleCatalog(
    registerLocalProvider(applyPiModelCompatibility(builtinModels())),
  );
  if (connection.baseUrl) {
    models = registerOpenAiCompatibleRuntime(models, {
      modelId: connection.modelId.trim(),
      baseUrl: connection.baseUrl,
      allowPrivate: connection.allowPrivate,
      reasoning: connection.reasoning,
      acceptsImages: connection.acceptsImages,
      maxTokens: connection.maxTokens,
      contextWindow: connection.contextWindow,
    });
  }
  const provider = connection.baseUrl ? OPENAI_COMPATIBLE_PROVIDER_ID : connection.provider;
  const model = models.getModel(provider, connection.modelId.trim());
  if (!model) {
    throw new Error(`The model ${connection.modelId} is not available on this computer`);
  }
  return { models, model, apiKey: connection.apiKey };
}
