import { describe, expect, it } from "vitest";
import { macModifierFlags, macVirtualKeycode } from "./macos-keys.js";

describe("macos keys", () => {
  it("names the keys a desktop tool can press", () => {
    expect(macVirtualKeycode("Return")).toBe(36);
    expect(macVirtualKeycode("enter")).toBe(36);
    expect(macVirtualKeycode("Tab")).toBe(48);
    expect(macVirtualKeycode("space")).toBe(49);
    expect(macVirtualKeycode("BackSpace")).toBe(51);
    expect(macVirtualKeycode("Escape")).toBe(53);
    expect(macVirtualKeycode("esc")).toBe(53);
    expect(macVirtualKeycode("Delete")).toBe(117);
    expect(macVirtualKeycode("del")).toBe(117);
    expect(macVirtualKeycode("Left")).toBe(123);
    expect(macVirtualKeycode("Right")).toBe(124);
    expect(macVirtualKeycode("Down")).toBe(125);
    expect(macVirtualKeycode("Up")).toBe(126);
    expect(macVirtualKeycode("F5")).toBe(96);
    expect(macVirtualKeycode("F12")).toBe(111);
  });

  it("leaves a printable character to the text path", () => {
    expect(macVirtualKeycode("a")).toBeUndefined();
    expect(macVirtualKeycode("好")).toBeUndefined();
    expect(macVirtualKeycode("")).toBeUndefined();
  });

  it("maps the modifier names a desktop tool sends", () => {
    expect(macModifierFlags(["cmd"])).toBe(macModifierFlags(["command"]));
    expect(macModifierFlags(["ctrl", "shift"])).toBe(
      macModifierFlags(["control"]) | macModifierFlags(["shift"]),
    );
    expect(macModifierFlags(["option"])).toBe(macModifierFlags(["alt"]));
    expect(macModifierFlags(["nonsense"])).toBe(0);
    expect(macModifierFlags([])).toBe(0);
  });
});
