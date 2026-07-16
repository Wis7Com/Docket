const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Ctrl+wheel zoom routing. On macOS, Chromium applies Ctrl+wheel as a
// whole-window zoom at the browser level without dispatching a cancelable
// wheel event to the page (and without Electron's zoom-changed event), so
// neither the page nor the main process can intercept it up front. Instead,
// detect the resulting zoom-factor drift, restore the sanctioned factor
// immediately, and hand the intent to the page — it routes the zoom to the
// pane under the pointer (document viewer / chat) or, over neither pane,
// sanctions it app-wide via applyAppZoom below.
let sanctionedZoomFactor = 1;
let pendingZoomRatio = null;

function handleZoomDrift() {
  let factor;
  try {
    factor = webFrame.getZoomFactor();
  } catch {
    return;
  }
  if (!factor || Math.abs(factor - sanctionedZoomFactor) < 0.001) return;
  pendingZoomRatio = factor / sanctionedZoomFactor;
  try {
    webFrame.setZoomFactor(sanctionedZoomFactor);
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent("docket:zoom-intent"));
}

try {
  webFrame.setVisualZoomLevelLimits(1, 1);
  webFrame.setZoomFactor(1);
} catch (err) {
  console.error("[preload] failed to pin zoom", err);
}
window.addEventListener("resize", handleZoomDrift);

contextBridge.exposeInMainWorld("docket", {
  // Active session — used by the supabase shim and any code needing the API URL
  getToken: () => ipcRenderer.invoke("docket:getToken"),
  getUser: () => ipcRenderer.invoke("docket:getUser"),
  getApiPort: () => ipcRenderer.invoke("docket:getApiPort"),
  focusMainWindow: () => ipcRenderer.invoke("docket:focusMainWindow"),
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
  // Ctrl+wheel zoom routing (see handleZoomDrift above). The page consumes
  // the pending ratio on "docket:zoom-intent" and either applies it to a
  // pane or sanctions it app-wide.
  consumeZoomIntent: () => {
    const ratio = pendingZoomRatio;
    pendingZoomRatio = null;
    return ratio;
  },
  applyAppZoom: (ratio) => {
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) {
      return;
    }
    sanctionedZoomFactor = Math.min(
      3,
      Math.max(0.25, sanctionedZoomFactor * ratio),
    );
    try {
      webFrame.setZoomFactor(sanctionedZoomFactor);
    } catch {
      // best-effort; drift detection re-syncs on the next resize
    }
  },
  pickSourceFolder: () => ipcRenderer.invoke("docket:pickSourceFolder"),
  authorizeProjectFolder: (payload) =>
    ipcRenderer.invoke("docket:authorizeProjectFolder", payload),
});
