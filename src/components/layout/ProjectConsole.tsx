import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { desktop } from "../../lib/desktop";
import { useSettings } from "../../features/settings/SettingsContext";

function terminalTheme(dark: boolean): ITheme {
  return dark
    ? {
        background: "#242321",
        foreground: "#dedad4",
        cursor: "#dedad4",
        cursorAccent: "#242321",
        selectionBackground: "#69533f",
        black: "#242321",
        red: "#d17a6d",
        green: "#8fb573",
        yellow: "#d5ad68",
        blue: "#75a9c7",
        magenta: "#b998c5",
        cyan: "#72b8ad",
        white: "#dedad4",
        brightBlack: "#817b73",
        brightRed: "#eb9184",
        brightGreen: "#a8cc8d",
        brightYellow: "#ebc47c",
        brightBlue: "#8dc3e0",
        brightMagenta: "#d0addb",
        brightCyan: "#8ed0c5",
        brightWhite: "#fffdf9",
      }
    : {
        background: "#fffdf9",
        foreground: "#302d2a",
        cursor: "#302d2a",
        cursorAccent: "#fffdf9",
        selectionBackground: "#d9c3ae",
        black: "#302d2a",
        red: "#a73e32",
        green: "#557d3e",
        yellow: "#936a20",
        blue: "#316e92",
        magenta: "#795388",
        cyan: "#27796f",
        white: "#e7e2dc",
        brightBlack: "#77716a",
        brightRed: "#c45548",
        brightGreen: "#6d974f",
        brightYellow: "#ad8132",
        brightBlue: "#4488af",
        brightMagenta: "#9369a3",
        brightCyan: "#38958a",
        brightWhite: "#ffffff",
      };
}

