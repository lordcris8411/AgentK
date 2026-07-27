type Highlighter = typeof import("highlight.js/lib/common").default;

let highlighterPromise: Promise<Highlighter> | undefined;
const additionalLanguagePromises = new Map<string, Promise<void>>();
const additionalLanguageLoaders = {
  cmake: () => import("highlight.js/lib/languages/cmake"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  glsl: () => import("highlight.js/lib/languages/glsl"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
};

function loadHighlighter(): Promise<Highlighter> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = import("highlight.js/lib/common").then((common) => common.default);
  return highlighterPromise;
}

async function ensureLanguage(highlighter: Highlighter, language: string): Promise<void> {
  if (highlighter.getLanguage(language) || !(language in additionalLanguageLoaders)) return;
  const existing = additionalLanguagePromises.get(language);
  if (existing) return existing;
  const loader = additionalLanguageLoaders[language as keyof typeof additionalLanguageLoaders];
  const pending = loader().then((module) => {
    highlighter.registerLanguage(language, module.default);
  });
  additionalLanguagePromises.set(language, pending);
  return pending;
}

export async function highlightCode(code: string, language: string): Promise<string | undefined> {
  const highlighter = await loadHighlighter();
  await ensureLanguage(highlighter, language);
  if (!highlighter.getLanguage(language)) return undefined;
  return highlighter.highlight(code, {
    ignoreIllegals: true,
    language,
  }).value;
}
