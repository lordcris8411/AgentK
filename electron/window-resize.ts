import type { Rectangle } from "electron";

export type ResizeDirection =
  | "East" | "North" | "NorthEast" | "NorthWest"
  | "South" | "SouthEast" | "SouthWest" | "West";

export function usesManualWindowResize(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  ozonePlatform = "",
  ozonePlatformHint = "",
): boolean {
  if (platform !== "linux") return true;
  const requested = (ozonePlatform || ozonePlatformHint).toLocaleLowerCase("en-US");
  if (requested === "x11") return true;
  if (requested === "wayland") return false;
  return environment.XDG_SESSION_TYPE?.toLocaleLowerCase("en-US") !== "wayland" &&
    !environment.WAYLAND_DISPLAY;
}

export function resizedWindowBounds(
  start: Rectangle,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  minimumWidth: number,
  minimumHeight: number,
): Rectangle {
  const next = { ...start };
  if (direction.includes("East")) next.width = start.width + dx;
  if (direction.includes("South")) next.height = start.height + dy;
  if (direction.includes("West")) {
    next.x = start.x + dx;
    next.width = start.width - dx;
  }
  if (direction.includes("North")) {
    next.y = start.y + dy;
    next.height = start.height - dy;
  }
  if (next.width < minimumWidth) {
    if (direction.includes("West")) next.x -= minimumWidth - next.width;
    next.width = minimumWidth;
  }
  if (next.height < minimumHeight) {
    if (direction.includes("North")) next.y -= minimumHeight - next.height;
    next.height = minimumHeight;
  }
  return next;
}
