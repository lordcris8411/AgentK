export const LEFT_PANEL_MINIMUM = 240;
export const RIGHT_PANEL_MINIMUM = 420;
export const WORKSPACE_MINIMUM = 700;
export const RESIZERS_WIDTH = 12;

export interface PanelWidths {
  left: number;
  right: number;
}

function finiteWidth(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

export function fitPanelWidths(
  windowWidth: number,
  requestedLeft: number,
  requestedRight: number,
): PanelWidths {
  const available = Math.max(
    LEFT_PANEL_MINIMUM + RIGHT_PANEL_MINIMUM,
    finiteWidth(windowWidth, WORKSPACE_MINIMUM + RESIZERS_WIDTH) -
      WORKSPACE_MINIMUM -
      RESIZERS_WIDTH,
  );
  const left = Math.max(
    LEFT_PANEL_MINIMUM,
    Math.min(
      available - RIGHT_PANEL_MINIMUM,
      finiteWidth(requestedLeft, LEFT_PANEL_MINIMUM),
    ),
  );
  const right = Math.max(
    RIGHT_PANEL_MINIMUM,
    Math.min(
      available - left,
      finiteWidth(requestedRight, RIGHT_PANEL_MINIMUM),
    ),
  );
  return { left, right };
}
