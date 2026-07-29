"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld(
  "agentK",
  Object.freeze({
    invoke(command, args = {}) {
      return ipcRenderer.invoke("agent-k:invoke", command, args);
    },
    getVersion() {
      return ipcRenderer.invoke("agent-k:app-version");
    },
    copyText(value) {
      return ipcRenderer.invoke("agent-k:clipboard-write", value);
    },
    openDialog(options) {
      return ipcRenderer.invoke("agent-k:dialog-open", options);
    },
    pathForFile(file) {
      return webUtils.getPathForFile(file);
    },
    projectConsole: Object.freeze({
      write(id, data) {
        ipcRenderer.send("agent-k:project-console-input", id, data);
      },
      onEvent(listener) {
        const wrapped = (_event, payload) => listener(payload);
        ipcRenderer.on("agent-k:project-console-event", wrapped);
        return () => ipcRenderer.removeListener("agent-k:project-console-event", wrapped);
      },
    }),
    onPiEvent(listener) {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("agent-k:pi-event", wrapped);
      return () => ipcRenderer.removeListener("agent-k:pi-event", wrapped);
    },
    window: Object.freeze({
      invoke(action, payload = {}) {
        return ipcRenderer.invoke("agent-k:window", action, payload);
      },
      onResized(listener) {
        const wrapped = (_event, payload) => listener(payload);
        ipcRenderer.on("agent-k:window-resized", wrapped);
        return () => ipcRenderer.removeListener("agent-k:window-resized", wrapped);
      },
      onDebugRoot(listener) {
        const wrapped = (_event, root) => listener(root);
        ipcRenderer.on("agent-k:debug-root", wrapped);
        return () => ipcRenderer.removeListener("agent-k:debug-root", wrapped);
      },
      onDebugContext(listener) {
        const wrapped = (_event, context) => listener(context);
        ipcRenderer.on("agent-k:debug-context", wrapped);
        return () => ipcRenderer.removeListener("agent-k:debug-context", wrapped);
      },
      onDebugProviderHit(listener) {
        const wrapped = (_event, languageServerId) => listener(languageServerId);
        ipcRenderer.on("agent-k:debug-provider-hit", wrapped);
        return () => ipcRenderer.removeListener("agent-k:debug-provider-hit", wrapped);
      },
      onDebugToolTarget(listener) {
        const wrapped = (_event, target) => listener(target);
        ipcRenderer.on("agent-k:debug-tool-target", wrapped);
        return () => ipcRenderer.removeListener("agent-k:debug-tool-target", wrapped);
      },
      onDebugToolProvider(listener) {
        const wrapped = (_event, languageServerId) => listener(languageServerId);
        ipcRenderer.on("agent-k:debug-tool-provider", wrapped);
        return () => ipcRenderer.removeListener("agent-k:debug-tool-provider", wrapped);
      },
      onDebugToolSession(listener) {
        const wrapped = (_event, sessionId) => listener(sessionId);
        ipcRenderer.on("agent-k:debug-tool-session", wrapped);
        return () => ipcRenderer.removeListener("agent-k:debug-tool-session", wrapped);
      },
      onOpenEditorLocation(listener) {
        const wrapped = (_event, location) => listener(location);
        ipcRenderer.on("agent-k:open-editor-location", wrapped);
        return () => ipcRenderer.removeListener("agent-k:open-editor-location", wrapped);
      },
    }),
  }),
);
