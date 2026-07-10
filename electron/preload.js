const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("docket", {
  // Active session — used by the supabase shim and any code needing the API URL
  getToken: () => ipcRenderer.invoke("docket:getToken"),
  getUser: () => ipcRenderer.invoke("docket:getUser"),
  getApiPort: () => ipcRenderer.invoke("docket:getApiPort"),
  openDocumentViewer: (payload) =>
    ipcRenderer.invoke("docket:openDocumentViewer", payload),
  openMainRoute: (payload) => ipcRenderer.invoke("docket:openMainRoute", payload),
  // Main-window renderer subscribes to client-side navigation requests
  // pushed from the main process (e.g. viewer "+ Chat"). Returns an
  // unsubscribe function.
  onMainNavigate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("docket:navigate", listener);
    return () => ipcRenderer.removeListener("docket:navigate", listener);
  },
  minimizeDocumentViewer: () =>
    ipcRenderer.invoke("docket:minimizeDocumentViewer"),
  closeDocumentViewer: () => ipcRenderer.invoke("docket:closeDocumentViewer"),
  pickSourceFolder: () => ipcRenderer.invoke("docket:pickSourceFolder"),
  authorizeProjectFolder: (payload) =>
    ipcRenderer.invoke("docket:authorizeProjectFolder", payload),
});