export function ProjectConsole({ root, onError }: { root?: string; onError(message: string): void }) {
  const { resolvedTheme, settings } = useSettings();
  const en = settings.locale === "en-US";
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(220);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitAddonRef = useRef<FitAddon | undefined>(undefined);
  const enRef = useRef(en);
  const onErrorRef = useRef(onError);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const pendingOutputRef = useRef(new Map<string, string>());
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const resizeStart = useRef<{
    element: HTMLElement;
    height: number;
    pointerId: number;
    y: number;
  } | undefined>(undefined);
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | undefined>(undefined);
  enRef.current = en;
  onErrorRef.current = onError;

  const fitTerminal = useCallback(() => {
    if (resizeFrameRef.current !== undefined) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = undefined;
      const host = terminalHostRef.current;
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!host || !terminal || !fitAddon || host.clientWidth < 2 || host.clientHeight < 2)
        return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const dimensions = { cols: terminal.cols, rows: terminal.rows };
      const previous = lastDimensionsRef.current;
      lastDimensionsRef.current = dimensions;
      const id = terminalIdRef.current;
      if (id && (previous?.cols !== dimensions.cols || previous.rows !== dimensions.rows))
        void desktop.resizeProjectConsole(id, dimensions.cols, dimensions.rows).catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: terminalTheme(resolvedTheme === "dark"),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const dataSubscription = terminal.onData((data) => {
      const id = terminalIdRef.current;
      if (!id) return;
      void desktop.writeProjectConsole(id, data).catch((cause) =>
        onErrorRef.current(`${enRef.current ? "Console input failed" : "控制台输入失败"}：${String(cause)}`),
      );
    });
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(host);
    fitTerminal();
    return () => {
      observer.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = undefined;
      fitAddonRef.current = undefined;
      if (resizeFrameRef.current !== undefined) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = undefined;
      }
    };
  }, [fitTerminal]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalTheme(resolvedTheme === "dark");
  }, [resolvedTheme]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void desktop.onEvent((event) => {
      const id = typeof event.id === "string" ? event.id : undefined;
      if (!id) return;
      if (event.type === "project_console_output" && typeof event.data === "string") {
        if (id === terminalIdRef.current) terminalRef.current?.write(event.data);
        else {
          const pending = `${pendingOutputRef.current.get(id) ?? ""}${event.data}`;
          pendingOutputRef.current.set(id, pending.slice(-300_000));
        }
      }
      if (event.type === "project_console_exit") {
        pendingOutputRef.current.delete(id);
        if (id !== terminalIdRef.current) return;
        terminalIdRef.current = undefined;
        const code = typeof event.code === "number" ? event.code : undefined;
        terminalRef.current?.write(
          `\r\n\x1b[90m[${enRef.current ? "process exited" : "进程已退出"}${code === undefined ? "" : `: ${code}`}]\x1b[0m\r\n`,
        );
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    terminal?.reset();
    terminal?.clear();
    terminalIdRef.current = undefined;
    lastDimensionsRef.current = undefined;
    if (!root || !terminal) return;
    let disposed = false;
    let createdId: string | undefined;
    void desktop.startProjectConsole(root, terminal.cols, terminal.rows).then((id) => {
      createdId = id;
      if (disposed) {
        pendingOutputRef.current.delete(id);
        void desktop.stopProjectConsole(id);
        return;
      }
      terminalIdRef.current = id;
      const pending = pendingOutputRef.current.get(id);
      pendingOutputRef.current.delete(id);
      if (pending) terminal.write(pending);
      lastDimensionsRef.current = { cols: terminal.cols, rows: terminal.rows };
      terminal.focus();
      fitTerminal();
    }).catch((cause) => {
      const message = `${enRef.current ? "Unable to start console" : "无法启动控制台"}：${String(cause)}`;
      terminal.writeln(`\x1b[31m${message}\x1b[0m`);
      onErrorRef.current(message);
    });
    return () => {
      disposed = true;
      terminalIdRef.current = undefined;
      if (createdId) {
        pendingOutputRef.current.delete(createdId);
        void desktop.stopProjectConsole(createdId);
      }
    };
  }, [fitTerminal, root]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = resizeStart.current;
      if (!start || event.pointerId !== start.pointerId) return;
      event.preventDefault();
      setHeight(Math.max(100, Math.min(window.innerHeight - 180, start.height + start.y - event.clientY)));
    };
    const stop = (event?: PointerEvent) => {
      const start = resizeStart.current;
      if (!start || (event && event.pointerId !== start.pointerId)) return;
      resizeStart.current = undefined;
      if (start.element.hasPointerCapture(start.pointerId))
        start.element.releasePointerCapture(start.pointerId);
      document.body.classList.remove("is-resizing-console");
      fitTerminal();
    };
    const cancel = () => stop();
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [fitTerminal]);

  useEffect(() => {
    fitTerminal();
  }, [collapsed, fitTerminal, height]);

  return (
    <section className={collapsed ? "project-console is-collapsed" : "project-console"} style={collapsed ? undefined : { flexBasis: height }}>
      {!collapsed ? <div
        aria-label={en ? "Resize console" : "调整控制台高度"}
        className="project-console-resizer"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const element = event.currentTarget;
          element.setPointerCapture(event.pointerId);
          resizeStart.current = {
            element,
            height,
            pointerId: event.pointerId,
            y: event.clientY,
          };
          document.body.classList.add("is-resizing-console");
        }}
        role="separator"
      /> : null}
      <header>
        <span><i aria-hidden="true" className="fa-solid fa-terminal" /> {en ? "Terminal" : "终端"}</span>
        <small title={root}>{root ?? (en ? "No project selected" : "未选择项目")}</small>
        <button
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? (en ? "Show terminal" : "显示终端") : (en ? "Hide terminal" : "隐藏终端")}
          type="button"
        >
          <i aria-hidden="true" className={`fa-solid fa-chevron-${collapsed ? "up" : "down"}`} />
        </button>
      </header>
      <div
        aria-label={en ? "Project terminal" : "项目终端"}
        className="project-console-terminal"
        onMouseDown={() => terminalRef.current?.focus()}
        ref={terminalHostRef}
      />
    </section>
  );
}
