import { spawn } from "node:child_process";
import type { ComputerAction } from "@rakazo/adapter-kit";
import koffi from "koffi";
import { macModifierFlags, macVirtualKeycode } from "./macos-keys.js";

/**
 * macOS input injection and window information.
 *
 * The window and pointer work goes through CoreGraphics and Accessibility directly: going
 * through AppleScript would be slower, would need a second permission, and would type
 * badly with a Chinese input method.
 */

const CORE_GRAPHICS = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const ACCESSIBILITY =
  "/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices";

/** kCGHIDEventTap. */
const HID_EVENT_TAP = 0;
/** kCGEventSourceStateHIDSystemState. */
const SOURCE_STATE_HID = 1;
/** kCGScrollEventUnitLine. */
const SCROLL_UNIT_LINE = 0;

const MOUSE_MOVED = 0;
const MOUSE_LEFT_DOWN = 1;
const MOUSE_LEFT_UP = 2;
const MOUSE_RIGHT_DOWN = 3;
const MOUSE_RIGHT_UP = 4;

const BUTTON_LEFT = 0;
const BUTTON_RIGHT = 1;

const CF_STRING_ENCODING_ASCII = 0x0600;
const CF_STRING_ENCODING_UTF8 = 0x0800_0100;

/** The application in front, when macOS can name it. */
export interface MacFrontmostWindow {
  /** Process identifier of the frontmost application. */
  id: string;
  title?: string;
}

interface MacBindings {
  cgEventSourceCreate: (stateId: number) => unknown;
  cgEventCreate: (source: unknown) => unknown;
  cgEventCreateMouseEvent: (
    source: unknown,
    mouseType: number,
    point: { x: number; y: number },
    button: number,
  ) => unknown;
  cgEventPost: (tap: number, event: unknown) => void;
  cgEventGetLocation: (event: unknown) => { x: number; y: number };
  cgEventCreateKeyboardEvent: (source: unknown, keyCode: number, keyDown: boolean) => unknown;
  cgEventSetFlags: (event: unknown, flags: number) => void;
  cgEventKeyboardSetUnicodeString: (
    event: unknown,
    length: number,
    characters: Uint16Array,
  ) => void;
  cgEventCreateScrollWheelEvent: (
    source: unknown,
    units: number,
    wheelCount: number,
    wheel1: number,
    wheel2: number,
    wheel3: number,
  ) => unknown;
  cgWarpMouseCursorPosition: (point: { x: number; y: number }) => void;
  cgWindowListCopyWindowInfo: (option: number, relativeToWindow: number) => unknown;
  cfStringCreateWithCString: (allocator: unknown, text: string, encoding: number) => unknown;
  cfStringGetLength: (value: unknown) => number;
  cfStringGetCString: (value: unknown, buffer: Buffer, size: number, encoding: number) => boolean;
  cfRelease: (value: unknown) => void;
  cfArrayGetCount: (array: unknown) => number;
  cfArrayGetValueAtIndex: (array: unknown, index: number) => unknown;
  cfDictionaryGetValue: (dictionary: unknown, key: unknown) => unknown;
  cfNumberGetValue: (number: unknown, type: number, out: number[]) => boolean;
  axIsProcessTrusted: () => boolean;
}

let bindings: MacBindings | undefined;

/** True when this computer can inject input and read the frontmost window. */
export function macosNativeAvailable(): boolean {
  return process.platform === "darwin";
}

/** Whether macOS lets this app control other applications. */
export function macosAccessibilityTrusted(): boolean {
  if (!macosNativeAvailable()) return false;
  try {
    return loadBindings().axIsProcessTrusted();
  } catch {
    return false;
  }
}

