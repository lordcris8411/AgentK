export const AGENT_K_TERMINAL_ACCENT_INDEX = 16;
export const AGENT_K_TERMINAL_ACCENT_FOREGROUND_INDEX = 17;

function colorByte(value: string): number | undefined {
  const percent = value.endsWith("%");
  const parsed = Number(percent ? value.slice(0, -1) : value);
  if (!Number.isFinite(parsed)) return undefined;
  const clamped = Math.max(0, Math.min(percent ? 100 : 255, parsed));
  return Math.round(percent ? (clamped * 255) / 100 : clamped);
}

function opaqueHex(color: string): string | undefined {
  const value = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]+)$/u.exec(value)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4)
      return "#" + [...hex.slice(0, 3)].map((entry) => entry + entry).join("");
    if (hex.length === 6 || hex.length === 8) return "#" + hex.slice(0, 6);
    return undefined;
  }

  const functional = /^rgba?\((.*)\)$/u.exec(value)?.[1];
  if (!functional) return undefined;
  const components = functional
    .split("/", 1)[0]!
    .replaceAll(",", " ")
    .trim()
    .split(/\s+/u)
    .slice(0, 3)
    .map(colorByte);
  if (components.length !== 3 || components.some((entry) => entry === undefined)) return undefined;
  return "#" + components.map((entry) => entry!.toString(16).padStart(2, "0")).join("");
}

/** Set an otherwise unused xterm 256-color slot to the active application
 * accent without overwriting any of the theme's declared ANSI 16 colors. */
export function terminalAccentSequence(
  color: string,
  foregroundColor: string,
): string | undefined {
  const normalized = opaqueHex(color);
  const foreground = opaqueHex(foregroundColor);
  return normalized && foreground
    ? "\x1b]4;" + AGENT_K_TERMINAL_ACCENT_INDEX + ";" + normalized +
      ";" + AGENT_K_TERMINAL_ACCENT_FOREGROUND_INDEX + ";" + foreground + "\x1b\\"
    : undefined;
}
