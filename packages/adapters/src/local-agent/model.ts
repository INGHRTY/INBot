import type { Api, Model, Models, Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_MODEL_CONTEXT_WINDOW, DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { inputModalities } from "../model-modalities.js";
import { applyPiModelCompatibility } from "../pi-model-compat.js";

/** The provider id under which this computer's own model endpoint is registered. */
export const DEVICE_MODEL_PROVIDER_ID = "device";

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
 * A connection with an endpoint is registered here rather than through the server's
 * provider: the server guards against a bot reaching internal addresses, but on the
 * person's own computer a loopback endpoint is exactly what a local model is. The
 * built-in catalog still serves a connection that names a hosted provider.
 */
export function bindDeviceModel(connection: DeviceModelConnection): BoundDeviceModel {
  const modelId = connection.modelId.trim();
  if (!modelId) throw new Error("The model connection names no model");
  if (!connection.baseUrl) {
    const models = applyPiModelCompatibility(builtinModels());
    const model = models.getModel(connection.provider, modelId);
    if (!model) {
      throw new Error(`The model ${modelId} is not available on this computer`);
    }
    return { models, model, apiKey: connection.apiKey };
  }
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: DEVICE_MODEL_PROVIDER_ID,
    baseUrl: connection.baseUrl,
    reasoning: connection.reasoning === true,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    input: inputModalities(connection.acceptsImages === true),
    // The person pays their own provider, so there is nothing for Rakazo to bill.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: connection.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: connection.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
  };
  const models = applyPiModelCompatibility(builtinModels());
  models.setProvider(deviceProvider(connection.baseUrl, model));
  return { models, model, apiKey: connection.apiKey };
}

function deviceProvider(baseUrl: string, model: Model<"openai-completions">): Provider {
  return createProvider({
    id: DEVICE_MODEL_PROVIDER_ID,
    name: "This computer's model",
    baseUrl,
    auth: {
      apiKey: {
        name: "This computer's model",
        resolve: async () => ({
          auth: { apiKey: "device", baseUrl },
          source: "this computer",
        }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
}