function loadBindings(): MacBindings {
  if (bindings) return bindings;
  const cg = koffi.load(CORE_GRAPHICS);
  const cf = koffi.load(CORE_FOUNDATION);
  const ax = koffi.load(ACCESSIBILITY);
  // The struct is registered before the functions that pass it by value.
  koffi.struct("RakazoCGPoint", { x: "double", y: "double" });
  const loaded: MacBindings = {
    cgEventSourceCreate: cg.func("void* __cdecl CGEventSourceCreate(int stateID)"),
    cgEventCreate: cg.func("void* __cdecl CGEventCreate(void* source)"),
    cgEventCreateMouseEvent: cg.func(
      "void* __cdecl CGEventCreateMouseEvent(void* source, uint32_t mouseType, RakazoCGPoint location, uint32_t mouseButton)",
    ),
    cgEventPost: cg.func("void __cdecl CGEventPost(uint32_t tap, void* event)"),
    cgEventGetLocation: cg.func("RakazoCGPoint __cdecl CGEventGetLocation(void* event)"),
    cgEventCreateKeyboardEvent: cg.func(
      "void* __cdecl CGEventCreateKeyboardEvent(void* source, uint16_t keyCode, bool keyDown)",
    ),
    cgEventSetFlags: cg.func("void __cdecl CGEventSetFlags(void* event, uint64_t flags)"),
    cgEventKeyboardSetUnicodeString: cg.func(
      "void __cdecl CGEventKeyboardSetUnicodeString(void* event, uint32_t stringLength, uint16_t* unicodeString)",
    ),
    cgEventCreateScrollWheelEvent: cg.func(
      "void* __cdecl CGEventCreateScrollWheelEvent(void* source, uint32_t units, uint32_t wheelCount, int32_t wheel1, int32_t wheel2, int32_t wheel3)",
    ),
    cgWarpMouseCursorPosition: cg.func(
      "void __cdecl CGWarpMouseCursorPosition(RakazoCGPoint point)",
    ),
    cgWindowListCopyWindowInfo: cg.func(
      "void* __cdecl CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)",
    ),
    cfStringCreateWithCString: cf.func(
      "void* __cdecl CFStringCreateWithCString(void* alloc, const char* cStr, uint32_t encoding)",
    ),
    cfStringGetLength: cf.func("int64_t __cdecl CFStringGetLength(void* string)"),
    cfStringGetCString: cf.func(
      "bool __cdecl CFStringGetCString(void* string, char* buffer, int64_t bufferSize, uint32_t encoding)",
    ),
    cfRelease: cf.func("void __cdecl CFRelease(void* value)"),
    cfArrayGetCount: cf.func("int64_t __cdecl CFArrayGetCount(void* array)"),
    cfArrayGetValueAtIndex: cf.func(
      "void* __cdecl CFArrayGetValueAtIndex(void* array, int64_t idx)",
    ),
    cfDictionaryGetValue: cf.func("void* __cdecl CFDictionaryGetValue(void* dict, void* key)"),
    cfNumberGetValue: cf.func(
      "bool __cdecl CFNumberGetValue(void* number, int64_t theType, _Out_ int64_t* value)",
    ),
    axIsProcessTrusted: ax.func("bool __cdecl AXIsProcessTrusted(void)"),
  };
  bindings = loaded;
  return loaded;
}

/** The pointer position in global screen coordinates. */
export function macosCursorPosition(): { x: number; y: number } | undefined {
  if (!macosNativeAvailable()) return undefined;
  const native = loadBindings();
  const event = native.cgEventCreate(null);
  if (!event) return undefined;
  const location = native.cgEventGetLocation(event);
  return { x: Math.round(location.x), y: Math.round(location.y) };
}

/**
 * Performs one desktop action. Pointer coordinates are in the frame's own space, so the
 * caller adds the display origin before calling.
 */
export async function macosInject(action: ComputerAction): Promise<void> {
  if (!macosNativeAvailable()) throw new Error("Input injection is only available on macOS");
  const native = loadBindings();
  const source = native.cgEventSourceCreate(SOURCE_STATE_HID);
  switch (action.kind) {
    case "pointer":
      postPointer(native, source, action);
      return;
    case "scroll":
      postScroll(native, source, action);
      return;
    case "key":
      postKey(native, source, action.key, action.modifiers ?? []);
      return;
    case "clipboard":
      postText(native, source, action.text);
      return;
    case "open":
      await openPath(action.path);
      return;
    case "launch":
      await openApplication(action.application, action.uri);
      return;
    case "focus":
      await openApplication(action.application);
      return;
    default:
      throw new Error(`Unsupported desktop action ${action.kind}`);
  }
}

/** The application in front, and its window title when macOS allows reading it. */
export function macosFrontmostWindow(): MacFrontmostWindow | undefined {
  if (!macosNativeAvailable()) return undefined;
  return frontmostFromWindowList(loadBindings());
}

/**
 * Moves the pointer and lets the application know.
 *
 * A posted mouse-moved event does not move the pointer on its own, so the cursor is warped
 * first and the event follows to give applications the hover they expect.
 */
function postPointer(
  native: MacBindings,
  source: unknown,
  action: Extract<ComputerAction, { kind: "pointer" }>,
) {
  const button = action.button === "right" ? BUTTON_RIGHT : BUTTON_LEFT;
  const point = { x: Math.round(action.x), y: Math.round(action.y) };
  native.cgWarpMouseCursorPosition(point);
  if (action.type === "move") {
    post(native, native.cgEventCreateMouseEvent(source, MOUSE_MOVED, point, button));
    return;
  }
  // The mouse type carries the button, so a right press needs the right type.
  const down = button === BUTTON_RIGHT ? MOUSE_RIGHT_DOWN : MOUSE_LEFT_DOWN;
  const up = button === BUTTON_RIGHT ? MOUSE_RIGHT_UP : MOUSE_LEFT_UP;
  if (action.type === "down") {
    post(native, native.cgEventCreateMouseEvent(source, down, point, button));
    return;
  }
  if (action.type === "up") {
    post(native, native.cgEventCreateMouseEvent(source, up, point, button));
    return;
  }
  post(native, native.cgEventCreateMouseEvent(source, down, point, button));
  post(native, native.cgEventCreateMouseEvent(source, up, point, button));
}

