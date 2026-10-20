import { contextBridge, ipcRenderer } from "electron";

// This remote page gets a write-only, single-purpose bridge, never desktop IPC.
if (location.origin === "https://chatgpt.com") {
  contextBridge.exposeInMainWorld("__piBridge", {
    send: (payload: unknown) => ipcRenderer.send("pi-desktop/chatgpt-chat/stream", payload),
  });
}
