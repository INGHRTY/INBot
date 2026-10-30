import type { HostFrame } from "@rakazo/adapters/host-screen";
import { desktopCapturer, screen, systemPreferences } from "electron";

export type MediaAccess = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

export interface CapturedDisplay {
  id: number;
  /** Where the display sits in global screen points. */
  origin: { x: number; y: number };
  width: number;
  height: number;
}

export interface CapturedScreen {
  frame: HostFrame;
  display: CapturedDisplay;
}

/** What macOS allows this app to read the screen. */
export function screenRecordingStatus(): MediaAccess {
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}

/**
 * Captures the display under the pointer.
 *
 * The image is captured at the size macOS shows the screen in points, not at the doubled
 * resolution of a retina panel, so a coordinate in the image is a coordinate on the
 * screen and nothing has to be rescaled before a click.
 */
export async function captureScreen(): Promise<CapturedScreen> {
  const displays = screen.getAllDisplays();
  const cursor = screen.getCursorScreenPoint();
  const display =
    displays.find((candidate) => contains(candidate.bounds, cursor)) ?? screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: display.bounds.width, height: display.bounds.height },
  });
  const source =
    sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("The screen could not be captured");
  }
  const size = source.thumbnail.getSize();
  return {
    frame: {
      image: Uint8Array.from(source.thumbnail.toPNG()),
      mimeType: "image/png",
      width: size.width,
      height: size.height,
    },
    display: {
      id: display.id,
      origin: { x: display.bounds.x, y: display.bounds.y },
      width: display.bounds.width,
      height: display.bounds.height,
    },
  };
}

function contains(
  bounds: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
) {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x < bounds.x + bounds.width &&
    point.y < bounds.y + bounds.height
  );
}
