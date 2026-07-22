interface ResponsiveMonacoEditor {
  getContainerDomNode(): HTMLElement;
  layout(dimension?: { height: number; width: number }): void;
  onDidDispose(listener: () => void): { dispose(): void };
}

interface EditorLayoutRecord {
  editor: ResponsiveMonacoEditor;
  frozenStyle?: {
    contain: string;
    height: string;
    overflow: string;
    transform: string;
    width: string;
    willChange: string;
  };
  height: number;
  host: HTMLElement;
  observer: ResizeObserver | undefined;
  width: number;
}

const editors = new Set<EditorLayoutRecord>();
let layoutFrame: number | undefined;
let panelResizeSuspended = false;

function measure(record: EditorLayoutRecord) {
  record.width = record.host.clientWidth;
  record.height = record.host.clientHeight;
}

function freezeEditorHost(record: EditorLayoutRecord) {
  if (record.frozenStyle) return;
  measure(record);
  record.frozenStyle = {
    contain: record.host.style.contain,
    height: record.host.style.height,
    overflow: record.host.style.overflow,
    transform: record.host.style.transform,
    width: record.host.style.width,
    willChange: record.host.style.willChange,
  };
  record.host.style.width = `${record.width}px`;
  record.host.style.height = `${record.height}px`;
  record.host.style.contain = "strict";
  record.host.style.overflow = "hidden";
  record.host.style.transform = "translate3d(0, 0, 0)";
  record.host.style.willChange = "transform";
}

function releaseEditorHost(record: EditorLayoutRecord) {
  const style = record.frozenStyle;
  if (!style) return;
  record.host.style.contain = style.contain;
  record.host.style.height = style.height;
  record.host.style.overflow = style.overflow;
  record.host.style.transform = style.transform;
  record.host.style.width = style.width;
  record.host.style.willChange = style.willChange;
  record.frozenStyle = undefined;
}

function flushLayouts() {
  layoutFrame = undefined;
  if (panelResizeSuspended) return;
  for (const record of editors) {
    if (record.width < 5 || record.height < 5) measure(record);
    if (record.width >= 5 && record.height >= 5) {
      record.editor.layout({ height: record.height, width: record.width });
    }
  }
}

function scheduleLayouts() {
  if (panelResizeSuspended || layoutFrame !== undefined) return;
  layoutFrame = requestAnimationFrame(flushLayouts);
}

export function registerResponsiveMonacoEditor(
  editor: ResponsiveMonacoEditor,
) {
  // Monaco is mounted into @monaco-editor/react's full-size host element.
  // Observe that host rather than Monaco's own fixed-size root.
  const host = editor.getContainerDomNode().parentElement;
  if (!host) return () => undefined;

  const record: EditorLayoutRecord = {
    editor,
    height: host.clientHeight,
    host,
    observer: undefined,
    width: host.clientWidth,
  };
  record.observer = new ResizeObserver((entries) => {
    const size = entries[0]?.contentRect;
    if (size) {
      record.width = size.width;
      record.height = size.height;
    } else {
      measure(record);
    }
    scheduleLayouts();
  });
  editors.add(record);
  record.observer.observe(host);
  if (panelResizeSuspended) freezeEditorHost(record);
  else scheduleLayouts();

  return () => {
    record.observer?.disconnect();
    releaseEditorHost(record);
    editors.delete(record);
  };
}

export function suspendResponsiveMonacoLayouts() {
  if (panelResizeSuspended) return;
  panelResizeSuspended = true;
  window.dispatchEvent(new CustomEvent("agent-k-editor-layout-suspended", { detail: true }));
  if (layoutFrame !== undefined) {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = undefined;
  }
  for (const record of editors) freezeEditorHost(record);
}

export function resumeResponsiveMonacoLayouts() {
  if (!panelResizeSuspended) return;
  for (const record of editors) releaseEditorHost(record);
  panelResizeSuspended = false;
  window.dispatchEvent(new CustomEvent("agent-k-editor-layout-suspended", { detail: false }));
  for (const record of editors) measure(record);
  scheduleLayouts();
}