function postScroll(
  native: MacBindings,
  source: unknown,
  action: Extract<ComputerAction, { kind: "scroll" }>,
) {
  const amount = Math.min(Math.max(Math.round(action.amount ?? 3), 1), 20);
  const horizontal = action.direction === "left" || action.direction === "right";
  const step = action.direction === "up" || action.direction === "right" ? 1 : -1;
  if (action.x !== undefined && action.y !== undefined) {
    const point = { x: Math.round(action.x), y: Math.round(action.y) };
    native.cgWarpMouseCursorPosition(point);
    post(native, native.cgEventCreateMouseEvent(source, MOUSE_MOVED, point, BUTTON_LEFT));
  }
  for (let index = 0; index < amount; index += 1) {
    const event = horizontal
      ? native.cgEventCreateScrollWheelEvent(source, SCROLL_UNIT_LINE, 2, 0, step, 0)
      : native.cgEventCreateScrollWheelEvent(source, SCROLL_UNIT_LINE, 1, step, 0, 0);
    post(native, event);
  }
}

function postKey(native: MacBindings, source: unknown, key: string, modifiers: readonly string[]) {
  const keycode = macVirtualKeycode(key);
  if (keycode === undefined) {
    postText(native, source, key);
    return;
  }
  const flags = macModifierFlags(modifiers);
  const down = native.cgEventCreateKeyboardEvent(source, keycode, true);
  if (flags) native.cgEventSetFlags(down, flags);
  post(native, down);
  const up = native.cgEventCreateKeyboardEvent(source, keycode, false);
  if (flags) native.cgEventSetFlags(up, flags);
  post(native, up);
}

/**
 * Types text as characters rather than keystrokes, so it works on any keyboard layout and
 * leaves the clipboard alone.
 */
function postText(native: MacBindings, source: unknown, text: string) {
  for (const character of text) {
    if (character === "\n") {
      postKey(native, source, "Return", []);
      continue;
    }
    if (character === "\t") {
      postKey(native, source, "Tab", []);
      continue;
    }
    const bytes = Buffer.from(character, "utf16le");
    const units = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    const down = native.cgEventCreateKeyboardEvent(source, 0, true);
    native.cgEventKeyboardSetUnicodeString(down, units.length, units);
    post(native, down);
    const up = native.cgEventCreateKeyboardEvent(source, 0, false);
    post(native, up);
  }
}

function post(native: MacBindings, event: unknown) {
  if (event) native.cgEventPost(HID_EVENT_TAP, event);
}

async function openPath(path: string) {
  await runOpen([path]);
}

async function openApplication(application: string, uri?: string) {
  const flag = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(application) ? "-b" : "-a";
  await runOpen([flag, application, ...(uri ? [uri] : [])]);
}

function runOpen(arguments_: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/open", arguments_, { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

/**
 * The frontmost application window.
 *
 * macOS puts the system chrome on layers of its own, so the frontmost application is the
 * first ordinary window in the list. Window titles are only filled in when the app may
 * read the screen, which it needs anyway to capture it.
 */
function frontmostFromWindowList(native: MacBindings): MacFrontmostWindow | undefined {
  // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements.
  const list = native.cgWindowListCopyWindowInfo(1 | 16, 0);
  if (!list) return undefined;
  try {
    const count = native.cfArrayGetCount(list);
    for (let index = 0; index < count; index += 1) {
      const entry = native.cfArrayGetValueAtIndex(list, index);
      if (dictionaryNumber(native, entry, "kCGWindowLayer") !== 0) continue;
      const owner = copyText(native, dictionaryText(native, entry, "kCGWindowOwnerName"));
      if (!owner) continue;
      const title = copyText(native, dictionaryText(native, entry, "kCGWindowName"));
      const pid = dictionaryNumber(native, entry, "kCGWindowOwnerPID");
      return { id: pid !== undefined ? String(pid) : owner, ...(title ? { title } : {}) };
    }
    return undefined;
  } finally {
    native.cfRelease(list);
  }
}

function copyText(native: MacBindings, value: unknown): string | undefined {
  if (!value) return undefined;
  const length = native.cfStringGetLength(value);
  const buffer = Buffer.alloc(length * 4 + 4);
  if (!native.cfStringGetCString(value, buffer, buffer.length, CF_STRING_ENCODING_UTF8))
    return undefined;
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8");
}

function dictionaryText(native: MacBindings, dictionary: unknown, key: string): unknown {
  const name = native.cfStringCreateWithCString(null, key, CF_STRING_ENCODING_ASCII);
  if (!name) return null;
  try {
    return native.cfDictionaryGetValue(dictionary, name);
  } finally {
    native.cfRelease(name);
  }
}

function dictionaryNumber(
  native: MacBindings,
  dictionary: unknown,
  key: string,
): number | undefined {
  const value = dictionaryText(native, dictionary, key);
  if (!value) return undefined;
  const out = [0];
  // kCFNumberSInt64Type.
  if (!native.cfNumberGetValue(value, 3, out)) return undefined;
  return out[0];
}
