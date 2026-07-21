type ScrollAxis = "x" | "y";

interface DampedScrollState {
  frame?: number;
  targetX: number;
  targetY: number;
}

const DAMPING = 0.24;
const FINISH_DISTANCE = 0.5;
const MAX_QUEUED_DISTANCE = 1200;
let cancelElementAnimation: ((element: HTMLElement) => void) | undefined;

export function stopDampedScrolling(element: HTMLElement) {
  cancelElementAnimation?.(element);
}

function maximumScroll(element: HTMLElement, axis: ScrollAxis) {
  return axis === "x"
    ? Math.max(0, element.scrollWidth - element.clientWidth)
    : Math.max(0, element.scrollHeight - element.clientHeight);
}

function currentScroll(element: HTMLElement, axis: ScrollAxis) {
  return axis === "x" ? element.scrollLeft : element.scrollTop;
}

function canScroll(element: HTMLElement, axis: ScrollAxis, delta: number) {
  const maximum = maximumScroll(element, axis);
  if (maximum <= 1) return false;
  const overflow = getComputedStyle(element)[
    axis === "x" ? "overflowX" : "overflowY"
  ];
  if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay")
    return false;
  const current = currentScroll(element, axis);
  return delta < 0 ? current > 0 : current < maximum;
}

function findScrollContainer(
  event: WheelEvent,
  axis: ScrollAxis,
  delta: number,
) {
  for (const entry of event.composedPath()) {
    if (!(entry instanceof HTMLElement)) continue;
    if (canScroll(entry, axis, delta)) return entry;
  }
  return undefined;
}

function normalizedDelta(event: WheelEvent, axis: ScrollAxis) {
  const raw = axis === "x" ? event.deltaX : event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return raw * 36;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE)
    return raw * window.innerHeight * 0.85;
  return raw;
}

/**
 * Adds one damped wheel animation shared by every ordinary scroll container.
 * Controls with their own wheel semantics can opt out with data-native-wheel.
 */
export function installDampedWheelScrolling() {
  const states = new WeakMap<HTMLElement, DampedScrollState>();
  const activeElements = new Set<HTMLElement>();
  const stopElement = (element: HTMLElement) => {
    const state = states.get(element);
    if (!state) return;
    if (state.frame !== undefined) cancelAnimationFrame(state.frame);
    state.frame = undefined;
    state.targetX = element.scrollLeft;
    state.targetY = element.scrollTop;
    activeElements.delete(element);
  };
  const stopAll = () => {
    for (const element of [...activeElements]) stopElement(element);
  };
  cancelElementAnimation = stopElement;

  const animate = (element: HTMLElement, state: DampedScrollState) => {
    const maximumX = maximumScroll(element, "x");
    const maximumY = maximumScroll(element, "y");
    state.targetX = Math.min(maximumX, Math.max(0, state.targetX));
    state.targetY = Math.min(maximumY, Math.max(0, state.targetY));

    const distanceX = state.targetX - element.scrollLeft;
    const distanceY = state.targetY - element.scrollTop;
    const doneX = Math.abs(distanceX) < FINISH_DISTANCE;
    const doneY = Math.abs(distanceY) < FINISH_DISTANCE;
    element.scrollLeft = doneX
      ? state.targetX
      : element.scrollLeft + distanceX * DAMPING;
    element.scrollTop = doneY
      ? state.targetY
      : element.scrollTop + distanceY * DAMPING;

    if (doneX && doneY) {
      state.frame = undefined;
      activeElements.delete(element);
      return;
    }
    state.frame = requestAnimationFrame(() => animate(element, state));
  };

  const queue = (element: HTMLElement, axis: ScrollAxis, delta: number) => {
    let state = states.get(element);
    if (!state) {
      state = {
        targetX: element.scrollLeft,
        targetY: element.scrollTop,
      };
      states.set(element, state);
    }
    if (state.frame === undefined) {
      state.targetX = element.scrollLeft;
      state.targetY = element.scrollTop;
    }

    const current = currentScroll(element, axis);
    const maximum = maximumScroll(element, axis);
    const previousTarget = axis === "x" ? state.targetX : state.targetY;
    const nextTarget = Math.min(
      maximum,
      Math.max(
        0,
        Math.min(
          current + MAX_QUEUED_DISTANCE,
          Math.max(current - MAX_QUEUED_DISTANCE, previousTarget + delta),
        ),
      ),
    );
    if (nextTarget === previousTarget) return false;
    if (axis === "x") state.targetX = nextTarget;
    else state.targetY = nextTarget;

    if (state.frame === undefined) {
      activeElements.add(element);
      state.frame = requestAnimationFrame(() => animate(element, state));
    }
    return true;
  };

  const onWheel = (event: WheelEvent) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".monaco-editor, [data-native-wheel]")
    )
      return;

    let deltaX = normalizedDelta(event, "x");
    let deltaY = normalizedDelta(event, "y");
    if (event.shiftKey && deltaX === 0) {
      deltaX = deltaY;
      deltaY = 0;
    }

    let handled = false;
    if (deltaY !== 0) {
      const vertical = findScrollContainer(event, "y", deltaY);
      if (vertical) handled = queue(vertical, "y", deltaY) || handled;
    }
    if (deltaX !== 0) {
      const horizontal = findScrollContainer(event, "x", deltaX);
      if (horizontal) handled = queue(horizontal, "x", deltaX) || handled;
    }
    if (handled) event.preventDefault();
  };

  window.addEventListener("wheel", onWheel, { passive: false });
  // Pointer navigation, scrollbar dragging and buttons that scroll to a
  // specific item should take control immediately instead of competing with
  // momentum left by the last wheel event.
  window.addEventListener("pointerdown", stopAll);
  return () => {
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("pointerdown", stopAll);
    stopAll();
    if (cancelElementAnimation === stopElement)
      cancelElementAnimation = undefined;
  };
}
