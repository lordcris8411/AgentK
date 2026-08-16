import { join } from "node:path";
import type { FileEntry } from "./types.js";

export function directoryPresentation(
  displayPath: string,
  fileNames: readonly string[],
): Pick<FileEntry, "iconPath" | "preview"> {
  const files = new Map(
    fileNames.map((name) => [name.toLocaleLowerCase("en-US"), name]),
  );
  const iconName = ["icon.png", "icon.svg", "icon.webp"]
    .map((candidate) => files.get(candidate))
    .find(Boolean);
  const configName = files.get("config.k");
  const appName = ["app.html", "app.htm"].map((candidate) => files.get(candidate)).find(Boolean);
  const previewCandidate = [
    { kind: "k-app" as const, name: configName ? appName : undefined },
    ...["index.html", "index.htm"].map((candidate) => ({ kind: "index" as const, name: files.get(candidate) })),
    { kind: "readme" as const, name: files.get("readme.md") },
  ].find((candidate) => candidate.name);
  return {
    ...(iconName ? { iconPath: join(displayPath, iconName) } : {}),
    ...(previewCandidate?.name ? {
      preview: {
        ...(previewCandidate.kind === "k-app" && configName
          ? { configPath: join(displayPath, configName) }
          : {}),
        kind: previewCandidate.kind,
        path: join(displayPath, previewCandidate.name),
      },
    } : {}),
  };
}

export function previewHtml(body: Buffer, token: string, appBridge: boolean): Buffer {
  const prefix = `/${token}/`;
  const rewritten = body.toString("utf8").replace(
    /(\b(?:src|href|poster)\s*=\s*["'])\/(?!\/)/gi,
    `$1${prefix}`,
  );
  const bridge = appBridge ? `<script>(()=>{const pending=new Map();const themeListeners=new Set();let nextId=1;const call=(method,args={})=>new Promise((resolve,reject)=>{const requestId=String(nextId++);pending.set(requestId,{resolve,reject});parent.postMessage({type:'agent-k-directory-app-request',requestId,method,arguments:args},'*')});addEventListener('message',event=>{if(event.source!==parent)return;const data=event.data;if(!data)return;if(data.type==='agent-k-theme-changed'){for(const listener of themeListeners)try{listener(data.theme)}catch(error){queueMicrotask(()=>{throw error})}return}if(data.type!=='agent-k-directory-app-response'||typeof data.requestId!=='string')return;const request=pending.get(data.requestId);if(!request)return;pending.delete(data.requestId);if(data.ok)request.resolve(data.result);else request.reject(new Error(typeof data.error==='string'?data.error:'Agent K request failed'))});Object.defineProperty(window,'AgentK',{configurable:false,writable:false,value:Object.freeze({files:Object.freeze({read:path=>call('files.read',{path}),write:(path,content)=>call('files.write',{path,content}),list:(path='.')=>call('files.list',{path})}),pi:Object.freeze({send:message=>call('pi.send',{message})}),processes:Object.freeze({start:(command,args=[],options={})=>call('processes.start',{command,args,cwd:options.cwd??'.'}),open:target=>call('processes.open',{target}),list:()=>call('processes.list'),status:id=>call('processes.status',{id}),wait:id=>call('processes.wait',{id}),output:(id,cursors={})=>call('processes.output',{id,stdoutCursor:cursors.stdoutCursor??0,stderrCursor:cursors.stderrCursor??0}),stop:id=>call('processes.stop',{id})}),theme:Object.freeze({get:()=>call('theme.get'),onChange:listener=>{if(typeof listener!=='function')throw new TypeError('theme.onChange requires a function');themeListeners.add(listener);return()=>themeListeners.delete(listener)}})})})})();</script>` : "";
  const instrumented = bridge
    ? /<head(?:\s[^>]*)?>/i.test(rewritten)
      ? rewritten.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bridge}`)
      : `${bridge}${rewritten}`
    : rewritten;
  return Buffer.from(
    `${instrumented}<script>document.addEventListener('contextmenu',event=>event.preventDefault(),{capture:true})</script>`,
  );
}
