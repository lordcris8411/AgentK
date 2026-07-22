import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/editor/editor.all.js";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import "monaco-editor/esm/vs/basic-languages/bat/bat.contribution";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/dart/dart.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/r/r.contribution";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import CssWorkerUrl from "monaco-editor/esm/vs/language/css/css.worker?worker&url";
import EditorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker?worker&url";
import HtmlWorkerUrl from "monaco-editor/esm/vs/language/html/html.worker?worker&url";
import JsonWorkerUrl from "monaco-editor/esm/vs/language/json/json.worker?worker&url";
import TypeScriptWorkerUrl from "monaco-editor/esm/vs/language/typescript/ts.worker?worker&url";

async function createWorker(url: string, name?: string): Promise<Worker> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Monaco worker could not be loaded: ${response.status}`);
  const workerUrl = URL.createObjectURL(
    new Blob([await response.text()], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl, { name });
  URL.revokeObjectURL(workerUrl);
  return worker;
}

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string, name?: string) {
    if (label === "json") return createWorker(JsonWorkerUrl, name);
    if (label === "css" || label === "scss" || label === "less")
      return createWorker(CssWorkerUrl, name);
    if (label === "html" || label === "handlebars" || label === "razor")
      return createWorker(HtmlWorkerUrl, name);
    if (label === "typescript" || label === "javascript")
      return createWorker(TypeScriptWorkerUrl, name);
    return createWorker(EditorWorkerUrl, name);
  },
};

(globalThis as typeof globalThis & {
  AgentKEditorDependencies: { monaco: typeof monaco };
}).AgentKEditorDependencies = Object.freeze({ monaco });
