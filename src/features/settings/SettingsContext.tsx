import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { desktop, type ClientSettings } from "../../lib/desktop";

export type Locale = "zh-CN" | "en-US";
export type ThemeMode = "light" | "dark" | "system";

const fallback: ClientSettings = {
  version: 7,
  theme: "light",
  locale: "zh-CN",
  permissionMode: "ask",
  browserId: "default",
  piExecutable: "",
  workerPoolSize: 4,
  autoCompactEnabled: true,
  autoCompactThreshold: 45,
  autoCompactPrompt: "",
  editorWordWrap: false,
  disabledFileEditors: [],
  disabledFileEditorSkills: [],
  leftPanelWidth: 304,
  rightPanelWidth: 420,
  leftPanelHidden: false,
  rightPanelHidden: false,
  windowWidth: 1600,
  windowHeight: 920,
  windowMaximized: false,
};

const dictionaries = {
  "zh-CN": {
    settings: "设置",
    addWorkspace: "添加工作区",
    workspaces: "工作区",
    localPi: "本地 Pi RPC",
    connected: "已连接",
    running: "正在运行",
    models: "模型与 Provider",
    appearance: "外观与语言",
    agentSettings: "Agent 设置",
    skills: "Skills",
    extensions: "Extensions",
    editors: "Editor 扩展",
    permissions: "运行权限",
    about: "关于",
    close: "关闭",
    light: "白天模式",
    dark: "黑夜模式",
    systemTheme: "跟随系统",
    language: "界面语言",
    browser: "打开链接的浏览器",
    piExecutable: "Pi 可执行文件路径",
    piExecutableDescription: "留空时依次使用环境变量、系统 PATH 中的 Pi，最后使用内置 Pi。修改后重启 Agent K 生效。",
    piExecutablePlaceholder: "自动检测（推荐）",
    workerPoolSize: "常驻 Pi 进程",
    workerPoolDescription: "保持 2–4 个 Pi 进程待命；忙时会自动扩容，空闲后回收到此数量。",
    autoCompact: "自动整理上下文",
    autoCompactDescription: "在模型上下文达到设定比例后，将较早的对话整理为摘要，并保留近期工作。",
    autoCompactThreshold: "触发比例",
    autoCompactPrompt: "整理附加提示词",
    autoCompactPromptPlaceholder: "例如：保留已完成的功能、待办事项、关键文件路径和验证结果。",
    defaultBrowser: "系统默认浏览器",
    chinese: "中文",
    english: "English",
    permissionAsk: "执行前确认",
    permissionSession: "本次 session 不提醒",
    permissionFull: "完全访问",
    permissionDescription: "控制 Agent K 执行命令和修改文件前是否需要确认。",
    currentModel: "当前模型",
    thinking: "思考级别",
    providerAdd: "添加 Provider",
    localAdd: "添加本地模型",
    localService: "本地服务类型",
    refresh: "刷新",
    configured: "已配置",
    notConfigured: "未配置",
    login: "登录",
    logout: "退出登录",
    apiKey: "API Key",
    oauth: "OAuth",
    loginTerminalOpened: "已打开官方 Pi 登录终端。请在终端中输入以下命令，完成后回到此处点击刷新：",
    save: "保存",
    revertFile: "撤销",
    markdownPreview: "预览",
    markdownEdit: "编辑",
    cancel: "取消",
    delete: "删除",
    renameSession: "重命名会话",
    deleteSession: "删除会话",
    copySession: "复制会话",
    copySessionId: "复制 Session ID",
    openFolder: "打开文件夹",
    sessionName: "会话名称",
    deleteSessionConfirm: "确定要将这个会话移入系统回收站吗？",
    openInBrowser: "在浏览器中打开",
    notifications: "通知",
    notificationHistory: "通知历史",
    noNotifications: "暂无通知",
    clearNotifications: "清除全部通知",
    read: "已读",
    unread: "未读",
    test: "测试连接",
    discover: "发现模型",
    modelId: "模型 ID",
    providerId: "Provider ID",
    displayName: "显示名称",
    baseUrl: "Base URL",
    apiProtocol: "API 协议",
    contextWindow: "上下文窗口",
    maxTokens: "最大输出 Token",
    reasoning: "支持思考",
    imageInput: "支持图片输入",
    noProviders: "请在 Pi CLI 中配置和登录 Provider，然后刷新模型列表。",
    appVersion: "应用版本",
    piVersion: "Pi 版本",
    systemInfo: "系统信息",
    copyDiagnostics: "复制诊断信息",
    projectHomepage: "Pi 项目主页",
    licenses: "开源许可证",
    askPermissionTitle: "Agent K 运行权限",
    deny: "拒绝",
    allowOnce: "仅允许本次",
    allowSession: "本次 session 不再提醒",
    fullAccess: "完全访问",
    no: "否",
    confirm: "确认",
    submit: "提交",
    commands: "命令",
    extensionCommand: "扩展",
    promptCommand: "提示模板",
    skillCommand: "技能",
    builtinCommand: "Agent K",
    resourceDescription: "启用或停用 Pi 资源。关闭设置后会统一应用改动并重新加载空闲的 Pi 运行时。",
    filePlugin: "Editor",
    piSkill: "Pi Skill",
    filePluginDependency: "关闭 Editor 扩展时会同时关闭配套 Pi Skill；开启 Pi Skill 时会同时开启 Editor 扩展。",
    editorManagerDescription: "按文件品类分别管理 Agent K 的 Editor，以及向 Pi 暴露的 Editor Skill。",
    editorHost: "Editor",
    editorSkill: "Editor Skill",
    builtinEditors: "第一方 Editors",
    builtinEditorsDescription: "来自安装目录 editor/extensions。每个品类均可独立开关；关闭 Editor 会同时关闭该品类的 Editor Skill。",
    installedEditors: "已安装的 Editor 扩展",
    noEditorExtensions: "没有发现包含 SKILL.md 与 editor.json 的第三方 Editor 扩展。",
    builtIn: "第一方",
    noResources: "没有发现此类资源。",
    resourcesLocked: "有 Pi 进程正在工作。Skills、Extensions 和 Editors 将在所有进程空闲后恢复操作。",
    userScope: "用户",
    projectScope: "项目",
    noMatchingCommands: "没有匹配的命令",
    loadingCommands: "正在读取命令…",
    skillHub: "Skill Hub",
    skillHubDescription: "粘贴 skills.sh 的安装命令或 GitHub 来源；Agent K 解析后先完整预览，再安装到 Pi。",
    skillHubUrl: "skills.sh 安装命令或 GitHub 来源",
    skillHubUrlPlaceholder: "npx skills add owner/repo@skill-name",
    skillHubPreview: "预览",
    skillHubSafety: "不会执行 npx 或下载脚本。Agent K 仅解析 GitHub 来源，安装前列出全部文件并复核内容哈希。",
    skillHubFeatured: "精选来源",
    skillHubReview: "审阅 Skill",
    skillHubInstallScope: "安装位置",
    skillHubFiles: "个文件",
    skillHubContent: "SKILL.md 内容",
    skillHubInstall: "确认安装",
    skillHubInstalled: "Skill 已安装，并已重新加载 Pi 运行时。",
    skillDetails: "详情",
    skillDescriptionLabel: "描述",
    noSkillDescription: "该 Skill 未声明描述。",
    skillScopeLabel: "范围",
    skillPathLabel: "路径",
  },
  "en-US": {
    settings: "Settings",
    addWorkspace: "Add workspace",
    workspaces: "Workspaces",
    localPi: "Local Pi RPC",
    connected: "Connected",
    running: "Running",
    models: "Models & Providers",
    appearance: "Appearance & Language",
    agentSettings: "Agent Settings",
    skills: "Skills",
    extensions: "Extensions",
    editors: "Editor Extensions",
    permissions: "Execution permissions",
    about: "About",
    close: "Close",
    light: "Light",
    dark: "Dark",
    systemTheme: "System",
    language: "Interface language",
    browser: "Browser for links",
    piExecutable: "Pi executable path",
    piExecutableDescription: "When empty, Agent K uses the environment variable, Pi on PATH, then the bundled Pi. Restart Agent K after changing it.",
    piExecutablePlaceholder: "Auto-detect (recommended)",
    workerPoolSize: "Warm Pi processes",
    workerPoolDescription: "Keep 2–4 Pi processes ready. The pool grows while busy and returns to this size when idle.",
    autoCompact: "Automatic context compaction",
    autoCompactDescription: "When the configured share of the model context is used, summarize older work and retain recent context.",
    autoCompactThreshold: "Trigger threshold",
    autoCompactPrompt: "Additional summary instructions",
    autoCompactPromptPlaceholder: "For example: retain completed work, open tasks, key paths, and verification results.",
    defaultBrowser: "System default browser",
    chinese: "中文",
    english: "English",
    permissionAsk: "Ask before running",
    permissionSession: "Allow for this session",
    permissionFull: "Full access",
    permissionDescription: "Choose whether Agent K asks before running commands or changing files.",
    currentModel: "Current model",
    thinking: "Thinking level",
    providerAdd: "Add provider",
    localAdd: "Add local model",
    localService: "Local service type",
    refresh: "Refresh",
    configured: "Configured",
    notConfigured: "Not configured",
    login: "Sign in",
    logout: "Sign out",
    apiKey: "API key",
    oauth: "OAuth",
    loginTerminalOpened: "The official Pi login terminal is open. Enter this command there, then return and refresh:",
    save: "Save",
    revertFile: "Revert",
    markdownPreview: "Preview",
    markdownEdit: "Edit",
    cancel: "Cancel",
    delete: "Delete",
    renameSession: "Rename session",
    deleteSession: "Delete session",
    copySession: "Duplicate session",
    copySessionId: "Copy session ID",
    openFolder: "Open folder",
    sessionName: "Session name",
    deleteSessionConfirm: "Move this session to the system Recycle Bin?",
    openInBrowser: "Open in browser",
    notifications: "Notifications",
    notificationHistory: "Notification history",
    noNotifications: "No notifications yet",
    clearNotifications: "Clear all notifications",
    read: "Read",
    unread: "Unread",
    test: "Test connection",
    discover: "Discover models",
    modelId: "Model ID",
    providerId: "Provider ID",
    displayName: "Display name",
    baseUrl: "Base URL",
    apiProtocol: "API protocol",
    contextWindow: "Context window",
    maxTokens: "Max output tokens",
    reasoning: "Reasoning model",
    imageInput: "Image input",
    noProviders: "Configure and sign in to providers with the Pi CLI, then refresh the model list.",
    appVersion: "App version",
    piVersion: "Pi version",
    systemInfo: "System information",
    copyDiagnostics: "Copy diagnostics",
    projectHomepage: "Pi project homepage",
    licenses: "Open-source licenses",
    askPermissionTitle: "Agent K permission",
    deny: "Deny",
    allowOnce: "Allow once",
    allowSession: "Allow for this session",
    fullAccess: "Full access",
    no: "No",
    confirm: "Confirm",
    submit: "Submit",
    commands: "Commands",
    extensionCommand: "Extension",
    promptCommand: "Prompt template",
    skillCommand: "Skill",
    builtinCommand: "Agent K",
    resourceDescription: "Enable or disable Pi resources. Changes are applied together when Settings closes.",
    filePlugin: "Editor",
    piSkill: "Pi Skill",
    filePluginDependency: "Disabling an Editor extension also disables its Pi Skill; enabling the Pi Skill also enables its Editor extension.",
    editorManagerDescription: "Manage Agent K Editors and the Editor Skills exposed to Pi independently for each file category.",
    editorHost: "Editor",
    editorSkill: "Editor Skill",
    builtinEditors: "First-party Editors",
    builtinEditorsDescription: "Loaded from editor/extensions in the installation directory. Each category has independent Editor and Editor Skill controls.",
    installedEditors: "Installed Editor extensions",
    noEditorExtensions: "No third-party Editor extension containing SKILL.md and editor.json was found.",
    builtIn: "First-party",
    noResources: "No resources of this type were discovered.",
    resourcesLocked: "A Pi process is working. Skills, Extensions, and Editors unlock when every process is idle.",
    userScope: "User",
    projectScope: "Project",
    noMatchingCommands: "No matching commands",
    loadingCommands: "Loading commands…",
    skillHub: "Skill Hub",
    skillHubDescription: "Paste a skills.sh install command or GitHub source. Agent K resolves it, previews everything, then installs it for Pi.",
    skillHubUrl: "skills.sh command or GitHub source",
    skillHubUrlPlaceholder: "npx skills add owner/repo@skill-name",
    skillHubPreview: "Preview",
    skillHubSafety: "Agent K never runs npx or downloaded scripts. It resolves the GitHub source, lists every file, and verifies the reviewed hash before install.",
    skillHubFeatured: "Featured",
    skillHubReview: "Review Skill",
    skillHubInstallScope: "Install location",
    skillHubFiles: "files",
    skillHubContent: "SKILL.md contents",
    skillHubInstall: "Install",
    skillHubInstalled: "Skill installed and Pi runtimes reloaded.",
    skillDetails: "Details",
    skillDescriptionLabel: "Description",
    noSkillDescription: "This skill does not declare a description.",
    skillScopeLabel: "Scope",
    skillPathLabel: "Path",
  },
} as const;

