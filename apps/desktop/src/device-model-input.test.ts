import { describe, expect, it } from "vitest";
import { parseDeviceModelInput } from "./device-model-input.js";

describe("model connection input", () => {
  it("keeps what a person typed, and defaults to a model that reads screens", () => {
    expect(
      parseDeviceModelInput({
        provider: " OpenAI ",
        modelId: " gpt-5 ",
        apiKey: " sk-test ",
      }),
    ).toEqual({ provider: "openai", modelId: "gpt-5", acceptsImages: true, apiKey: "sk-test" });
    expect(
      parseDeviceModelInput({
        provider: "openai-compatible",
        modelId: "qwen",
        acceptsImages: false,
      }),
    ).toEqual({ provider: "openai-compatible", modelId: "qwen", acceptsImages: false });
  });

  it("accepts a local server and drops a trailing slash", () => {
    expect(
      parseDeviceModelInput({
        provider: "openai-compatible",
        modelId: "qwen",
        baseUrl: "http://localhost:11434/v1/",
      }),
    ).toMatchObject({ baseUrl: "http://localhost:11434/v1" });
  });

  it("refuses a file URL, a URL with a password, and empty fields", () => {
    for (const baseUrl of [
      "file:///etc/passwd",
      "https://user:secret@models.example.com/v1",
      "nope",
    ])
      expect(() =>
        parseDeviceModelInput({ provider: "openai-compatible", modelId: "qwen", baseUrl }),
      ).toThrow();
    expect(() => parseDeviceModelInput({ provider: "", modelId: "qwen" })).toThrow();
    expect(() => parseDeviceModelInput({ provider: "openai", modelId: " " })).toThrow();
    expect(() => parseDeviceModelInput({ provider: "Open AI", modelId: "qwen" })).toThrow();
    expect(parseDeviceModelInput({ provider: "openai", modelId: "qwen", apiKey: "" })).toEqual({
      provider: "openai",
      modelId: "qwen",
      acceptsImages: true,
    });
  });
});
