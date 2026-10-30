/**
 * macOS virtual keycodes and modifier flags.
 *
 * Keycodes describe a position on the keyboard, not a character, so a named key is the
 * only kind of key this table can name. Anything printable is typed as text instead,
 * which works on every keyboard layout.
 */

/** kCGEventFlagMask* values. */
export const MAC_MODIFIER_FLAGS = {
  shift: 0x0002_0000,
  control: 0x0004_0000,
  alternate: 0x0008_0000,
  command: 0x0010_0000,
  help: 0x0040_0000,
} as const;

/** Modifier names as tools and the server's computer tools spell them. */
const MODIFIER_FLAGS: Readonly<Record<string, number>> = {
  alt: MAC_MODIFIER_FLAGS.alternate,
  cmd: MAC_MODIFIER_FLAGS.command,
  command: MAC_MODIFIER_FLAGS.command,
  control: MAC_MODIFIER_FLAGS.control,
  ctrl: MAC_MODIFIER_FLAGS.control,
  fn: MAC_MODIFIER_FLAGS.help,
  function: MAC_MODIFIER_FLAGS.help,
  meta: MAC_MODIFIER_FLAGS.alternate,
  option: MAC_MODIFIER_FLAGS.alternate,
  shift: MAC_MODIFIER_FLAGS.shift,
  super: MAC_MODIFIER_FLAGS.command,
  "⌘": MAC_MODIFIER_FLAGS.command,
};

/**
 * Named keys, by their X11 keysym names with the usual aliases. macOS calls the backspace
 * key "delete" and the forward delete key "forward delete", the other way round from X11.
 */
const VIRTUAL_KEYCODES: Readonly<Record<string, number>> = {
  backspace: 51,
  capslock: 57,
  command: 55,
  delete: 117,
  down: 125,
  end: 119,
  enter: 36,
  escape: 53,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  f13: 105,
  f14: 107,
  f15: 113,
  f16: 106,
  f17: 64,
  f18: 79,
  f19: 80,
  f20: 90,
  forwarddelete: 117,
  help: 114,
  home: 115,
  insert: 114,
  left: 123,
  option: 58,
  pagedown: 121,
  pageup: 116,
  prior: 116,
  next: 121,
  return: 36,
  right: 124,
  shift: 56,
  space: 49,
  tab: 48,
  up: 126,
};

/** The virtual keycode of a named key, or undefined when the name is a character. */
export function macVirtualKeycode(key: string): number | undefined {
  const name = key.trim().toLowerCase();
  if (!name) return undefined;
  if (VIRTUAL_KEYCODES[name] !== undefined) return VIRTUAL_KEYCODES[name];
  if (name === "esc") return VIRTUAL_KEYCODES.escape;
  if (name === "del") return VIRTUAL_KEYCODES.delete;
  return undefined;
}

/** The modifier flags for a list of modifier names. Unknown names are ignored. */
export function macModifierFlags(modifiers: readonly string[]): number {
  let flags = 0;
  for (const modifier of modifiers) {
    flags |= MODIFIER_FLAGS[modifier.trim().toLowerCase()] ?? 0;
  }
  return flags;
}
