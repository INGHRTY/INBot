import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from "electron";

/**
 * The menu bar item that appears while a task uses this computer.
 *
 * It is not permanent chrome: it exists only while something is running, and its one
 * action stops that task. The task keeps reporting to the cloud either way.
 */
export function createTaskTray(deps: {
  create: () => Tray;
  icon: NativeImage;
  buildMenu: (items: MenuItemConstructorOptions[]) => Menu;
  /** Stops every task running on this computer. */
  stop: () => void;
  /** Brings the app forward, so the person can see what the task is doing. */
  show: () => void;
}) {
  let tray: Tray | null = null;
  const running = new Set<string>();

  function build() {
    if (!tray) {
      tray = deps.create();
      tray.setImage(deps.icon);
      tray.setToolTip("A task is using this computer");
    }
    tray.setContextMenu(
      deps.buildMenu([
        { label: "A task is using this computer", enabled: false },
        { type: "separator" },
        { label: "Show Rakazo", click: () => deps.show() },
        { label: "Stop Task", click: () => deps.stop() },
      ]),
    );
  }

  function hide() {
    tray?.destroy();
    tray = null;
  }

  return {
    /** Notes that a task started or ended, and shows or hides the item to match. */
    update(taskId: string, isRunning: boolean) {
      if (isRunning) running.add(taskId);
      else running.delete(taskId);
      if (running.size === 0) hide();
      else build();
    },
    /** How many tasks this computer is running. */
    count() {
      return running.size;
    },
    close() {
      running.clear();
      hide();
    },
  };
}

export type TaskTray = ReturnType<typeof createTaskTray>;
