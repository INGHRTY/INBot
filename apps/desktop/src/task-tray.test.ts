import { describe, expect, it, vi } from "vitest";
import { createTaskTray } from "./task-tray.js";

function setup() {
  const item = {
    setImage: vi.fn(),
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    setIgnoreDoubleClickEvents: vi.fn(),
    destroy: vi.fn(),
  };
  const create = vi.fn(() => item);
  const buildMenu = vi.fn((items: never[]) => ({ items }));
  const stop = vi.fn();
  const show = vi.fn();
  const tray = createTaskTray({ create, icon: {} as never, buildMenu, stop, show });
  return { item, create, buildMenu, stop, show, tray };
}

describe("task tray", () => {
  it("appears with a running task and goes away when it ends", () => {
    const { item, create, buildMenu, tray } = setup();
    expect(create).not.toHaveBeenCalled();
    tray.update("task-1", true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(item.setImage).toHaveBeenCalled();
    expect(buildMenu).toHaveBeenCalledWith([
      { label: "A task is using this computer", enabled: false },
      { type: "separator" },
      { label: "Show Rakazo", click: expect.any(Function) },
      { label: "Stop Task", click: expect.any(Function) },
    ]);
    tray.update("task-1", false);
    expect(item.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the item while another task is still running", () => {
    const { item, tray } = setup();
    tray.update("task-1", true);
    tray.update("task-2", true);
    tray.update("task-1", false);
    expect(item.destroy).not.toHaveBeenCalled();
    expect(tray.count()).toBe(1);
    tray.update("task-2", false);
    expect(item.destroy).toHaveBeenCalledTimes(1);
    expect(tray.count()).toBe(0);
  });

  it("stops the task and shows the app from its menu", () => {
    const { buildMenu, stop, show, tray } = setup();
    tray.update("task-1", true);
    const items = buildMenu.mock.calls[0]![0] as Array<{ label: string; click?: () => void }>;
    items.find((entry) => entry.label === "Stop Task")!.click!();
    items.find((entry) => entry.label === "Show Rakazo")!.click!();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
