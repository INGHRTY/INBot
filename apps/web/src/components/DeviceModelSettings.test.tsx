// @vitest-environment jsdom
import type { RakazoDesktop, RakazoDesktopModelConnection } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeviceModelSettings } from "./DeviceModelSettings";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  SwitchField: ({
    label,
    checked,
    onCheckedChange,
  }: {
    label: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      {label}
    </label>
  ),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.rakazoDesktop;
});

const stored: RakazoDesktopModelConnection = {
  id: "m1",
  label: "openai gpt-5",
  provider: "openai",
  modelId: "gpt-5",
  acceptsImages: true,
};

function desktopWith(models: NonNullable<NonNullable<RakazoDesktop["device"]>["models"]>) {
  window.rakazoDesktop = { platform: "darwin", device: { models } } as RakazoDesktop;
  return models;
}

async function set(id: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`missing ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Opens the dialog and fills the two fields a model needs. */
async function fillModel(provider = "openai", modelId = "gpt-5") {
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Add model")
      ?.click(),
  );
  await set("device-model-provider", provider);
  await set("device-model-id", modelId);
}

it("stays hidden in a browser and in older desktop releases", async () => {
  await act(async () => root.render(<DeviceModelSettings />));
  expect(host.innerHTML).toBe("");
  window.rakazoDesktop = { platform: "darwin", device: {} } as RakazoDesktop;
  await act(async () => root.render(<DeviceModelSettings />));
  expect(host.innerHTML).toBe("");
});

it("lists the models on this Mac and removes one", async () => {
  const models = desktopWith({
    list: vi.fn().mockResolvedValue([stored]),
    save: vi.fn(),
    remove: vi.fn().mockResolvedValue([]),
  });
  await act(async () => root.render(<DeviceModelSettings />));
  expect(host.textContent).toContain("This Mac's model");
  expect(host.textContent).toContain("openai gpt-5");

  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove openai gpt-5"]')?.click(),
  );
  expect(models.remove).toHaveBeenCalledWith("m1");
  expect(host.textContent).not.toContain("openai gpt-5");
});

it("adds a model with the key the person typed and closes", async () => {
  const models = desktopWith({
    list: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue([stored]),
    remove: vi.fn(),
  });
  await act(async () => root.render(<DeviceModelSettings />));
  await fillModel();
  await set("device-model-key", "sk-test");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  expect(models.save).toHaveBeenCalledWith({
    provider: "openai",
    modelId: "gpt-5",
    apiKey: "sk-test",
    acceptsImages: true,
  });
  expect(host.textContent).toContain("openai gpt-5");
  expect(host.querySelector("#device-model-provider")).toBeNull();
});

it("says so and keeps the dialog open when the Mac cannot use the model", async () => {
  desktopWith({
    list: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockRejectedValue(new Error("unknown model")),
    remove: vi.fn(),
  });
  await act(async () => root.render(<DeviceModelSettings />));
  await fillModel("openai", "not-a-model");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  expect(host.textContent).toContain("Could not save the model.");
  expect(host.querySelector("#device-model-id")).not.toBeNull();
});
