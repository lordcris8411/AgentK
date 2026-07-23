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
    }),
  }),
);