type SettingsContextValue = {
  settings: ClientSettings;
  resolvedTheme: "light" | "dark";
  ready: boolean;
  update(patch: Partial<ClientSettings>): Promise<void>;
  t: (key: keyof (typeof dictionaries)["zh-CN"]) => string;
};

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

function applyTheme(locale: Locale, theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.lang = locale;
  window.dispatchEvent(new CustomEvent("agent-k-theme", { detail: theme }));
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ClientSettings>(() => {
    const cached = localStorage.getItem("agent-k-settings");
    try {
      return cached ? { ...fallback, ...JSON.parse(cached) } : fallback;
    } catch {
      return fallback;
    }
  });
  const [ready, setReady] = useState(false);
  const settingsRef = useRef(settings);
  const settingsRevision = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolvedTheme =
    settings.theme === "system"
      ? systemDark
        ? "dark"
        : "light"
      : settings.theme;
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    applyTheme(settings.locale, resolvedTheme);
  }, [resolvedTheme, settings.locale]);
  useEffect(() => {
    const openExternalLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
      const href = anchor?.href;
      if (!href || !/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      void desktop.openExternalUrl(href, settings.browserId).catch(() => undefined);
    };
    document.addEventListener("click", openExternalLink);
    return () => document.removeEventListener("click", openExternalLink);
  }, [settings.browserId]);
  useEffect(() => {
    let disposed = false;
    void desktop
      .getSettings()
      .then((loaded) => {
        // A user action can occur before the native settings bridge responds.
        // Never replace such a newer value with this initial, older snapshot.
        if (!disposed && settingsRevision.current === 0) {
          const next = { ...fallback, ...loaded };
          settingsRef.current = next;
          setSettings(next);
          localStorage.setItem("agent-k-settings", JSON.stringify(next));
        }
      })
      .catch(() => {
        // Browser-only development does not expose the native settings bridge.
      })
      .finally(() => {
        if (!disposed) setReady(true);
      });
    return () => {
      disposed = true;
    };
  }, []);
  const update = useCallback(
    async (patch: Partial<ClientSettings>) => {
      const previous = settingsRef.current;
      const next = { ...previous, ...patch };
      const revision = ++settingsRevision.current;
      settingsRef.current = next;
      setSettings(next);
      localStorage.setItem("agent-k-settings", JSON.stringify(next));
      const poolChanged =
        patch.workerPoolSize !== undefined &&
        patch.workerPoolSize !== previous.workerPoolSize;
      const persist = saveQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (poolChanged) await desktop.resizeWorkerPool(next.workerPoolSize);
          await desktop.saveSettings(next);
        });
      saveQueue.current = persist;
      try {
        await persist;
      } catch (error) {
        // Do not let an older failed request undo a setting changed afterwards.
        if (settingsRevision.current === revision) {
          settingsRef.current = previous;
          setSettings(previous);
          localStorage.setItem("agent-k-settings", JSON.stringify(previous));
          if (poolChanged)
            void desktop.resizeWorkerPool(previous.workerPoolSize).catch(() => undefined);
        }
        throw error;
      }
    },
    [],
  );
  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      resolvedTheme,
      ready,
      update,
      t: (key) => dictionaries[settings.locale][key],
    }),
    [ready, resolvedTheme, settings, update],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("SettingsProvider is missing");
  return value;
}
