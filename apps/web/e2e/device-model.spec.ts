import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("a model for this Mac is added and removed in settings", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const store: {
      id: string;
      label: string;
      provider: string;
      modelId: string;
      acceptsImages: boolean;
      isDefault: boolean;
    }[] = [];
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        device: {
          state: async () => null,
          setAllowed: async () => null,
          models: {
            list: async () => store.slice(),
            save: async (input: { provider: string; modelId: string; acceptsImages: boolean }) => {
              store.push({
                id: `model-${store.length + 1}`,
                label: `${input.provider} ${input.modelId}`,
                provider: input.provider,
                modelId: input.modelId,
                acceptsImages: input.acceptsImages,
                isDefault: !store.some((connection) => connection.isDefault),
              });
              return store.slice();
            },
            setDefault: async (id: string) => {
              for (const connection of store) connection.isDefault = connection.id === id;
              return store.slice();
            },
            remove: async (id: string) => {
              const index = store.findIndex((connection) => connection.id === id);
              if (index >= 0) store.splice(index, 1);
              return store.slice();
            },
          },
        },
      },
    });
  });
  const stamp = Date.now();
  await signup(page, `device-model-${stamp}@rakazo.test`, "password12", "Model Tester");
  await completeOnboarding(page);
  await openUserSettings(page);
  const models = page.getByTestId("device-models");
  await expect(models).toContainText("This Mac's model");
  await models.getByRole("button", { name: "Add model" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Provider").fill("openai");
  await dialog.getByLabel("Model").fill("gpt-5");
  await dialog.getByLabel("API key").fill("sk-test-not-real");
  await captureScreenshot(page, testInfo, "device-model-add");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(models.getByText("openai gpt-5")).toBeVisible();
  await captureScreenshot(page, testInfo, "device-model-settings");
  await models.getByRole("button", { name: "Remove openai gpt-5" }).click();
  await expect(models.getByText("openai gpt-5")).toHaveCount(0);
});
