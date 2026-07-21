import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { desktop } from "../../lib/desktop";
import { useSettings } from "../../features/settings/SettingsContext";

type ConsoleLine = { kind: "error" | "output" | "status"; text: string };
const maximumOutputCharacters = 300_000;

export function ProjectConsole({ root, onError }: { root?: string; onError(message: string): void }) {
  const { settings } = useSettings();
  const en = settings.locale === "en-US";
  const [collapsed, setCollapsed] = useState(false);
  const [input, setInput] = useState("");
  const [terminalId, setTerminalId] = useState<string>();
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [height, setHeight] = useState(220);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const outputRef = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ height: number; y: number } | undefined>(undefined);
  const completion = useRef<{ candidates: string[]; index: number } | undefined>(undefined);
  const completionRequest = useRef(0);
  const promptRef = useRef("");
  terminalIdRef.current = terminalId;

  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void desktop.onEvent((event) => {
      const id = typeof event.id === "string" ? event.id : undefined;
      if (!id || id !== terminalIdRef.current) return;
      if (event.type === "project_console_output" && typeof event.text === "string") {
        const text = String(event.text);
        const prompts = text.match(/PS [^\r\n]*> ?/g);
        if (prompts?.length) promptRef.current = prompts[prompts.length - 1]!;
        const kind: ConsoleLine["kind"] = event.stream === "stderr" ? "error" : "output";
        setLines((current) => {
          const next = [...current, { kind, text }];
          let length = 0;
          for (let index = next.length - 1; index >= 0; index -= 1) {
            length += next[index]!.text.length;
            if (length > maximumOutputCharacters) return next.slice(index + 1);
          }
          return next;
        });
      }
      if (event.type === "project_console_exit") {
        setTerminalId(undefined);
        setLines((current) => [...current, { kind: "status", text: "\n[console closed]\n" }]);
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
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [input, lines]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = resizeStart.current;
      if (!start) return;
      setHeight(Math.max(100, Math.min(window.innerHeight - 180, start.height + start.y - event.clientY)));
    };
    const stop = () => {
      resizeStart.current = undefined;
      document.body.classList.remove("is-resizing-console");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, []);
  useEffect(() => {
    setLines([]);
    setInput("");
    setTerminalId(undefined);
    promptRef.current = root ? `PS ${root}> ` : "";
    if (!root) return;
    let disposed = false;
    let createdId: string | undefined;
    void desktop.startProjectConsole(root).then((id) => {
      createdId = id;
      if (disposed) {
        void desktop.stopProjectConsole(id);
        return;
      }
      setTerminalId(id);
    }).catch((cause) => onError(`${en ? "Unable to start console" : "无法启动控制台"}：${String(cause)}`));
    return () => {
      disposed = true;
      if (createdId) void desktop.stopProjectConsole(createdId);
    };
  }, [en, onError, root]);

  const send = (data: string) => {
    const id = terminalIdRef.current;
    if (!id) return;
    void desktop.writeProjectConsole(id, data).catch((cause) => onError(`${en ? "Console input failed" : "控制台输入失败"}：${String(cause)}`));
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      send("\u0003");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (/^(?:cls|clear)$/i.test(input.trim())) {
        setLines(promptRef.current ? [{ kind: "output", text: promptRef.current }] : []);
        setInput("");
        return;
      }
      send(`${input}\r\n`);
      setInput("");
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (!root) return;
      const current = completion.current;
      if (current && current.candidates[current.index] === input) {
        const step = event.shiftKey ? -1 : 1;
        const index = (current.index + step + current.candidates.length) % current.candidates.length;
        completion.current = { ...current, index };
        setInput(current.candidates[index]!);
        return;
      }
      const request = ++completionRequest.current;
      void desktop.completeProjectConsole(root, input).then((matches) => {
        if (request !== completionRequest.current || matches.length === 0) return;
        const legacyStart = Math.max(input.lastIndexOf(" "), input.lastIndexOf("\t")) + 1;
        const candidates = matches.map((match) =>
          typeof match === "string"
            ? input.slice(0, legacyStart) + match
            : input.slice(0, match.replacementIndex) +
              match.text +
              input.slice(match.replacementIndex + match.replacementLength),
        );
        const index = event.shiftKey ? candidates.length - 1 : 0;
        completion.current = { candidates, index };
        setInput(candidates[index]!);
      }).catch((cause) => onError(`${en ? "Console completion failed" : "控制台补全失败"}：${String(cause)}`));
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); setInput(""); return; }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      completion.current = undefined;
      setInput((current) => current + event.key);
    }
  };

  return (
    <section className={collapsed ? "project-console is-collapsed" : "project-console"} style={collapsed ? undefined : { flexBasis: height }}>
      {!collapsed ? <div
        aria-label={en ? "Resize console" : "调整控制台高度"}
        className="project-console-resizer"
        onPointerDown={(event) => {
          event.preventDefault();
          resizeStart.current = { height, y: event.clientY };
          document.body.classList.add("is-resizing-console");
        }}
        role="separator"
      /> : null}
      <header>
        <span><i aria-hidden="true" className="fa-solid fa-terminal" /> {en ? "Console" : "控制台"}</span>
        <small title={root}>{root ?? (en ? "No project selected" : "未选择项目")}</small>
        <button aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)} title={collapsed ? (en ? "Show console" : "显示控制台") : (en ? "Hide console" : "隐藏控制台")} type="button"><i aria-hidden="true" className={`fa-solid fa-chevron-${collapsed ? "up" : "down"}`} /></button>
      </header>
      {!collapsed ? <div aria-label={en ? "Project terminal" : "项目终端"} className="project-console-output" onClick={() => outputRef.current?.focus()} onKeyDown={keyDown} ref={outputRef} role="textbox" tabIndex={0}>
        {lines.length ? lines.map((line, index) => <span className={`is-${line.kind}`} key={index}>{line.text}</span>) : <span className="is-status">{terminalId ? "" : (en ? "Starting shell…\n" : "正在启动 shell…\n")}</span>}
        {terminalId ? <span className="project-console-input">{input}<i aria-label={en ? "Cursor" : "光标"} /></span> : null}
      </div> : null}
    </section>
  );
}
