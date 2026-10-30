import { nativeImage } from "electron";

/**
 * The menu bar dot, as a template image so macOS tints it to match the menu bar.
 *
 * A 32px dot, drawn in code rather than shipped as a file, so the status item needs no
 * build asset and stays a single ink circle at any scale.
 */
const DOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAeElEQVR4nO2V0QnAIAxEncTpukzmyzb+tBEiSKmCJXK03IP7EeHORGNKhBDyQbJJTGoqLvW1vNv8cMNzoOJ7tpmPjO8KD1FLOzv5UyVC2yEL5k0SGUBfBNDIACvl79vwnwDwFsAvIfwZVqCDqA8BG8UN6GdECCHhXLL5mhUl8QdSAAAAAElFTkSuQmCC";

export function taskTrayIcon() {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${DOT_PNG}`);
  if (process.platform !== "darwin") return icon;
  // A template image follows the menu bar's own contrast, in light and dark alike.
  const template = icon.resize({ width: 16, height: 16 });
  template.setTemplateImage(true);
  return template;
}
