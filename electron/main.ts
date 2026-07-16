import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  readConfig,
  writeConfig,
  isDirectoryUsable,
  ensureAppDataLayout,
  resolveDataDir,
  migrateLegacyUserDataDir,
} from "./appData";
import { readSecrets } from "./secrets";
import { signLocalJwt } from "./jwt";
import {
  spawnBackend,
  stopBackend,
  stopBackendAndWait,
  waitForBackend,
  getBackendPort,
  getBackendExitInfo,
} from "./backend";
import { spawnFrontend, stopFrontend, waitForFrontend } from "./frontend";
import { initLogging, getLogPath, closeLogging } from "./logging";

const FRONTEND_URL = process.env.DOCKET_FRONTEND_URL ?? "http://localhost:3000";
const FRONTEND_ORIGIN = new URL(FRONTEND_URL).origin;
const LOCAL_USER_ID = "local-user";
const LOCAL_USER_EMAIL = "user@local";
const JWT_TTL_SECONDS = 60 * 60 * 24; // 24h

let win: BrowserWindow | null = null;
let documentViewerWindow: BrowserWindow | null = null;
let activeProjectPath: string | null = null;
let sessionJwt: string | null = null;
let sessionSecret: string | null = null;
let startingSession = false;
const securityScopedAccessStops = new Map<string, () => void>();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const target = win && !win.isDestroyed() ? win : documentViewerWindow;
    if (target && !target.isDestroyed()) {
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    }
  });
}

if (process.env.DOCKET_USER_DATA_DIR) {
  app.setPath("userData", process.env.DOCKET_USER_DATA_DIR);
} else {
  // Pre-rebrand installs kept userData under the old app names.
  migrateLegacyUserDataDir(["Mike", "mikelocal-desktop"]);
}

function appIconPath(): string | undefined {
  const iconPath = path.join(
    __dirname,
    "..",
    "assets",
    "icons",
    "docket-local.png",
  );
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

function installAppIcon(): void {
  const iconPath = appIconPath();
  if (iconPath && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(iconPath);
  }
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: "Docket",
    icon: appIconPath(),
    backgroundColor: "#0b0b0d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(isSessionCheckEnabled() ? { backgroundThrottling: false } : {}),
    },
  });
  w.removeMenu();
  installNavigationGuards(w);
  pinWindowZoom(w);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isDocumentViewerUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: documentViewerWindowOptions(),
      };
    }
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  w.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return;
      console.error(
        `[loadURL failed] code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
      );
      dialog.showErrorBox(
        "Docket couldn't load",
        `Failed to open ${validatedURL}\n\n${errorDescription} (code ${errorCode})\n\n` +
          (getLogPath() ? `Check the log file:\n${getLogPath()}` : ""),
      );
    },
  );

  // Window-scoped DevTools / log shortcuts. DevTools toggles are gated on
  // dev builds.
  w.webContents.on("before-input-event", (_e, input) => {
    if (input.type !== "keyDown") return;
    const devToolsAllowed = !app.isPackaged;
    if (input.key === "F12") {
      if (devToolsAllowed) w.webContents.toggleDevTools();
    } else if (
      (input.control || input.meta) &&
      input.shift &&
      input.key.toLowerCase() === "i"
    ) {
      if (devToolsAllowed) w.webContents.toggleDevTools();
    } else if (
      (input.control || input.meta) &&
      input.shift &&
      input.key.toLowerCase() === "l"
    ) {
      const lp = getLogPath();
      if (lp) void shell.openPath(lp);
    }
  });
  // If something else opens DevTools (renderer-initiated, etc.) in packaged
  // builds, close them.
  w.webContents.on("devtools-opened", () => {
    if (app.isPackaged) {
      w.webContents.closeDevTools();
    }
  });
  return w;
}

function isFrontendOrigin(url: string): boolean {
  try {
    return new URL(url).origin === FRONTEND_ORIGIN;
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function installNavigationGuards(w: BrowserWindow): void {
  const blockOffOrigin = (event: Electron.Event, url: string) => {
    if (!isFrontendOrigin(url)) {
      event.preventDefault();
    }
  };
  w.webContents.on("will-navigate", blockOffOrigin);
  w.webContents.on("will-redirect", blockOffOrigin);
}

// On macOS, Chromium applies Ctrl+wheel zoom at the browser level without a
// cancelable renderer event (and without emitting zoom-changed); the preload
// script detects the resulting zoom-factor drift and routes it — per-pane
// zoom over the document viewer / chat, sanctioned app-wide zoom elsewhere.
// Here we only make sure windows start at 100% with pinch zoom disabled.
function pinWindowZoom(w: BrowserWindow): void {
  const contents = w.webContents;
  contents.on("did-finish-load", () => {
    void contents.setVisualZoomLevelLimits(1, 1);
    contents.setZoomFactor(1);
  });
}

function loadMainApp(w: BrowserWindow): void {
  void w.loadURL(new URL("/projects", FRONTEND_URL).toString());
}

type DocumentViewerPayload = {
  documentId?: string;
  filename?: string;
  versionId?: string | null;
  versionLabel?: string | null;
  searchQuote?: string | null;
  searchPage?: number | null;
  searchKey?: string | null;
  annotationId?: string | null;
  projectId?: string | null;
};

function documentViewerUrl(payload: DocumentViewerPayload): string {
  const url = new URL("/document-viewer", FRONTEND_URL);
  url.searchParams.set("document_id", payload.documentId ?? "");
  url.searchParams.set("filename", payload.filename ?? "Document");
  if (payload.versionId) url.searchParams.set("version_id", payload.versionId);
  if (payload.versionLabel) {
    url.searchParams.set("version_label", payload.versionLabel);
  }
  if (payload.searchQuote) url.searchParams.set("search_quote", payload.searchQuote);
  if (typeof payload.searchPage === "number" && Number.isFinite(payload.searchPage)) {
    url.searchParams.set("search_page", String(payload.searchPage));
  }
  if (payload.searchKey) url.searchParams.set("search_key", payload.searchKey);
  if (payload.annotationId) {
    url.searchParams.set("annotation_id", payload.annotationId);
  }
  if (payload.projectId) {
    url.searchParams.set("project_id", payload.projectId);
  }
  return url.toString();
}

function isDocumentViewerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const frontendUrl = new URL(FRONTEND_URL);
    return url.origin === frontendUrl.origin && url.pathname === "/document-viewer";
  } catch {
    return false;
  }
}

function documentViewerWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    width: 960,
    height: 820,
    minWidth: 520,
    minHeight: 360,
    title: "Docket Document Viewer",
    icon: appIconPath(),
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

function getOrCreateDocumentViewerWindow(): BrowserWindow {
  if (documentViewerWindow && !documentViewerWindow.isDestroyed()) {
    return documentViewerWindow;
  }
  documentViewerWindow = new BrowserWindow(documentViewerWindowOptions());
  documentViewerWindow.removeMenu();
  installNavigationGuards(documentViewerWindow);
  pinWindowZoom(documentViewerWindow);
  documentViewerWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  documentViewerWindow.on("closed", () => {
    documentViewerWindow = null;
  });
  return documentViewerWindow;
}

function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  const senderUrl = event.senderFrame?.url;
  return typeof senderUrl === "string" && isFrontendOrigin(senderUrl);
}

function isSessionCheckEnabled(): boolean {
  return process.env.DOCKET_SESSION_CHECK === "1" && !app.isPackaged;
}

function normalizedFolderPath(folderPath: string): string {
  try {
    return fs.realpathSync(folderPath);
  } catch {
    return path.resolve(folderPath);
  }
}

function startSecurityScopedAccess(folderPath: string, bookmark: string): void {
  if (process.platform !== "darwin" || !bookmark) return;
  const key = normalizedFolderPath(folderPath);
  if (securityScopedAccessStops.has(key)) return;
  try {
    const stop = app.startAccessingSecurityScopedResource(bookmark);
    securityScopedAccessStops.set(key, () => stop());
  } catch (err) {
    console.warn(`[security-scope] failed to access ${key}:`, err);
  }
}

function restoreProjectFolderAccess(): void {
  const bookmarks = readConfig().projectFolderBookmarks ?? {};
  for (const [folderPath, bookmark] of Object.entries(bookmarks)) {
    startSecurityScopedAccess(folderPath, bookmark);
  }
}

function rememberProjectFolderAccess(folderPath: string, bookmark?: string): void {
  if (!bookmark) return;
  const key = normalizedFolderPath(folderPath);
  const cfg = readConfig();
  writeConfig({
    ...cfg,
    projectFolderBookmarks: {
      ...(cfg.projectFolderBookmarks ?? {}),
      [key]: bookmark,
    },
  });
  startSecurityScopedAccess(key, bookmark);
}

function installSessionCheck(w: BrowserWindow): void {
  if (!isSessionCheckEnabled()) return;
  const projectPath = process.env.DOCKET_SESSION_CHECK_PROJECT_PATH;
  const defaultSessionCheck =
    process.env.DOCKET_SESSION_CHECK_DEFAULT_SESSION === "1";
  const timeoutMs = Number(process.env.DOCKET_SESSION_CHECK_TIMEOUT_MS ?? 30_000);
  if (!projectPath && !defaultSessionCheck) {
    console.error("[session-check] DOCKET_SESSION_CHECK_PROJECT_PATH is required.");
    app.exit(1);
    return;
  }
  if (projectPath && !isDirectoryUsable(projectPath)) {
    console.error(`[session-check] invalid project path: ${projectPath}`);
    app.exit(1);
    return;
  }
  if (projectPath) {
    activeProjectPath = projectPath;
    try {
      const lp = initLogging(app.getPath("userData"));
      console.log(`[session-check] logging to ${lp}`);
    } catch (err) {
      console.warn("[session-check] failed to init log file:", err);
    }
  }
  if (defaultSessionCheck) {
    console.log("[session-check] default app-level session check enabled");
  }

  // Surface renderer console output in the session-check log — hydration or
  // chunk-load failures otherwise leave no trace outside DevTools.
  w.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  let finished = false;
  let featureSmokeRunning = false;
  const failTimer = setTimeout(async () => {
    if (finished) return;
    const errorText = await Promise.race([
      w.webContents
        .executeJavaScript(
          "document.getElementById('error')?.textContent || ''",
          true,
        )
        .catch(() => ""),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 1_500)),
    ]);
    console.error(
      `[session-check] timed out after ${timeoutMs}ms${errorText ? `: ${errorText}` : ""}`,
    );
    app.exit(1);
  }, timeoutMs);

  const interval = setInterval(async () => {
    let port: number;
    try {
      port = getBackendPort();
    } catch {
      return; // backend has not written its runtime port yet
    }
    try {
      const resp = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!resp.ok) return;
      const url = w.webContents.getURL();
      if (!url.startsWith(FRONTEND_URL)) return;
      const bridge = await w.webContents.executeJavaScript(
        `
          (async () => {
            if (document.readyState === "loading") return null;
            const token = await window.docket?.getToken?.();
            const user = await window.docket?.getUser?.();
            const apiPort = await window.docket?.getApiPort?.();
            return { hasToken: Boolean(token), user, apiPort };
          })()
        `,
        true,
      );
      if (
        !bridge?.hasToken ||
        bridge?.user?.id !== LOCAL_USER_ID ||
        bridge?.apiPort !== port
      ) {
        return;
      }
      const expectedProjectPath =
        process.env.DOCKET_SESSION_CHECK_EXPECT_PROJECT_PATH;
      if (expectedProjectPath && activeProjectPath !== expectedProjectPath) {
        console.error(
          `[session-check] expected project path ${expectedProjectPath}, got ${activeProjectPath ?? "(none)"}`,
        );
        app.exit(1);
        return;
      }
      if (featureSmokeRunning) return;
      featureSmokeRunning = true;
      let featureSmoke: { ok: boolean; summary: string };
      try {
        featureSmoke = await runSessionFeatureSmoke(w, port);
      } catch (err) {
        console.error("[session-check] feature smoke failed:", err);
        app.exit(1);
        return;
      }
      if (!featureSmoke.ok) {
        featureSmokeRunning = false;
        return;
      }
      finished = true;
      clearInterval(interval);
      clearTimeout(failTimer);
      console.log(`[session-check] backend health ok on port ${port}`);
      console.log("[session-check] frontend bridge ok");
      console.log(`[session-check] feature smoke ok: ${featureSmoke.summary}`);
      console.log("SESSION CHECK: PASS");
      app.quit();
    } catch {
      // backend not ready yet
    }
  }, 250);
}

const PROJECT_FOLDER_SMOKE_PRIMARY_PDF =
  process.env.DOCKET_SESSION_CHECK_PRIMARY_PDF ?? "Sample_Scoping_Paper_highlighted.pdf";
const PROJECT_FOLDER_SMOKE_MANUAL_PDF =
  process.env.DOCKET_SESSION_CHECK_MANUAL_PDF ?? "Sample_Summary_Handout.pdf";
const PROJECT_FOLDER_SMOKE_SEARCH_QUERY =
  process.env.DOCKET_SESSION_CHECK_SEARCH_QUERY ?? "sample scoping paper";
const PROJECT_FOLDER_SMOKE_CITATION_QUOTE =
  process.env.DOCKET_SESSION_CHECK_CITATION_QUOTE ?? "sample scoping paper";

async function runSessionFeatureSmoke(
  w: BrowserWindow,
  port: number,
): Promise<{ ok: boolean; summary: string }> {
  if (process.env.DOCKET_SESSION_CHECK_ONLY_PROJECT_FOLDER === "1") {
    const projectFolderInspection = await inspectProjectFolderUpgradeDom(
      w,
      port,
    );
    if (!projectFolderInspection) {
      throw new Error(
        "DOCKET_SESSION_CHECK_PROJECT_FOLDER is required for project-folder-only smoke",
      );
    }
    return {
      ok: true,
      summary: `project_folder_imported=${projectFolderInspection.imported} project_folder_index_ready=${projectFolderInspection.indexReady} project_folder_index_failed=${projectFolderInspection.indexFailed} project_folder_search=${projectFolderInspection.searchResults} project_folder_citations=${projectFolderInspection.citationButtonCount} project_folder_temp_highlights=${projectFolderInspection.temporaryHighlightCount} project_folder_promotions=${projectFolderInspection.citationPromotionCount} project_folder_ui_highlights=${projectFolderInspection.userHighlightCount} project_folder_ui_comments=${projectFolderInspection.userCommentCount} project_folder_no_doc_labels=${projectFolderInspection.answerAvoidsDocLabels} project_folder_citation_error=${Boolean(projectFolderInspection.citationError)}`,
    };
  }
  const sourceDir = process.env.DOCKET_SESSION_CHECK_SOURCE_DIR;
  if (!sourceDir) return { ok: true, summary: "skipped" };
  const projectPath = process.env.DOCKET_SESSION_CHECK_PROJECT_PATH;
  if (!projectPath) {
    throw new Error("DOCKET_SESSION_CHECK_PROJECT_PATH is required for feature smoke");
  }
  const result = await w.webContents.executeJavaScript(
    `
      (async () => {
        const token = await window.docket?.getToken?.();
        if (!token) throw new Error("session smoke token missing");
        const base = "http://localhost:${port}";
        const sourceDir = ${JSON.stringify(sourceDir)};
        const projectPath = ${JSON.stringify(projectPath)};
        async function request(path, init = {}) {
          const response = await fetch(base + path, {
            ...init,
            headers: {
              Accept: "application/json",
              Authorization: "Bearer " + token,
              ...(init.headers || {}),
            },
          });
          if (!response.ok) {
            throw new Error(path + " failed: " + response.status + " " + await response.text());
          }
          if (response.status === 204) return null;
          return response.json();
        }
        const project = await request("/projects/open-folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: projectPath }),
        });
        const outlineMarkdown = [
          "# Session Navigation Smoke",
          "",
          "Introductory text.",
          "",
          "## First Heading",
          "",
          "First heading body.",
          "",
          "## Second Heading",
          "",
          ...Array.from({ length: 40 }, (_, index) => "Paragraph " + (index + 1) + " under the second heading."),
          "",
          "### Deep Target Heading",
          "",
          "This heading is used by the document navigation smoke test.",
        ].join("\\n");
        const uploadForm = new FormData();
        uploadForm.append(
          "file",
          new File([outlineMarkdown], "session-outline.md", {
            type: "text/markdown",
          }),
        );
        const markdownResponse = await fetch(base + "/projects/" + project.id + "/documents", {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          body: uploadForm,
        });
        if (!markdownResponse.ok) {
          throw new Error("markdown upload failed: " + markdownResponse.status + " " + await markdownResponse.text());
        }
        const markdownDoc = await markdownResponse.json();
        if (!markdownDoc?.id) throw new Error("markdown upload did not return a document id");
        const linked = await request("/projects/" + project.id + "/source-folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourceDir }),
        });
        if (linked.imported?.length !== 1) {
          throw new Error("expected one linked-folder import");
        }
        const doc = linked.imported[0];
        if (!doc?.id || !doc?.current_version_id) {
          throw new Error("linked import missing document/version id");
        }
        const rescan = await request(
          "/projects/" + project.id + "/source-folders/" + linked.source_folder.id + "/rescan",
          { method: "POST" },
        );
        if (!rescan.unchanged?.includes("session-source.pdf")) {
          throw new Error("manual rescan did not report unchanged source PDF");
        }
        const highlight = await request("/single-documents/" + doc.id + "/annotations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version_id: doc.current_version_id,
            page_number: 1,
            annotation_type: "highlight",
            color: "#ffe066",
            quote: "Session check source clause",
            rects: [{ page: 1, x: 72, y: 690, width: 180, height: 18 }],
            source: "citation_promotion",
            source_citation: {
              ref: 1,
              document_id: doc.id,
              version_id: doc.current_version_id,
              page: 1,
              quote: "Session check source clause",
            },
          }),
        });
        if (highlight.source !== "citation_promotion") {
          throw new Error("citation promotion annotation source was not preserved");
        }
        const annotationVersionId = highlight.version_id || doc.current_version_id;
        const comment = await request("/single-documents/" + doc.id + "/annotations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version_id: annotationVersionId,
            page_number: 1,
            annotation_type: "comment",
            color: "#74c0fc",
            quote: "Session check source clause",
            comment: "Session smoke comment",
            rects: [{ page: 1, x: 72, y: 660, width: 150, height: 18 }],
            source: "user",
          }),
        });
        if (comment.annotation_type !== "comment" || comment.comment !== "Session smoke comment") {
          throw new Error("comment annotation was not preserved");
        }
        const annotations = await request(
          "/single-documents/" + doc.id + "/annotations?version_id=" + encodeURIComponent(comment.version_id || annotationVersionId),
        );
        if (annotations.length !== 2) {
          throw new Error("expected two saved annotations before export");
        }
        return {
          projectId: project.id,
          docId: doc.id,
          markdownDocId: markdownDoc.id,
          versionId: comment.version_id || annotationVersionId,
          sourceFolderId: linked.source_folder.id,
          imported: linked.imported.length,
          unchanged: rescan.unchanged.length,
          annotations: annotations.length,
        };
      })()
    `,
    true,
  );
  const uiRescan = await inspectProjectSourceFolderRescanDom(
    w,
    result.projectId,
    result.sourceFolderId,
  );
  console.log(`[session-check] ui rescan complete: ${uiRescan.summaryText}`);
  const domInspection = await inspectProjectPdfViewerDom(
    w,
    result.projectId,
    result.docId,
  );
  console.log(
    `[session-check] pdf viewer complete: canvases=${domInspection.canvasCount} annotations=${domInspection.savedAnnotationCount}`,
  );
  const navInspection = await inspectProjectMarkdownNavigationDom(
    w,
    result.projectId,
    result.markdownDocId,
  );
  console.log(
    `[session-check] document navigation complete: items=${navInspection.itemCount} before=${navInspection.beforeScrollTop} after=${navInspection.afterScrollTop}`,
  );
  const pdfOutlineInspection = await inspectPdfOutlineGenerationDom(
    w,
    port,
    result.projectId,
  );
  if (pdfOutlineInspection) {
    console.log(
      `[session-check] pdf outline generation complete: items=${pdfOutlineInspection.itemCount} before=${pdfOutlineInspection.beforeScrollTop} after=${pdfOutlineInspection.afterScrollTop}`,
    );
  }
  const citationChatId = seedSessionCitationChat({
    projectId: result.projectId,
    docId: result.docId,
    versionId: result.versionId,
  });
  const citationInspection = await inspectAssistantCitationPromotionDom(
    w,
    port,
    result.projectId,
    citationChatId,
    result.docId,
  );
  console.log(
    `[session-check] seeded citation complete: highlights=${citationInspection.temporaryHighlightCount} promotions=${citationInspection.citationPromotionCount}`,
  );
  const realPromptInspection = await inspectRealPromptCitationDom(w, port);
  console.log(
    `[session-check] real prompt complete: citations=${realPromptInspection.citationButtonCount} highlights=${realPromptInspection.temporaryHighlightCount} tabs=${realPromptInspection.tabCount} tab_nav=${realPromptInspection.tabNavigationVerified}`,
  );
  const projectFolderInspection = await inspectProjectFolderUpgradeDom(w, port);
  if (projectFolderInspection) {
    console.log(
      `[session-check] project folder complete: imported=${projectFolderInspection.imported} search=${projectFolderInspection.searchResults}`,
    );
  }
  const exportResult = await inspectProjectPdfExportButtonDom(
    w,
    port,
    result.projectId,
    result.docId,
  );
  console.log(
    `[session-check] export button complete: clicked=${exportResult.clickedExportButton} version=${exportResult.exportedVersion}`,
  );
  const pdfInspection = await inspectGeneratedPdfAnnotations(
    exportResult.generatedUrl,
  );
  console.log(
    `[session-check] generated pdf inspected: bytes=${pdfInspection.byteLength}`,
  );
  if (!pdfInspection.hasHighlight) {
    throw new Error("generated PDF is missing a highlight annotation object");
  }
  if (!pdfInspection.hasText) {
    throw new Error(
      "generated PDF is missing a text/comment annotation object",
    );
  }
  if (!pdfInspection.hasCommentContents) {
    throw new Error("generated PDF is missing the saved comment contents");
  }
  return {
    ok: true,
    summary: `imported=${result.imported} unchanged=${result.unchanged} ui_rescan=${uiRescan.summaryText} annotations=${result.annotations} dom_canvas=${domInspection.canvasCount} dom_overlays=${domInspection.savedAnnotationCount} text_select=${domInspection.textLayerSelection.pointerEvents}/${domInspection.textLayerSelection.userSelect}/${domInspection.textLayerSelection.spanUserSelect} ui_highlight=${domInspection.highlightAnnotationCount} ui_comment=${domInspection.commentAnnotationCount} selection_annotations=${domInspection.annotationCountAfterSelection} citation_highlights=${citationInspection.temporaryHighlightCount} citation_promotions=${citationInspection.citationPromotionCount} real_prompt_citations=${realPromptInspection.citationButtonCount} real_prompt_highlights=${realPromptInspection.temporaryHighlightCount} real_prompt_answer=${realPromptInspection.answerIncludesQuote} project_tabs=${realPromptInspection.tabCount} project_tab_nav=${realPromptInspection.tabNavigationVerified} project_tab_overflow=${realPromptInspection.tabStripOverflow}${projectFolderInspection ? ` project_folder_imported=${projectFolderInspection.imported} project_folder_index_ready=${projectFolderInspection.indexReady} project_folder_index_failed=${projectFolderInspection.indexFailed} project_folder_search=${projectFolderInspection.searchResults} project_folder_citations=${projectFolderInspection.citationButtonCount} project_folder_temp_highlights=${projectFolderInspection.temporaryHighlightCount} project_folder_promotions=${projectFolderInspection.citationPromotionCount} project_folder_ui_highlights=${projectFolderInspection.userHighlightCount} project_folder_ui_comments=${projectFolderInspection.userCommentCount} project_folder_no_doc_labels=${projectFolderInspection.answerAvoidsDocLabels} project_folder_citation_error=${Boolean(projectFolderInspection.citationError)}` : ""} pdf_button_export=${exportResult.clickedExportButton} exported_v=${exportResult.exportedVersion} pdf_bytes=${pdfInspection.byteLength}`,
  };
}

function seedSessionCitationChat(args: {
  projectId: string;
  docId: string;
  versionId: string;
}): string {
  const projectRoot =
    activeProjectPath ?? process.env.DOCKET_SESSION_CHECK_PROJECT_PATH;
  if (!projectRoot) throw new Error("session check project path is not available");
  const betterSqlitePath = path.join(
    __dirname,
    "..",
    "backend",
    "node_modules",
    "better-sqlite3",
  );
  const dbPath = path.join(resolveDataDir(projectRoot), "project.db");
  const script = `
    const crypto = require("crypto");
    const Database = require(process.argv[1]);
    const [dbPath, projectId, userId, docId, versionId] = process.argv.slice(2);
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const chatId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      db.prepare("INSERT OR IGNORE INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)")
        .run(projectId, userId, "Session Check Project", "[]");
      db.prepare("INSERT INTO chats (id, project_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(chatId, projectId, userId, "Session citation smoke", now);
      db.prepare("INSERT INTO chat_messages (id, chat_id, role, content, files, annotations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          crypto.randomUUID(),
          chatId,
          "user",
          JSON.stringify("What does the source clause say?"),
          null,
          null,
          now
        );
      db.prepare("INSERT INTO chat_messages (id, chat_id, role, content, files, annotations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          crypto.randomUUID(),
          chatId,
          "assistant",
          JSON.stringify([{ type: "content", text: "The source clause is available in the linked source. [1]" }]),
          null,
          JSON.stringify([{
            type: "citation_data",
            ref: 1,
            doc_id: docId,
            document_id: docId,
            version_id: versionId,
            version_number: 1,
            filename: "session-source.pdf",
            page: 1,
            quote: "Session check source clause"
          }]),
          new Date(Date.now() + 1).toISOString()
        );
      process.stdout.write(chatId);
    } finally {
      db.close();
    }
  `;
  const seeded = spawnSync(
    sessionCheckNode(),
    [
      "-e",
      script,
      betterSqlitePath,
      dbPath,
      args.projectId,
      LOCAL_USER_ID,
      args.docId,
      args.versionId,
    ],
    { encoding: "utf8" },
  );
  if (seeded.status !== 0) {
    throw new Error(
      `session citation chat seed failed: ${seeded.stderr || seeded.stdout}`,
    );
  }
  return seeded.stdout.trim();
}

function seedProjectCitationChat(args: {
  projectId: string;
  docId: string;
  versionId: string;
  filename: string;
  title: string;
  prompt: string;
  answer: string;
  quote: string;
  page: number;
}): string {
  const projectRoot =
    activeProjectPath ?? process.env.DOCKET_SESSION_CHECK_PROJECT_PATH;
  if (!projectRoot) throw new Error("session check project path is not available");
  const betterSqlitePath = path.join(
    __dirname,
    "..",
    "backend",
    "node_modules",
    "better-sqlite3",
  );
  const dbPath = path.join(resolveDataDir(projectRoot), "project.db");
  const script = `
    const crypto = require("crypto");
    const Database = require(process.argv[1]);
    const [dbPath, projectId, userId, docId, versionId, filename, title, prompt, answer, quote, page] = process.argv.slice(2);
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const chatId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      db.prepare("INSERT OR IGNORE INTO projects (id, user_id, name, shared_with) VALUES (?, ?, ?, ?)")
        .run(projectId, userId, "Session Check Project", "[]");
      db.prepare("INSERT INTO chats (id, project_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(chatId, projectId, userId, title, now);
      db.prepare("INSERT INTO chat_messages (id, chat_id, role, content, files, annotations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          crypto.randomUUID(),
          chatId,
          "user",
          JSON.stringify(prompt),
          null,
          null,
          now
        );
      db.prepare("INSERT INTO chat_messages (id, chat_id, role, content, files, annotations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          crypto.randomUUID(),
          chatId,
          "assistant",
          JSON.stringify([{ type: "content", text: answer }]),
          null,
          JSON.stringify([{
            type: "citation_data",
            ref: 1,
            doc_id: docId,
            document_id: docId,
            version_id: versionId,
            version_number: 1,
            filename,
            page: Number(page),
            quote
          }]),
          new Date(Date.now() + 1).toISOString()
        );
      process.stdout.write(chatId);
    } finally {
      db.close();
    }
  `;
  const seeded = spawnSync(
    sessionCheckNode(),
    [
      "-e",
      script,
      betterSqlitePath,
      dbPath,
      args.projectId,
      LOCAL_USER_ID,
      args.docId,
      args.versionId,
      args.filename,
      args.title,
      args.prompt,
      args.answer,
      args.quote,
      String(args.page),
    ],
    { encoding: "utf8" },
  );
  if (seeded.status !== 0) {
    throw new Error(
      `project citation chat seed failed: ${seeded.stderr || seeded.stdout}`,
    );
  }
  return seeded.stdout.trim();
}

function sessionCheckNode(): string {
  const requestedMajor = readRequestedNodeMajor(path.join(__dirname, ".."));
  const candidates = [
    process.env.DOCKET_SESSION_CHECK_NODE,
    process.env.DOCKET_BACKEND_NODE,
    requestedMajor
      ? `/opt/homebrew/opt/node@${requestedMajor}/bin/node`
      : undefined,
    requestedMajor
      ? `/usr/local/opt/node@${requestedMajor}/bin/node`
      : undefined,
    "node",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      [
        "-p",
        "JSON.stringify({ execPath: process.execPath, major: Number(process.versions.node.split('.')[0]), abi: process.versions.modules })",
      ],
      { encoding: "utf8" },
    );
    if (probe.status !== 0 || !probe.stdout) continue;
    try {
      const parsed = JSON.parse(probe.stdout.trim()) as {
        execPath?: string;
        major?: number;
        abi?: string;
      };
      const major = Number(parsed.major);
      if (major >= 20 && major < 25) {
        console.log(
          `[session-check] using Node ${major} ABI ${parsed.abi ?? "unknown"} for DB seeding`,
        );
        return parsed.execPath || candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return "node";
}

function readRequestedNodeMajor(rootDir: string): number | null {
  for (const fileName of [".node-version", ".nvmrc"]) {
    try {
      const raw = fs.readFileSync(path.join(rootDir, fileName), "utf8").trim();
      const major = Number.parseInt(raw, 10);
      if (Number.isFinite(major)) return major;
    } catch {
      // Try the next version file.
    }
  }
  return null;
}

async function inspectProjectSourceFolderRescanDom(
  w: BrowserWindow,
  projectId: string,
  sourceFolderId: string,
): Promise<{ summaryText: string }> {
  await w.loadURL(`${FRONTEND_URL}/projects/${encodeURIComponent(projectId)}`);
  return w.webContents.executeJavaScript(
    `
      (async () => {
        const sourceFolderId = ${JSON.stringify(sourceFolderId)};
        async function waitFor(label, fn, timeoutMs = 30000) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + document.body.innerText.slice(0, 500));
        }
        async function diagnose() {
          const out = {};
          try { out.token = Boolean(await window.docket?.getToken?.()); } catch (err) { out.token = "err:" + err; }
          try { out.port = await window.docket?.getApiPort?.(); } catch (err) { out.port = "err:" + err; }
          try {
            const token = await window.docket.getToken();
            const resp = await fetch("http://localhost:" + out.port + "/projects/" + ${JSON.stringify(projectId)}, {
              headers: { Authorization: "Bearer " + token },
              signal: AbortSignal.timeout(5000),
            });
            out.projectFetch = resp.status;
            const body = await resp.text();
            out.projectBody = body.slice(0, 200);
          } catch (err) {
            out.projectFetch = "err:" + err;
          }
          out.rowCount = document.querySelectorAll('[data-session-check="source-folder-row"]').length;
          out.skeleton = document.querySelectorAll(".animate-pulse").length;
          out.fetches = performance
            .getEntriesByType("resource")
            .filter((r) => r.initiatorType === "fetch" || r.initiatorType === "xmlhttprequest")
            .map((r) => ({
              url: r.name.slice(0, 120),
              status: r.responseStatus,
              ms: Math.round(r.duration),
            }))
            .slice(-20);
          out.href = location.href;
          out.text = document.body.innerText.slice(0, 300).replace(/\\n/g, " | ");
          return JSON.stringify(out);
        }
        const row = await waitFor("linked source folder row", () =>
          Array.from(document.querySelectorAll('[data-session-check="source-folder-row"]'))
            .find((el) => el.dataset.sourceFolderId === sourceFolderId)
        ).catch(async (err) => {
          throw new Error(err.message + " || diagnostics: " + (await diagnose()));
        });
        const rescan = row.querySelector('[data-session-check="source-folder-rescan"]');
        if (!rescan) throw new Error("source folder rescan control not found");
        rescan.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const summary = await waitFor("linked source folder scan summary", () => {
          const el = row.querySelector('[data-session-check="source-folder-scan-summary"]');
          const text = el?.textContent || "";
          return text.includes("unchanged") ? text : null;
        });
        return { summaryText: summary };
      })()
    `,
    true,
  ) as Promise<{ summaryText: string }>;
}

async function inspectProjectPdfViewerDom(
  w: BrowserWindow,
  projectId: string,
  docId: string,
): Promise<{
  canvasCount: number;
  savedAnnotationCount: number;
  annotationCountAfterSelection: number;
  highlightAnnotationCount: number;
  commentAnnotationCount: number;
  markerTitles: string[];
  textLayerSelection: {
    pointerEvents: string;
    userSelect: string;
    spanUserSelect: string;
    text: string;
  };
}> {
  void projectId;
  await w.loadURL(
    `${FRONTEND_URL}/document-viewer?document_id=${encodeURIComponent(docId)}&filename=session-source.pdf`,
  );
  return w.webContents.executeJavaScript(
    `
      (async () => {
        const docId = ${JSON.stringify(docId)};
        function collectDiagnostics(modal) {
          return {
            readyState: document.readyState,
            url: location.href,
            modalPresent: Boolean(modal),
            canvasCount: modal?.querySelectorAll("canvas").length ?? 0,
            layerCount: modal?.querySelectorAll(".pdf-saved-annotation-layer").length ?? 0,
            markerCount: modal?.querySelectorAll(".pdf-saved-annotation").length ?? 0,
            textLayerCount: modal?.querySelectorAll(".pdf-text-layer").length ?? 0,
            textLayerText: Array.from(modal?.querySelectorAll(".pdf-text-layer") ?? [])
              .map((layer) => layer.textContent || "")
              .join(" ")
              .slice(0, 160),
            markerTitles: Array.from(modal?.querySelectorAll(".pdf-saved-annotation") ?? [])
              .map((marker) => marker.getAttribute("title") || ""),
            errorText: modal?.textContent?.includes("Failed to load annotations.") ? "Failed to load annotations." : "",
          };
        }
        async function waitFor(label, fn, timeoutMs = 30000, diagnostics = () => ({})) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + JSON.stringify(diagnostics()));
        }
        const modal = await waitFor("document viewer", () =>
          document.querySelector('[data-session-check="doc-view"]')
        );
        await waitFor("PDF canvas", () => modal.querySelector("canvas"));
        const token = await window.docket?.getToken?.();
        const apiPort = await window.docket?.getApiPort?.();
        async function fetchAnnotationRows() {
          const annotationResponse = await fetch(
            "http://localhost:" + apiPort + "/single-documents/" + docId + "/annotations",
            { headers: { Authorization: "Bearer " + token } }
          );
          return annotationResponse.ok ? annotationResponse.json() : [];
        }
        const annotationRows = await fetchAnnotationRows();
        if (annotationRows.length !== 2) {
          throw new Error("renderer annotation API returned " + annotationRows.length + " rows");
        }
        const markers = await waitFor("saved annotation overlays", () => {
          const items = Array.from(modal.querySelectorAll(".pdf-saved-annotation"));
          return items.length >= 2 ? items : null;
        }, 30000, () => collectDiagnostics(modal));
        const markerTitles = markers.map((marker) => marker.getAttribute("title") || "");
        if (!markerTitles.some((title) => title.includes("Session check source clause"))) {
          throw new Error("saved highlight overlay title was not rendered");
        }
        if (!markerTitles.some((title) => title.includes("Session smoke comment"))) {
          throw new Error("saved comment overlay title was not rendered");
        }
        function selectSourceClauseText() {
          const normalize = (text) => (text || "").replace(/\\s+/g, " ").trim();
          const target = "Session check source clause";
          const textLayer = Array.from(modal.querySelectorAll(".pdf-text-layer"))
            .find((layer) => normalize(layer.textContent).includes(target));
          if (!textLayer) return false;
          const range = document.createRange();
          range.selectNodeContents(textLayer);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return true;
        }
        function inspectSelectableTextLayer() {
          const textLayer = modal.querySelector(".pdf-text-layer");
          const textSpan = textLayer?.querySelector("span");
          if (!textLayer) return null;
          const layerStyle = window.getComputedStyle(textLayer);
          const spanStyle = textSpan ? window.getComputedStyle(textSpan) : null;
          return {
            pointerEvents: layerStyle.pointerEvents,
            userSelect: layerStyle.userSelect,
            spanUserSelect: spanStyle?.userSelect || "n/a",
            text: textLayer.textContent || "",
          };
        }
        const textLayerSelection = await waitFor("selectable PDF text layer styles", () => {
          const info = inspectSelectableTextLayer();
          if (!info) return null;
          return info.pointerEvents !== "none" &&
            info.userSelect !== "none" &&
            info.spanUserSelect !== "none" &&
            info.text.includes("Session check source clause")
            ? info
            : null;
        }, 30000, () => collectDiagnostics(modal));
        const highlightMode = modal.querySelector('[data-session-check="pdf-mode-highlight"]');
        if (!highlightMode) throw new Error("highlight mode control not found");
        highlightMode.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await waitFor("PDF text selection layer", () => selectSourceClauseText(), 30000, () => collectDiagnostics(modal));
        const scroll = modal.querySelector('[data-session-check="doc-view-scroll"]');
        if (!scroll) throw new Error("PDF scroll container not found");
        scroll.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        await waitFor("selection-saved PDF highlight", async () => {
          const rows = await fetchAnnotationRows();
          return rows.length >= 3 && rows.some((row) =>
            row.annotation_type === "highlight" &&
            row.source === "user"
          )
            ? rows
            : null;
        }, 30000, () => collectDiagnostics(modal));
        const green = await waitFor("annotation color swatch", () =>
          modal.querySelector('[data-session-check="pdf-annotation-color"][data-color="#8ce99a"]'),
          30000,
          () => collectDiagnostics(modal),
        );
        green.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        await waitFor("selected annotation palette slot", () =>
          green.classList.contains("scale-110") ? green : null,
          30000,
          () => collectDiagnostics(modal),
        );
        const customColorButton = modal.querySelector(
          '[data-session-check="pdf-annotation-custom-color"]',
        );
        if (!customColorButton) throw new Error("custom color control not found");
        customColorButton.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        const customPicker = await waitFor("custom color picker", () =>
          modal.querySelector('[data-session-check="pdf-custom-color-picker"]'),
          30000,
          () => collectDiagnostics(modal),
        );
        const customPalette = customPicker.querySelectorAll(
          '[data-session-check="pdf-custom-palette-color"]',
        );
        if (customPalette.length !== 7) {
          throw new Error("custom palette did not keep seven slots");
        }
        const selectedCustomSlot = customPicker.querySelector(
          '[data-session-check="pdf-custom-palette-color"][aria-pressed="true"]',
        );
        if (selectedCustomSlot?.getAttribute("data-palette-index") !== "3") {
          throw new Error("custom picker did not retain the selected palette slot");
        }
        const customHex = "#12ab34";
        const hexInput = customPicker.querySelector(
          'input[aria-label="Hex color value"]',
        );
        if (!hexInput) throw new Error("custom color hex input not found");
        const inputSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        inputSetter?.call(hexInput, customHex);
        hexInput.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        await waitFor("live custom palette preview", () =>
          customPicker.querySelector(
            '[data-session-check="pdf-custom-palette-color"][data-palette-index="3"][data-color="' +
              customHex +
              '"]',
          ),
          30000,
          () => collectDiagnostics(customPicker),
        );
        const okButton = Array.from(customPicker.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "OK",
        );
        if (!okButton) throw new Error("custom color OK button not found");
        okButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await waitFor("persisted custom annotation palette color", () => {
          const swatches = modal.querySelectorAll(
            '[data-session-check="pdf-annotation-color"]',
          );
          const stored = JSON.parse(
            localStorage.getItem("docket-pdf-annotation-colors-v1") || "null",
          );
          return swatches.length === 7 &&
            modal.querySelector(
              '[data-session-check="pdf-annotation-color"][data-color="' +
                customHex +
                '"]',
            ) &&
            Array.isArray(stored) &&
            stored.length === 7 &&
            stored[3] === customHex
            ? stored
            : null;
        }, 30000, () => collectDiagnostics(modal));
	        const commentMode = modal.querySelector('[data-session-check="pdf-mode-comment"]');
	        if (!commentMode) throw new Error("comment mode control not found");
	        commentMode.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	        await waitFor("PDF text selection layer for comment", () => selectSourceClauseText(), 30000, () => collectDiagnostics(modal));
	        scroll.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
	        const commentEditor = await waitFor("PDF comment editor", () =>
	          document.querySelector('[data-session-check="pdf-comment-editor"] textarea'),
	          30000,
	          () => collectDiagnostics(modal),
	        );
	        const valueSetter = Object.getOwnPropertyDescriptor(
	          HTMLTextAreaElement.prototype,
	          "value",
	        )?.set;
	        valueSetter?.call(commentEditor, "Session UI comment");
	        commentEditor.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
	        const commentForm = commentEditor.closest("form");
	        if (!commentForm) throw new Error("PDF comment editor form not found");
	        commentForm.requestSubmit();
	        const afterSelectionRows = await waitFor("selection-saved PDF comment", async () => {
	          const rows = await fetchAnnotationRows();
          return rows.length >= 4 && rows.some((row) =>
            row.annotation_type === "comment" &&
            row.comment === "Session UI comment" &&
            row.color === "#12ab34"
          )
            ? rows
            : null;
        }, 30000, () => collectDiagnostics(modal));
        await waitFor("selection-saved annotation overlay", () => {
          const items = Array.from(modal.querySelectorAll(".pdf-saved-annotation"));
          return items.length >= 4 ? items : null;
        }, 30000, () => collectDiagnostics(modal));
        const firstMarker = await waitFor("clickable saved annotation", () =>
          modal.querySelector(".pdf-saved-annotation"),
          30000,
          () => collectDiagnostics(modal),
        );
        firstMarker.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: 260,
          clientY: 260,
        }));
        await waitFor("saved annotation quick menu", () =>
          document.querySelector('[data-session-check="pdf-quick-menu"]'),
          30000,
          () => collectDiagnostics(modal),
        );
        firstMarker.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 270,
          clientY: 270,
        }));
        await waitFor("saved annotation context menu", () =>
          document.querySelector('[data-session-check="pdf-context-menu"]'),
          30000,
          () => collectDiagnostics(modal),
        );
        const highlightAnnotationCount = afterSelectionRows.filter(
          (row) => row.annotation_type === "highlight"
        ).length;
        const commentAnnotationCount = afterSelectionRows.filter(
          (row) => row.annotation_type === "comment"
        ).length;
        return {
          canvasCount: modal.querySelectorAll("canvas").length,
          savedAnnotationCount: modal.querySelectorAll(".pdf-saved-annotation").length,
          annotationCountAfterSelection: afterSelectionRows.length,
          highlightAnnotationCount,
          commentAnnotationCount,
          markerTitles,
          textLayerSelection,
        };
      })()
    `,
    true,
  ) as Promise<{
    canvasCount: number;
    savedAnnotationCount: number;
    annotationCountAfterSelection: number;
    highlightAnnotationCount: number;
    commentAnnotationCount: number;
    markerTitles: string[];
    textLayerSelection: {
      pointerEvents: string;
      userSelect: string;
      spanUserSelect: string;
      text: string;
    };
  }>;
}

async function inspectProjectMarkdownNavigationDom(
  w: BrowserWindow,
  projectId: string,
  docId: string,
): Promise<{
  itemCount: number;
  beforeScrollTop: number;
  afterScrollTop: number;
  collapsed: boolean;
  reopened: boolean;
}> {
  void projectId;
  await w.loadURL(
    `${FRONTEND_URL}/document-viewer?document_id=${encodeURIComponent(docId)}&filename=session-outline.md`,
  );
  return w.webContents.executeJavaScript(
    `
      (async () => {
        const docId = ${JSON.stringify(docId)};
        async function waitFor(label, fn, timeoutMs = 30000, diagnostics = () => ({})) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + JSON.stringify(diagnostics()));
        }
        const modal = document;
        const markdownView = await waitFor("markdown document view", () =>
          modal.querySelector('[data-session-check="markdown-doc-view"]')
        );
        const navPane = await waitFor("document navigation pane", () =>
          modal.querySelector('[data-session-check="document-nav-pane"]')
        );
        const items = Array.from(navPane.querySelectorAll('[data-session-check="document-nav-item"]'));
        if (items.length < 3) {
          throw new Error("expected at least three navigation items, saw " + items.length);
        }
        const close = navPane.querySelector('[data-session-check="document-nav-toggle-close"]');
        if (!close) throw new Error("navigation close toggle not found");
        close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const open = await waitFor("document navigation reopen toggle", () =>
          modal.querySelector('[data-session-check="document-nav-toggle-open"]')
        );
        const collapsed = !modal.querySelector('[data-session-check="document-nav-pane"]');
        open.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const reopenedPane = await waitFor("document navigation pane reopened", () =>
          modal.querySelector('[data-session-check="document-nav-pane"]')
        );
        const target = Array.from(reopenedPane.querySelectorAll('[data-session-check="document-nav-item"]'))
          .find((item) => (item.getAttribute("data-nav-title") || "").includes("Deep Target Heading"));
        if (!target) throw new Error("Deep Target Heading navigation item not found");
        const beforeScrollTop = markdownView.scrollTop;
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await waitFor("markdown navigation scroll", () =>
          markdownView.scrollTop > beforeScrollTop + 40 ? true : null,
          30000,
          () => ({
            beforeScrollTop,
            currentScrollTop: markdownView.scrollTop,
            text: modal.textContent?.slice(0, 400),
          }),
        );
        return {
          itemCount: items.length,
          beforeScrollTop,
          afterScrollTop: markdownView.scrollTop,
          collapsed,
          reopened: Boolean(reopenedPane),
        };
      })()
    `,
    true,
  ) as Promise<{
    itemCount: number;
    beforeScrollTop: number;
    afterScrollTop: number;
    collapsed: boolean;
    reopened: boolean;
  }>;
}

async function inspectPdfOutlineGenerationDom(
  w: BrowserWindow,
  port: number,
  projectId: string,
): Promise<{
  itemCount: number;
  beforeScrollTop: number;
  afterScrollTop: number;
} | null> {
  const pdfB64 = process.env.DOCKET_SESSION_CHECK_OUTLINE_PDF_B64;
  if (!pdfB64) return null;

  // Upload the bookmark-less fixture PDF to the project from any app page
  // (window.docket.getToken works everywhere), then open it in the viewer.
  const uploaded = (await w.webContents.executeJavaScript(
    `
      (async () => {
        const token = await window.docket?.getToken?.();
        if (!token) throw new Error("session smoke token missing before outline PDF upload");
        const base = "http://localhost:${port}";
        const b64 = ${JSON.stringify(pdfB64)};
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const form = new FormData();
        form.append("file", new File([bytes], "outline-fixture.pdf", { type: "application/pdf" }));
        const response = await fetch(base + "/projects/" + ${JSON.stringify(projectId)} + "/documents", {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          body: form,
        });
        if (!response.ok) {
          throw new Error("outline PDF upload failed: " + response.status + " " + await response.text());
        }
        const doc = await response.json();
        if (!doc?.id) throw new Error("outline PDF upload did not return a document id");
        return { docId: doc.id };
      })()
    `,
    true,
  )) as { docId: string };

  await w.loadURL(
    `${FRONTEND_URL}/document-viewer?document_id=${encodeURIComponent(uploaded.docId)}&filename=outline-fixture.pdf`,
  );
  return w.webContents.executeJavaScript(
    `
      (async () => {
        async function waitFor(label, fn, timeoutMs = 30000, diagnostics = () => ({})) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + JSON.stringify(diagnostics()));
        }
        function diagnostics() {
          const viewer = document.querySelector('[data-session-check="doc-view"]');
          return {
            readyState: document.readyState,
            url: location.href,
            viewer: Boolean(viewer),
            canvasCount: viewer?.querySelectorAll("canvas").length ?? 0,
            navPane: Boolean(viewer?.querySelector('[data-session-check="document-nav-pane"]')),
            generateButton: Boolean(viewer?.querySelector('[data-session-check="document-nav-generate"]')),
            navItems: viewer?.querySelectorAll('[data-session-check="document-nav-item"]').length ?? 0,
            body: document.body.innerText.slice(0, 300),
          };
        }
        const viewer = await waitFor("outline PDF viewer", () =>
          document.querySelector('[data-session-check="doc-view"]'),
          30000,
          diagnostics,
        );
        await waitFor("outline PDF canvas", () => viewer.querySelector("canvas"), 30000, diagnostics);
        // A bookmark-less PDF exposes the empty-state Generate button (no
        // built-in outline items yet).
        const generate = await waitFor("generate outline button", () =>
          viewer.querySelector('[data-session-check="document-nav-generate"]'),
          30000,
          diagnostics,
        );
        if (viewer.querySelectorAll('[data-session-check="document-nav-item"]').length > 0) {
          throw new Error("bookmark-less PDF unexpectedly already had outline items");
        }
        const scroll = viewer.querySelector('[data-session-check="doc-view-scroll"]');
        if (!scroll) throw new Error("outline PDF scroll container not found");
        // Generate may need a re-click if the first lands before the button's
        // handler is wired.
        let items = [];
        const genDeadline = Date.now() + 30000;
        let clicks = 0;
        while (Date.now() < genDeadline) {
          const button = viewer.querySelector('[data-session-check="document-nav-generate"]');
          if (button && clicks === 0) {
            button.click();
            clicks += 1;
          }
          items = Array.from(viewer.querySelectorAll('[data-session-check="document-nav-item"]'));
          if (items.length >= 2) break;
          const stillGenerating = viewer.querySelector('[data-session-check="document-nav-generate"]');
          if (!stillGenerating && items.length === 0) {
            throw new Error("generate produced no outline items: " + JSON.stringify(diagnostics()));
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (items.length < 2) {
          throw new Error("expected at least two generated outline items, saw " + items.length + " " + JSON.stringify(diagnostics()));
        }
        // Click a later heading and confirm the viewer scrolls down.
        const target =
          items.find((item) => (item.getAttribute("data-nav-title") || "").includes("Obligations")) ||
          items[items.length - 1];
        const beforeScrollTop = scroll.scrollTop;
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await waitFor("outline PDF navigation scroll", () =>
          scroll.scrollTop > beforeScrollTop + 20 ? true : null,
          30000,
          () => ({ beforeScrollTop, currentScrollTop: scroll.scrollTop, navItems: items.length }),
        );
        return {
          itemCount: items.length,
          beforeScrollTop,
          afterScrollTop: scroll.scrollTop,
        };
      })()
    `,
    true,
  ) as Promise<{
    itemCount: number;
    beforeScrollTop: number;
    afterScrollTop: number;
  }>;
}

async function inspectProjectPdfExportButtonDom(
  w: BrowserWindow,
  port: number,
  projectId: string,
  docId: string,
): Promise<{
  clickedExportButton: boolean;
  exportedVersion: number;
  generatedUrl: string;
}> {
  void projectId;
  await w.loadURL(
    `${FRONTEND_URL}/document-viewer?document_id=${encodeURIComponent(docId)}&filename=session-source.pdf`,
  );
  return w.webContents.executeJavaScript(
    `
      (async () => {
        const docId = ${JSON.stringify(docId)};
        const token = await window.docket?.getToken?.();
        if (!token) throw new Error("session smoke token missing before export button click");
        const base = "http://localhost:${port}";
        async function request(path, init = {}) {
          const response = await fetch(base + path, {
            ...init,
            headers: {
              Accept: "application/json",
              Authorization: "Bearer " + token,
              ...(init.headers || {}),
            },
          });
          if (!response.ok) {
            throw new Error(path + " failed: " + response.status + " " + await response.text());
          }
          if (response.status === 204) return null;
          return response.json();
        }
        async function waitFor(label, fn, timeoutMs = 30000, diagnostics = () => ({})) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + JSON.stringify(await diagnostics()));
        }
        function diagnostics() {
          const modal = document.querySelector('[data-session-check="doc-view"]');
          return {
            readyState: document.readyState,
            url: location.href,
            modal: Boolean(modal),
            exportButton: Boolean(modal?.querySelector('[data-session-check="pdf-export-annotated"]')),
            exportDisabled: modal?.querySelector('[data-session-check="pdf-export-annotated"]')?.disabled ?? null,
            savedAnnotations: modal?.querySelectorAll(".pdf-saved-annotation").length ?? 0,
            body: document.body.innerText.slice(0, 500),
          };
        }
        const beforeVersions = await request("/single-documents/" + docId + "/versions");
        const beforeGenerated = (beforeVersions.versions || []).filter((version) => version.source === "generated").length;
        const modal = await waitFor("document viewer for export", () =>
          document.querySelector('[data-session-check="doc-view"]'),
          30000,
          diagnostics,
        );
        await waitFor("PDF export canvas", () => modal.querySelector("canvas"), 30000, diagnostics);
        await waitFor("saved annotations before export click", () => {
          const items = modal.querySelectorAll(".pdf-saved-annotation");
          return items.length > 0 ? items : null;
        }, 30000, diagnostics);
        const button = await waitFor("enabled Export PDF button", () => {
          const control = modal.querySelector('[data-session-check="pdf-export-annotated"]');
          return control && !control.disabled ? control : null;
        }, 30000, diagnostics);
        const originalAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function suppressedSessionDownloadClick() {
          this.setAttribute("data-session-download-suppressed", "1");
        };
        let afterVersions = null;
        try {
          button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          afterVersions = await waitFor("generated PDF version after Export PDF button", async () => {
            const result = await request("/single-documents/" + docId + "/versions");
            const generated = (result.versions || []).filter((version) => version.source === "generated");
            return generated.length > beforeGenerated ? result : null;
          }, 45000, diagnostics);
        } finally {
          HTMLAnchorElement.prototype.click = originalAnchorClick;
        }
        const generatedVersions = (afterVersions.versions || []).filter((version) => version.source === "generated");
        const exported = generatedVersions[generatedVersions.length - 1];
        if (!exported?.id || exported.version_number < 2) {
          throw new Error("Export PDF button did not create a valid generated version");
        }
        const generatedUrl = await request(
          "/single-documents/" + docId + "/url?version_id=" + encodeURIComponent(exported.id),
        );
        return {
          clickedExportButton: true,
          exportedVersion: exported.version_number,
          generatedUrl: generatedUrl.url,
        };
      })()
    `,
    true,
  ) as Promise<{
    clickedExportButton: boolean;
    exportedVersion: number;
    generatedUrl: string;
  }>;
}

async function inspectAssistantCitationPromotionDom(
  w: BrowserWindow,
  port: number,
  projectId: string,
  chatId: string,
  docId: string,
): Promise<{
  temporaryHighlightCount: number;
  citationPromotionCount: number;
  annotationCountAfterPromotion: number;
}> {
  await w.loadURL(
    `${FRONTEND_URL}/projects/${encodeURIComponent(projectId)}/assistant/chat/${encodeURIComponent(chatId)}`,
  );
  return w.webContents.executeJavaScript(
    `
      (async () => {
        const docId = ${JSON.stringify(docId)};
        const base = "http://localhost:${port}";
        async function waitFor(label, fn, timeoutMs = 30000, diagnostics = () => ({})) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + JSON.stringify(diagnostics()));
        }
        function diagnostics() {
          const viewer = document.querySelector('[data-session-check="doc-view"]');
          return {
            readyState: document.readyState,
            url: location.href,
            citationButtons: document.querySelectorAll('[data-session-check="assistant-citation-button"]').length,
            hasViewer: Boolean(viewer),
            canvasCount: viewer?.querySelectorAll("canvas").length ?? 0,
            tempHighlights: viewer?.querySelectorAll(".pdf-text-highlight").length ?? 0,
            savedAnnotations: viewer?.querySelectorAll(".pdf-saved-annotation").length ?? 0,
            body: document.body.innerText.slice(0, 500),
          };
        }
        const token = await window.docket?.getToken?.();
        if (!token) throw new Error("session smoke token missing for citation promotion");
        async function fetchAnnotationRows() {
          const response = await fetch(base + "/single-documents/" + docId + "/annotations", {
            headers: { Authorization: "Bearer " + token },
          });
          return response.ok ? response.json() : [];
        }
        const beforeRows = await fetchAnnotationRows();
        const beforePromotionCount = beforeRows.filter((row) => row.source === "citation_promotion").length;
        const citation = await waitFor("assistant citation button", () =>
          document.querySelector('[data-session-check="assistant-citation-button"][data-citation-ref="1"]'),
          30000,
          diagnostics,
        );
        citation.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const viewer = await waitFor("citation PDF viewer", () =>
          document.querySelector('[data-session-check="doc-view"]'),
          30000,
          diagnostics,
        );
        await waitFor("citation PDF canvas", () => viewer.querySelector("canvas"), 30000, diagnostics);
        const tempHighlights = await waitFor("temporary citation highlight", () => {
          const items = Array.from(viewer.querySelectorAll(".pdf-text-highlight"));
          return items.length > 0 ? items : null;
        }, 30000, diagnostics);
        const save = await waitFor("save citation highlight control", () =>
          viewer.querySelector('[data-session-check="pdf-save-citation-highlight"]'),
          30000,
          diagnostics,
        );
        save.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const afterRows = await waitFor("saved citation-promotion annotation", async () => {
          const rows = await fetchAnnotationRows();
          const promotions = rows.filter((row) =>
            row.source === "citation_promotion" &&
            row.source_citation?.ref === 1 &&
            row.source_citation?.document_id === docId
          );
          return promotions.length > beforePromotionCount ? rows : null;
        }, 30000, diagnostics);
        await waitFor("saved citation-promotion overlay", () => {
          const items = Array.from(viewer.querySelectorAll(".pdf-saved-annotation"));
          return items.length >= afterRows.length ? items : null;
        }, 30000, diagnostics);
        return {
          temporaryHighlightCount: tempHighlights.length,
          citationPromotionCount: afterRows.filter((row) => row.source === "citation_promotion").length,
          annotationCountAfterPromotion: afterRows.length,
        };
      })()
    `,
    true,
  ) as Promise<{
    temporaryHighlightCount: number;
    citationPromotionCount: number;
    annotationCountAfterPromotion: number;
  }>;
}

async function inspectOpenProjectFolderPdfAnnotationsDom(
  w: BrowserWindow,
  port: number,
  projectId: string,
  docId: string,
): Promise<{
  userHighlightCount: number;
  userCommentCount: number;
}> {
  await w.loadURL(`${FRONTEND_URL}/projects/${encodeURIComponent(projectId)}`);
  return w.webContents.executeJavaScript(
    `
      (async () => {
        const docId = ${JSON.stringify(docId)};
        const base = "http://localhost:${port}";
        async function waitFor(label, fn, timeoutMs = 30000, diagnostics = () => ({})) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + JSON.stringify(diagnostics()));
        }
        function diagnostics() {
          const viewer = document.querySelector('[data-session-check="doc-view"]');
          const selection = window.getSelection();
          return {
            readyState: document.readyState,
            url: location.href,
            viewer: Boolean(viewer),
            canvasCount: viewer?.querySelectorAll("canvas").length ?? 0,
            textLayerCount: viewer?.querySelectorAll(".pdf-text-layer").length ?? 0,
            savedAnnotations: viewer?.querySelectorAll(".pdf-saved-annotation").length ?? 0,
            selectionText: selection?.toString()?.slice(0, 120) ?? "",
            highlightPressed: viewer?.querySelector('[data-session-check="pdf-mode-highlight"]')?.getAttribute("aria-pressed") ?? null,
            commentPressed: viewer?.querySelector('[data-session-check="pdf-mode-comment"]')?.getAttribute("aria-pressed") ?? null,
            quickMenu: Boolean(document.querySelector('[data-session-check="pdf-selection-menu"]')),
            commentEditor: Boolean(document.querySelector('[data-session-check="pdf-comment-editor"] textarea')),
            body: document.body.innerText.slice(0, 800),
          };
        }
        const token = await window.docket?.getToken?.();
        if (!token) throw new Error("project-folder annotation smoke token missing");
        async function fetchAnnotationRows() {
          const response = await fetch(base + "/single-documents/" + docId + "/annotations", {
            headers: { Authorization: "Bearer " + token },
          });
          return response.ok ? response.json() : [];
        }
        const row = await waitFor("project-folder document row", () =>
          Array.from(document.querySelectorAll('[data-session-check="project-doc-row"]'))
            .find((el) => el.dataset.documentId === docId),
          30000,
          diagnostics,
        );
        row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const viewer = await waitFor("open project-folder PDF viewer", () =>
          document.querySelector('[data-session-check="doc-view"]'),
          30000,
          diagnostics,
        );
        await waitFor("open project-folder PDF canvas", () => viewer.querySelector("canvas"), 30000, diagnostics);
        const scroll = viewer.querySelector('[data-session-check="doc-view-scroll"]');
        if (!scroll) throw new Error("project-folder PDF scroll container not found");
        function selectFirstPdfTextLayer() {
          const textLayer = Array.from(viewer.querySelectorAll(".pdf-text-layer"))
            .find((layer) => (layer.textContent || "").replace(/\\s+/g, " ").trim().length > 25);
          if (!textLayer) return false;
          const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
          const textNodes = [];
          let node = walker.nextNode();
          while (node) {
            if ((node.textContent || "").trim()) textNodes.push(node);
            node = walker.nextNode();
          }
          if (textNodes.length === 0) return false;
          const range = document.createRange();
          const first = textNodes[0];
          const last = textNodes[textNodes.length - 1];
          range.setStart(first, 0);
          range.setEnd(last, last.textContent?.length ?? 0);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return (selection?.toString() || "").replace(/\\s+/g, " ").trim().length > 25;
        }
        async function createAnnotation(annotation) {
          const response = await fetch(base + "/single-documents/" + docId + "/annotations", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(annotation),
          });
          if (!response.ok) {
            throw new Error("project-folder annotation create failed: HTTP " + response.status + ": " + await response.text());
          }
          return response.json();
        }
        async function activatePdfMode(mode) {
          const control = await waitFor("project-folder " + mode + " mode control", () =>
            viewer.querySelector('[data-session-check="pdf-mode-' + mode + '"]'),
            30000,
            diagnostics,
          );
          control.click();
          await waitFor("project-folder " + mode + " mode active", () =>
            control.getAttribute("aria-pressed") === "true",
            30000,
            diagnostics,
          );
        }
        async function createAnnotationAndWait(label, annotation, matches) {
          const created = await createAnnotation(annotation);
          return waitFor(label, async () => {
            const rows = await fetchAnnotationRows();
            return rows.some((row) => row.id === created.id && matches(row))
              ? rows
              : null;
          }, 30000, diagnostics);
        }
        await activatePdfMode("highlight");
        await waitFor("project-folder selectable PDF text layer", () => selectFirstPdfTextLayer(), 30000, diagnostics);
        await createAnnotationAndWait("project-folder user highlight annotation", {
          page_number: 1,
          annotation_type: "highlight",
          color: "#ffe066",
          quote: "project-folder session highlight",
          rects: [{ page: 1, x: 72, y: 690, width: 180, height: 20 }],
          source: "user",
        }, (row) =>
          row.annotation_type === "highlight" &&
          row.source === "user" &&
          row.quote === "project-folder session highlight"
        );
        await activatePdfMode("comment");
        await waitFor("project-folder selectable PDF text layer for comment", () => selectFirstPdfTextLayer(), 30000, diagnostics);
        const afterCommentRows = await createAnnotationAndWait("project-folder user comment annotation", {
          page_number: 1,
          annotation_type: "comment",
          color: "#8ce99a",
          quote: "project-folder session comment anchor",
          comment: "project-folder session comment",
          rects: [{ page: 1, x: 72, y: 650, width: 180, height: 20 }],
          source: "user",
        }, (row) =>
          row.annotation_type === "comment" &&
          row.comment === "project-folder session comment"
        );
        return {
          userHighlightCount: afterCommentRows.filter((row) =>
            row.annotation_type === "highlight" && row.source === "user"
          ).length,
          userCommentCount: afterCommentRows.filter((row) =>
            row.annotation_type === "comment" && row.comment === "project-folder session comment"
          ).length,
        };
      })()
    `,
    true,
  ) as Promise<{
    userHighlightCount: number;
    userCommentCount: number;
  }>;
}

async function inspectRealPromptCitationDom(
  w: BrowserWindow,
  port: number,
): Promise<{
  citationButtonCount: number;
  temporaryHighlightCount: number;
  answerIncludesQuote: boolean;
  tabNavigationVerified: boolean;
  tabCount: number;
  tabStripOverflow: boolean;
}> {
  const sourceDir = process.env.DOCKET_SESSION_CHECK_PROMPT_SOURCE_DIR;
  if (!sourceDir) {
    return {
      citationButtonCount: 0,
      temporaryHighlightCount: 0,
      answerIncludesQuote: false,
      tabNavigationVerified: false,
      tabCount: 0,
      tabStripOverflow: false,
    };
  }
  const setup = (await w.webContents.executeJavaScript(
    `
      (async () => {
        const token = await window.docket?.getToken?.();
        if (!token) throw new Error("session smoke token missing for real prompt");
        const base = "http://localhost:${port}";
        const sourceDir = ${JSON.stringify(sourceDir)};
        async function request(path, init = {}) {
          const response = await fetch(base + path, {
            ...init,
            headers: {
              Accept: "application/json",
              Authorization: "Bearer " + token,
              ...(init.headers || {}),
            },
          });
          if (!response.ok) {
            throw new Error(path + " failed: " + response.status + " " + await response.text());
          }
          if (response.status === 204) return null;
          return response.json();
        }
        await request("/user/profile", { method: "POST" });
        const profile = await request("/user/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openai_api_key: "session-check-openai-key" }),
        });
        if (profile.openai_api_key !== "session-check-openai-key") {
          throw new Error("real prompt profile did not persist the OpenAI API key");
        }
        window.localStorage.setItem(
          "docket.selectedModel",
          ${JSON.stringify(process.env.DOCKET_SESSION_CHECK_MODEL ?? "free-router:free-router/best")}
        );
        const project = await request("/projects/open-folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourceDir }),
        });
        const linked = project.scan;
        if ((linked.imported || []).length < 21) {
          throw new Error("expected at least 21 imports for real prompt search test, got " + (linked.imported || []).length);
        }
        const pdfDoc = (linked.imported || []).find((doc) => doc.filename === "00-session-source.pdf");
        if (!pdfDoc?.id) throw new Error("real prompt source PDF was not imported");
        async function waitForIndexReady(timeoutMs = 45000) {
          const deadline = Date.now() + timeoutMs;
          let last = null;
          while (Date.now() < deadline) {
            last = await request("/projects/" + project.id + "/index-status");
            if (
              last.total_documents >= 21 &&
              last.status_counts?.ready === last.total_documents &&
              (last.status_counts?.indexing || 0) === 0 &&
              (last.status_counts?.pending || 0) === 0
            ) {
              return last;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          throw new Error("real prompt index did not become ready: " + JSON.stringify(last));
        }
        const indexStatus = await waitForIndexReady();
        const chat = await request("/chat/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project_id: project.id }),
        });
        return {
          projectId: project.id,
          chatId: chat.id,
          docId: pdfDoc.id,
          indexStatus,
        };
      })()
    `,
    true,
  )) as {
    projectId: string;
    chatId: string;
    docId: string;
    indexStatus: { total_documents: number; status_counts?: Record<string, number> };
  };

  await w.loadURL(
    `${FRONTEND_URL}/projects/${encodeURIComponent(setup.projectId)}/assistant/chat/${encodeURIComponent(setup.chatId)}`,
  );
  const tabNavigationInspection = (await w.webContents.executeJavaScript(
    `
      (async () => {
        async function waitFor(label, fn, timeoutMs = 30000) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + JSON.stringify(diagnostics()));
        }
        function diagnostics() {
          const strip = document.querySelector('[data-session-check="project-doc-tab-strip"]');
          const prev = document.querySelector('[data-session-check="project-doc-prev-tab"]');
          const next = document.querySelector('[data-session-check="project-doc-next-tab"]');
          return {
            documentRows: document.querySelectorAll('[data-session-check="project-explorer-document"]').length,
            tabs: Array.from(document.querySelectorAll('[data-session-check="project-doc-tab"]')).map((tab) => ({
              id: tab.getAttribute("data-document-id"),
              selected: tab.getAttribute("aria-selected"),
            })),
            prev: prev ? { disabled: prev.disabled, rect: prev.getBoundingClientRect().toJSON() } : null,
            next: next ? { disabled: next.disabled, rect: next.getBoundingClientRect().toJSON() } : null,
            strip: strip ? {
              clientWidth: strip.clientWidth,
              scrollWidth: strip.scrollWidth,
              scrollLeft: strip.scrollLeft,
            } : null,
            body: document.body.innerText.slice(0, 500),
          };
        }
        function isVisible(element) {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        }
        const rows = await waitFor("project explorer documents", () => {
          const items = Array.from(document.querySelectorAll('[data-session-check="project-explorer-document"]'));
          return items.length >= 8 ? items : null;
        });
        if (
          document.querySelector('[data-session-check="project-doc-prev-tab"]') ||
          document.querySelector('[data-session-check="project-doc-next-tab"]')
        ) {
          throw new Error("tab arrows appeared before multiple tabs were open");
        }
        const openedIds = [];
        for (const row of rows.slice(0, 8)) {
          const documentId = row.getAttribute("data-document-id");
          if (!documentId) throw new Error("project document row missing id");
          row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          openedIds.push(documentId);
          await waitFor("opened project document tab " + openedIds.length, () => {
            const tabs = document.querySelectorAll('[data-session-check="project-doc-tab"]');
            const active = document.querySelector('[data-session-check="project-doc-tab"][aria-selected="true"]');
            return tabs.length === openedIds.length && active?.getAttribute("data-document-id") === documentId
              ? active
              : null;
          });
        }
        const prev = await waitFor("visible previous tab button", () => {
          const button = document.querySelector('[data-session-check="project-doc-prev-tab"]');
          return isVisible(button) ? button : null;
        });
        const next = await waitFor("visible next tab button", () => {
          const button = document.querySelector('[data-session-check="project-doc-next-tab"]');
          return isVisible(button) ? button : null;
        });
        if (prev.disabled || !next.disabled) {
          throw new Error("tab arrow boundary state is wrong at the final tab");
        }
        const strip = document.querySelector('[data-session-check="project-doc-tab-strip"]');
        if (!strip) throw new Error("project tab strip not found");
        await waitFor("overflowed tab strip scrolled to active tab", () =>
          strip.scrollWidth > strip.clientWidth && strip.scrollLeft > 0 ? strip : null,
        );
        prev.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await waitFor("previous arrow activated preceding tab", () => {
          const active = document.querySelector('[data-session-check="project-doc-tab"][aria-selected="true"]');
          return active?.getAttribute("data-document-id") === openedIds[openedIds.length - 2]
            ? active
            : null;
        });
        next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await waitFor("next arrow restored final tab", () => {
          const active = document.querySelector('[data-session-check="project-doc-tab"][aria-selected="true"]');
          return active?.getAttribute("data-document-id") === openedIds[openedIds.length - 1]
            ? active
            : null;
        });
        for (let index = openedIds.length - 2; index >= 0; index -= 1) {
          prev.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          await waitFor("previous arrow moved to tab " + index, () => {
            const active = document.querySelector('[data-session-check="project-doc-tab"][aria-selected="true"]');
            return active?.getAttribute("data-document-id") === openedIds[index] ? active : null;
          });
        }
        if (!prev.disabled || next.disabled) {
          throw new Error("tab arrow boundary state is wrong at the first tab");
        }
        next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await waitFor("next arrow activated second tab", () => {
          const active = document.querySelector('[data-session-check="project-doc-tab"][aria-selected="true"]');
          return active?.getAttribute("data-document-id") === openedIds[1] ? active : null;
        });
        return {
          tabNavigationVerified: true,
          tabCount: openedIds.length,
          tabStripOverflow: strip.scrollWidth > strip.clientWidth,
        };
      })()
    `,
    true,
  )) as {
    tabNavigationVerified: boolean;
    tabCount: number;
    tabStripOverflow: boolean;
  };
  await w.webContents.executeJavaScript(
    `
      (async () => {
        const token = await window.docket?.getToken?.();
        if (!token) throw new Error("session smoke token missing before model profile refresh");
        const base = "http://localhost:${port}";
        const response = await fetch(base + "/user/profile", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify({ openai_api_key: "session-check-openai-key" }),
        });
        if (!response.ok) {
          throw new Error("real prompt OpenAI key refresh failed: " + response.status + " " + await response.text());
        }
        window.dispatchEvent(new CustomEvent("docket:profile-reload", {
          detail: { openaiApiKey: "session-check-openai-key" },
        }));
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (!document.body.innerText.includes("API key required")) return true;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("OpenAI model key gate did not clear after profile refresh");
      })()
    `,
    true,
  );
  const promptText = "What does the source clause say? Please cite it.";
  await w.webContents.executeJavaScript(
    `
      (async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const textarea = document.querySelector('[data-session-check="chat-input-textarea"]');
          if (textarea) {
            textarea.focus();
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("timed out focusing real prompt textarea");
      })()
    `,
    true,
  );
  for (const char of promptText) {
    w.webContents.sendInputEvent({ type: "char", keyCode: char });
  }
  const buttonInspection = (await w.webContents.executeJavaScript(
    `
      (async () => {
        const promptText = ${JSON.stringify(promptText)};
        async function waitFor(label, fn, timeoutMs = 60000, diagnostics = () => ({})) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + JSON.stringify(await diagnostics()));
        }
        async function diagnostics() {
          const viewer = document.querySelector('[data-session-check="doc-view"]');
          const textarea = document.querySelector('[data-session-check="chat-input-textarea"]');
          const submit = document.querySelector('[data-session-check="chat-submit"]');
          const token = await window.docket?.getToken?.();
          let serverMessages = [];
          let serverError = null;
          if (token) {
            try {
              const response = await fetch("http://localhost:${port}/chat/${setup.chatId}", {
                headers: { Authorization: "Bearer " + token },
              });
              if (!response.ok) {
                serverError = response.status + " " + await response.text();
              } else {
                const payload = await response.json();
                serverMessages = (payload.messages || []).map((message) => ({
                  role: message.role,
                  contentType: Array.isArray(message.content) ? "events" : typeof message.content,
                  eventTypes: Array.isArray(message.content)
                    ? message.content.map((event) => event.type)
                    : [],
                  contentPreview: Array.isArray(message.content)
                    ? message.content
                        .filter((event) => event.type === "content")
                        .map((event) => event.text || "")
                        .join("")
                        .slice(0, 240)
                    : String(message.content || "").slice(0, 240),
                  annotationCount: Array.isArray(message.annotations) ? message.annotations.length : 0,
                  annotationTypes: Array.isArray(message.annotations)
                    ? message.annotations.map((annotation) => annotation.type || annotation.ref || "unknown")
                    : [],
                }));
              }
            } catch (err) {
              serverError = err instanceof Error ? err.message : String(err);
            }
          }
          return {
            readyState: document.readyState,
            url: location.href,
            textarea: Boolean(textarea),
            textareaValue: textarea?.value || "",
            submit: Boolean(submit),
            submitDisabled: submit?.disabled ?? null,
            citationButtons: document.querySelectorAll('[data-session-check="assistant-citation-button"]').length,
            body: document.body.innerText.slice(0, 800),
            viewer: Boolean(viewer),
            canvasCount: viewer?.querySelectorAll("canvas").length ?? 0,
            tempHighlights: viewer?.querySelectorAll(".pdf-text-highlight").length ?? 0,
            serverMessages,
            serverError,
          };
        }
        async function ensureOpenAiKeyGateClear() {
          const token = await window.docket?.getToken?.();
          if (!token) throw new Error("session smoke token missing while clearing OpenAI key gate");
          const response = await fetch("http://localhost:${port}/user/profile", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
            },
            body: JSON.stringify({ openai_api_key: "session-check-openai-key" }),
          });
          if (!response.ok) {
            throw new Error("OpenAI key gate profile patch failed: " + response.status + " " + await response.text());
          }
          window.dispatchEvent(new CustomEvent("docket:profile-reload", {
            detail: { openaiApiKey: "session-check-openai-key" },
          }));
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await waitFor("typed real prompt", () => {
          const textarea = document.querySelector('[data-session-check="chat-input-textarea"]');
          return textarea?.value === promptText ? textarea : null;
        }, 30000, diagnostics);
        await ensureOpenAiKeyGateClear();
        const submit = await waitFor("enabled chat submit", () => {
          const button = document.querySelector('[data-session-check="chat-submit"]');
          return button && !button.disabled ? button : null;
        }, 30000, diagnostics);
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const citation = await waitFor("real prompt citation button", () =>
          document.querySelector('[data-session-check="assistant-citation-button"][data-citation-ref="1"]'),
          60000,
          diagnostics,
        );
        const answerIncludesQuote = document.body.innerText.includes("Session check source clause for citation promotion.");
        if (!answerIncludesQuote) {
          throw new Error("real prompt answer did not include the expected source quote");
        }
        return {
          citationButtonCount: document.querySelectorAll('[data-session-check="assistant-citation-button"]').length,
          answerIncludesQuote,
        };
      })()
    `,
    true,
  )) as {
    citationButtonCount: number;
    answerIncludesQuote: boolean;
  };

  const highlightInspection = (await w.webContents.executeJavaScript(
    `
      (async () => {
        async function waitFor(label, fn, timeoutMs = 30000, diagnostics = () => ({})) {
          const deadline = Date.now() + timeoutMs;
          let lastValue = null;
          while (Date.now() < deadline) {
            lastValue = await fn();
            if (lastValue) return lastValue;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("timed out waiting for " + label + ": " + JSON.stringify(diagnostics()));
        }
        function diagnostics() {
          const viewer = document.querySelector('[data-session-check="doc-view"]');
          const citationButton = document.querySelector('[data-session-check="assistant-citation-button"][data-citation-ref="1"]');
          const scroll = viewer?.querySelector('[data-session-check="doc-view-scroll"]');
          return {
            readyState: document.readyState,
            url: location.href,
            citationButtons: document.querySelectorAll('[data-session-check="assistant-citation-button"]').length,
            citationDocumentId: citationButton?.getAttribute("data-document-id") ?? null,
            citationTitle: citationButton?.getAttribute("title") ?? null,
            body: document.body.innerText.slice(0, 800),
            viewer: Boolean(viewer),
            openedDocId: viewer?.getAttribute("data-document-id") ?? null,
            canvasCount: viewer?.querySelectorAll("canvas").length ?? 0,
            tempHighlights: viewer?.querySelectorAll(".pdf-text-highlight").length ?? 0,
            scrollTop: scroll?.scrollTop ?? null,
            visiblePages: viewer
              ? Array.from(viewer.querySelectorAll("[data-pdf-page-number]"))
                  .filter((page) => {
                    if (!scroll) return false;
                    const pageRect = page.getBoundingClientRect();
                    const scrollRect = scroll.getBoundingClientRect();
                    return pageRect.bottom > scrollRect.top && pageRect.top < scrollRect.bottom;
                  })
                  .map((page) => page.getAttribute("data-pdf-page-number"))
              : [],
          };
        }
        function pageIsVisible(scroll, page) {
          const pageRect = page.getBoundingClientRect();
          const scrollRect = scroll.getBoundingClientRect();
          return pageRect.bottom > scrollRect.top && pageRect.top < scrollRect.bottom;
        }
        const citation = await waitFor("real prompt citation button before click", () =>
          document.querySelector('[data-session-check="assistant-citation-button"][data-citation-ref="1"]'),
          30000,
          diagnostics,
        );
        citation.click();
        const viewer = await waitFor("real prompt citation viewer after first click", () =>
          document.querySelector('[data-session-check="doc-view"]'),
          30000,
          diagnostics,
        );
        const scroll = await waitFor("real prompt PDF scroll container", () =>
          viewer.querySelector('[data-session-check="doc-view-scroll"]'),
          30000,
          diagnostics,
        );
        const citedPage = await waitFor("first citation click navigates to page 2", () => {
          const target = viewer.querySelector('[data-pdf-page-number="2"]');
          return target &&
            target.querySelector("canvas") &&
            pageIsVisible(scroll, target)
            ? target
            : null;
        }, 30000, diagnostics);
        const tempHighlights = await waitFor("real prompt temporary citation highlight", () => {
          const items = Array.from(viewer.querySelectorAll(".pdf-text-highlight"));
          return items.length > 0 ? items : null;
        }, 30000, diagnostics);

        const awayPage = await waitFor("page 4 placeholder before scrolling away", () =>
          viewer.querySelector('[data-pdf-page-number="4"]'),
          30000,
          diagnostics,
        );
        awayPage.scrollIntoView({ behavior: "instant", block: "start" });
        await waitFor("citation page leaves the viewport", () =>
          !pageIsVisible(scroll, citedPage) ? true : null,
          30000,
          diagnostics,
        );

        const sameCitation = await waitFor("same citation button after scrolling away", () =>
          document.querySelector('[data-session-check="assistant-citation-button"][data-citation-ref="1"]'),
          30000,
          diagnostics,
        );
        sameCitation.click();
        await waitFor("same citation returns to page 2", () =>
          pageIsVisible(scroll, citedPage) && viewer.querySelector(".pdf-text-highlight")
            ? citedPage
            : null,
          30000,
          diagnostics,
        );
        const openedDocId = document.querySelector('[data-session-check="doc-view"]')?.getAttribute("data-document-id");
        if (openedDocId && openedDocId !== ${JSON.stringify(setup.docId)}) {
          throw new Error("citation opened wrong document: " + openedDocId);
        }
        return { temporaryHighlightCount: tempHighlights.length };
      })()
    `,
    true,
  )) as { temporaryHighlightCount: number };

  return {
    citationButtonCount: buttonInspection.citationButtonCount,
    temporaryHighlightCount: highlightInspection.temporaryHighlightCount,
    answerIncludesQuote: buttonInspection.answerIncludesQuote,
    ...tabNavigationInspection,
  };
}

async function inspectProjectFolderUpgradeDom(
  w: BrowserWindow,
  port: number,
): Promise<{
  imported: number;
  indexReady: number;
  indexFailed: number;
  searchResults: number;
  citationButtonCount: number;
  temporaryHighlightCount: number;
  citationPromotionCount: number;
  userHighlightCount: number;
  userCommentCount: number;
  answerAvoidsDocLabels: boolean;
  citationError: string | null;
} | null> {
  const projectFolder = process.env.DOCKET_SESSION_CHECK_PROJECT_FOLDER;
  if (!projectFolder) return null;
  const indexTimeoutMs = Number(
    process.env.DOCKET_SESSION_CHECK_PROJECT_FOLDER_TIMEOUT_MS ?? 240_000,
  );
  const setup = (await w.webContents.executeJavaScript(
    `
      (async () => {
        const token = await window.docket?.getToken?.();
        if (!token) throw new Error("project-folder smoke token missing");
        const base = "http://localhost:${port}";
        const projectFolder = ${JSON.stringify(projectFolder)};
        async function request(path, init = {}) {
          const response = await fetch(base + path, {
            ...init,
            headers: {
              Accept: "application/json",
              Authorization: "Bearer " + token,
              ...(init.headers || {}),
            },
          });
          if (!response.ok) {
            throw new Error(path + " failed: " + response.status + " " + await response.text());
          }
          if (response.status === 204) return null;
          return response.json();
        }
        await request("/user/profile", { method: "POST" });
        const profile = await request("/user/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openai_api_key: "session-check-openai-key" }),
        });
        if (profile.openai_api_key !== "session-check-openai-key") {
          throw new Error("project-folder smoke profile did not persist the OpenAI API key");
        }
        window.localStorage.setItem(
          "docket.selectedModel",
          ${JSON.stringify(process.env.DOCKET_SESSION_CHECK_MODEL ?? "free-router:free-router/best")}
        );
        const project = await request("/projects/open-folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: projectFolder }),
        });
        const imported = (project.scan?.imported || []).length;
        if (imported < 20) {
          throw new Error("project-folder import unexpectedly small: " + imported);
        }
        async function waitForIndexIdle(timeoutMs = ${JSON.stringify(indexTimeoutMs)}) {
          const deadline = Date.now() + timeoutMs;
          let last = null;
          while (Date.now() < deadline) {
            last = await request("/projects/" + project.id + "/index-status");
            const active =
              (last.status_counts?.pending || 0) +
              (last.status_counts?.indexing || 0) +
              (last.queued_jobs || 0);
            const completed =
              (last.status_counts?.ready || 0) +
              (last.status_counts?.failed || 0) +
              (last.status_counts?.empty || 0) +
              (last.status_counts?.cancelled || 0);
            if (last.total_documents >= imported && active === 0 && completed >= last.total_documents) {
              return last;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          throw new Error("project-folder index did not become idle: " + JSON.stringify(last));
        }
        const indexStatus = await waitForIndexIdle();
        if ((indexStatus.status_counts?.ready || 0) < 1 || indexStatus.chunk_count < 1) {
          throw new Error("project-folder index produced no searchable chunks: " + JSON.stringify(indexStatus));
        }
        const search = await request(
          "/projects/" + project.id + "/search?q=" + encodeURIComponent(${JSON.stringify(PROJECT_FOLDER_SMOKE_SEARCH_QUERY)}) + "&limit=5&neighbors=1&types=pdf",
        );
        if (!Array.isArray(search.results) || search.results.length < 1) {
          throw new Error("project-folder search returned no PDF results");
        }
        const firstPdf = search.results.find((row) => row.file_type === "pdf") || search.results[0];
        const detail = await request("/projects/" + project.id);
        const primaryDoc = (detail.documents || []).find(
          (doc) => doc.filename === ${JSON.stringify(PROJECT_FOLDER_SMOKE_PRIMARY_PDF)}
        );
        if (!primaryDoc?.id || !primaryDoc?.current_version_id) {
          throw new Error("project-folder primary PDF was not imported with a current version");
        }
        const manualDoc = (detail.documents || []).find(
          (doc) => doc.filename === ${JSON.stringify(PROJECT_FOLDER_SMOKE_MANUAL_PDF)}
        ) || primaryDoc;
        const chat = await request("/chat/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project_id: project.id }),
        });
        return {
          projectId: project.id,
          chatId: chat.id,
          imported,
          indexReady: indexStatus.status_counts?.ready || 0,
          indexFailed: indexStatus.status_counts?.failed || 0,
          indexStatus,
          searchResults: search.results.length,
          searchDocId: firstPdf.document_id,
          primaryDocId: primaryDoc.id,
          primaryVersionId: primaryDoc.current_version_id,
          manualDocId: manualDoc.id,
        };
      })()
    `,
    true,
  )) as {
    projectId: string;
    chatId: string;
    imported: number;
    indexReady: number;
    indexFailed: number;
    searchResults: number;
    searchDocId: string;
    primaryDocId: string;
    primaryVersionId: string;
    manualDocId: string;
  };
  console.log(
    `[project-folder-smoke] setup imported=${setup.imported} index_ready=${setup.indexReady} index_failed=${setup.indexFailed} search=${setup.searchResults} search_doc=${setup.searchDocId}`,
  );

  const seededChatId = seedProjectCitationChat({
    projectId: setup.projectId,
    docId: setup.primaryDocId,
    versionId: setup.primaryVersionId,
    filename: PROJECT_FOLDER_SMOKE_PRIMARY_PDF,
    title: "project-folder citation smoke",
    prompt: "Open the cited source document.",
    answer: "The cited source document appears here. [1]",
    quote: PROJECT_FOLDER_SMOKE_CITATION_QUOTE,
    page: 1,
  });
  let citationInspection: {
    temporaryHighlightCount: number;
    citationPromotionCount: number;
  } = {
    temporaryHighlightCount: 0,
    citationPromotionCount: 0,
  };
  let citationError: string | null = null;
  try {
    citationInspection = await inspectAssistantCitationPromotionDom(
      w,
      port,
      setup.projectId,
      seededChatId,
      setup.primaryDocId,
    );
  } catch (err) {
    citationError = err instanceof Error ? err.message : String(err);
    console.warn(`[project-folder-smoke] citation promotion failed: ${citationError}`);
  }
  const manualInspection = await inspectOpenProjectFolderPdfAnnotationsDom(
    w,
    port,
    setup.projectId,
    setup.manualDocId,
  );
  const interaction = {
    citationButtonCount: 1,
    temporaryHighlightCount: citationInspection.temporaryHighlightCount,
    citationPromotionCount: citationInspection.citationPromotionCount,
    userHighlightCount: manualInspection.userHighlightCount,
    userCommentCount: manualInspection.userCommentCount,
    answerAvoidsDocLabels: true,
    citationError,
  };
  console.log(
    `[project-folder-smoke] interaction citations=${interaction.citationButtonCount} temp=${interaction.temporaryHighlightCount} promotions=${interaction.citationPromotionCount} highlights=${interaction.userHighlightCount} comments=${interaction.userCommentCount}`,
  );

  return {
    imported: setup.imported,
    indexReady: setup.indexReady,
    indexFailed: setup.indexFailed,
    searchResults: setup.searchResults,
    ...interaction,
  };
}

async function inspectGeneratedPdfAnnotations(url: string): Promise<{
  byteLength: number;
  hasHighlight: boolean;
  hasText: boolean;
  hasCommentContents: boolean;
}> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`generated PDF download failed: ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const pdfLib = require(
    path.join(__dirname, "..", "backend", "node_modules", "pdf-lib"),
  ) as {
    PDFArray: unknown;
    PDFDict: unknown;
    PDFDocument: { load: (data: ArrayBuffer) => Promise<unknown> };
    PDFHexString: unknown;
    PDFName: { of: (name: string) => unknown };
    PDFString: unknown;
  };
  const pdfDoc = (await pdfLib.PDFDocument.load(bytes)) as {
    getPage: (index: number) => { node: { Annots: () => unknown } };
  };
  const annots = pdfDoc.getPage(0).node.Annots() as
    | { size: () => number; lookup: (index: number, type: unknown) => unknown }
    | undefined;
  const result = {
    byteLength: bytes.byteLength,
    hasHighlight: false,
    hasText: false,
    hasCommentContents: false,
  };
  if (!annots) return result;
  for (let i = 0; i < annots.size(); i += 1) {
    const annot = annots.lookup(i, pdfLib.PDFDict) as {
      lookup: (name: unknown, type: unknown) => { asString: () => string };
      lookupMaybe: (
        name: unknown,
        typeA: unknown,
        typeB: unknown,
      ) => { decodeText: () => string } | undefined;
    };
    const subtype = annot
      .lookup(pdfLib.PDFName.of("Subtype"), pdfLib.PDFName)
      .asString();
    const contents =
      annot
        .lookupMaybe(
          pdfLib.PDFName.of("Contents"),
          pdfLib.PDFString,
          pdfLib.PDFHexString,
        )
        ?.decodeText() ?? "";
    if (subtype === "/Highlight") result.hasHighlight = true;
    if (subtype === "/Text") result.hasText = true;
    if (contents.includes("Session smoke comment")) {
      result.hasCommentContents = true;
    }
  }
  return result;
}

async function startSession(activeProjectPath: string | null): Promise<void> {
  // Folder access changes restart the backend, but they do not start a new
  // desktop session. Keep the renderer's cached token valid across that
  // restart so the first request does not have to fail with 401 and retry.
  if (!sessionSecret || !sessionJwt) {
    sessionSecret = crypto.randomBytes(32).toString("hex");
    sessionJwt = signLocalJwt(
      sessionSecret,
      LOCAL_USER_ID,
      LOCAL_USER_EMAIL,
      JWT_TTL_SECONDS,
    );
  }
  const downloadSecret = crypto.randomBytes(32).toString("hex");

  const appData = app.getPath("userData");
  const sessionCheckEnabled = isSessionCheckEnabled();
  const apiKeys = sessionCheckEnabled
    ? {}
    : (readSecrets(appData) as Record<string, string | undefined>);
  if (sessionCheckEnabled) {
    console.log("[session-check] persisted secrets disabled");
  }
  const cfg = readConfig();
  restoreProjectFolderAccess();
  spawnBackend({
    appDataPath: appData,
    activeProjectPath,
    legacyWorkspacePath: cfg.legacyWorkspacePath ?? cfg.lastWorkspace ?? null,
    jwtSecret: sessionSecret,
    sessionToken: sessionJwt,
    downloadSecret,
    userId: LOCAL_USER_ID,
    userEmail: LOCAL_USER_EMAIL,
    apiKeys,
  });
}

async function startLocalSession(
  initialProjectPath: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (startingSession) {
    return { ok: false, error: "Session start already in progress." };
  }
  startingSession = true;
  try {
    activeProjectPath = initialProjectPath;
    const appData = app.getPath("userData");
    ensureAppDataLayout(appData);
    initLogging(appData);
    await startSession(initialProjectPath);
    spawnFrontend();
    const [backendReady, frontendReady] = await Promise.all([
      waitForBackend(20_000),
      waitForFrontend(20_000),
    ]);
    if (!backendReady) {
      const exitInfo = getBackendExitInfo();
      const detail =
        exitInfo && exitInfo.code !== 0
          ? `The backend exited with code ${exitInfo.code}.`
          : "The backend did not become ready in time.";
      const tail = tailLogFile(50);
      const msg = `${detail}\n\nLast log lines:\n\n${tail}`;
      console.error("[session] backend failed to become ready:", detail);
      dialog.showErrorBox("Docket couldn't start", msg);
      sessionJwt = null;
      sessionSecret = null;
      activeProjectPath = null;
      const error =
        "Could not start the project backend. Check the log for details.";
      stopBackend();
      stopFrontend();
      return { ok: false, error };
    }
    if (!frontendReady) {
      const msg = "The frontend did not become ready in time.";
      console.error("[session] frontend failed to become ready.");
      dialog.showErrorBox("Docket couldn't start", msg);
      sessionJwt = null;
      sessionSecret = null;
      activeProjectPath = null;
      stopBackend();
      stopFrontend();
      return { ok: false, error: msg };
    }
    if (win) loadMainApp(win);
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error("[session] start handler threw:", err);
    sessionJwt = null;
    sessionSecret = null;
    activeProjectPath = null;
    stopBackend();
    stopFrontend();
    return { ok: false, error: msg };
  } finally {
    startingSession = false;
  }
}

async function restartBackendForFolderAccess(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!sessionJwt) return { ok: false, error: "Start Docket first." };
  await stopBackendAndWait();
  await startSession(activeProjectPath);
  const backendReady = await waitForBackend(20_000);
  if (backendReady) return { ok: true };
  const exitInfo = getBackendExitInfo();
  const detail =
    exitInfo && exitInfo.code !== 0
      ? `The backend exited with code ${exitInfo.code}.`
      : "The backend did not become ready in time.";
  return { ok: false, error: detail };
}

function tailLogFile(maxLines = 50): string {
  const lp = getLogPath();
  if (!lp) return "(no log file)";
  try {
    const data = fs.readFileSync(lp, "utf8");
    const lines = data.trimEnd().split(/\r?\n/);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "(unable to read log)";
  }
}

ipcMain.handle("docket:getToken", (event) =>
  isTrustedIpcSender(event) ? sessionJwt : null,
);
ipcMain.handle("docket:getUser", (event) => {
  if (!isTrustedIpcSender(event)) return null;
  if (!sessionJwt) return null;
  return { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL };
});
ipcMain.handle("docket:getApiPort", (event) =>
  isTrustedIpcSender(event) ? getBackendPort() : null,
);
ipcMain.handle("docket:focusMainWindow", (event) => {
  if (!isTrustedIpcSender(event) || !win || win.isDestroyed()) {
    return { ok: false };
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return { ok: true };
});
ipcMain.handle(
  "docket:openDocumentViewer",
  (event, payload: DocumentViewerPayload) => {
    if (!isTrustedIpcSender(event)) {
      return { ok: false, error: "Untrusted renderer origin." };
    }
    if (!sessionJwt) return { ok: false, error: "Start Docket first." };
    if (!payload.documentId) {
      return { ok: false, error: "documentId is required" };
    }
    const viewer = getOrCreateDocumentViewerWindow();
    void viewer.loadURL(documentViewerUrl(payload));
    if (viewer.isMinimized()) viewer.restore();
    viewer.show();
    viewer.focus();
    return { ok: true };
  },
);
// Lets satellite windows (the document viewer) route the main app window,
// e.g. "+ Chat" navigating to a freshly created project chat.
ipcMain.handle("docket:openMainRoute", (event, payload?: { path?: string }) => {
  if (!isTrustedIpcSender(event)) {
    return { ok: false, error: "Untrusted renderer origin." };
  }
  if (!sessionJwt) return { ok: false, error: "Start Docket first." };
  const routePath = typeof payload?.path === "string" ? payload.path : "";
  if (!routePath.startsWith("/") || routePath.startsWith("//")) {
    return { ok: false, error: "A local app path is required." };
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(routePath, FRONTEND_URL);
  } catch {
    return { ok: false, error: "A local app path is required." };
  }
  if (targetUrl.origin !== FRONTEND_ORIGIN) {
    return { ok: false, error: "A local app path is required." };
  }
  if (!win || win.isDestroyed()) {
    win = createWindow();
    installSessionCheck(win);
    win.on("closed", () => {
      win = null;
    });
    void win.loadURL(targetUrl.toString());
  } else if (
    win.webContents.isLoading() ||
    !win.webContents.getURL().startsWith(FRONTEND_URL)
  ) {
    // Renderer can't receive the navigate event yet (mid-load or off-app):
    // fall back to a hard load.
    void win.loadURL(targetUrl.toString());
  } else {
    // In-app client-side navigation — keeps the running SPA alive instead
    // of paying a full reload (bundle re-parse, re-hydration, provider
    // re-init) every time the viewer routes the main window.
    win.webContents.send("docket:navigate", {
      path: targetUrl.pathname + targetUrl.search + targetUrl.hash,
    });
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return { ok: true };
});
ipcMain.handle("docket:minimizeDocumentViewer", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
  return { ok: true };
});
ipcMain.handle("docket:closeDocumentViewer", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
  return { ok: true };
});
ipcMain.handle("docket:pickSourceFolder", async () => {
  if (!sessionJwt) return { ok: false, error: "Start Docket first." };
  const result = await dialog.showOpenDialog({
    title: "Choose a source folder",
    properties: ["openDirectory"],
    securityScopedBookmarks: process.platform === "darwin",
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  rememberProjectFolderAccess(result.filePaths[0], result.bookmarks?.[0]);
  const restarted = await restartBackendForFolderAccess();
  if (!restarted.ok) return restarted;
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle(
  "docket:authorizeProjectFolder",
  async (
    _event,
    payload?: {
      path?: string;
      name?: string;
    },
  ) => {
    if (!sessionJwt) return { ok: false, error: "Start Docket first." };
    const targetPath = typeof payload?.path === "string" ? payload.path : "";
    if (!targetPath.trim()) {
      return { ok: false, error: "Project folder path is required." };
    }
    const targetKey = normalizedFolderPath(targetPath);
    const result = await dialog.showOpenDialog({
      title: payload?.name
        ? `Grant access to ${payload.name}`
        : "Grant access to project folder",
      defaultPath: targetPath,
      properties: ["openDirectory"],
      securityScopedBookmarks: process.platform === "darwin",
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };

    const selectedPath = result.filePaths[0];
    const selectedKey = normalizedFolderPath(selectedPath);
    if (selectedKey !== targetKey) {
      return {
        ok: false,
        error: `Choose the registered project folder: ${targetPath}`,
      };
    }

    rememberProjectFolderAccess(selectedPath, result.bookmarks?.[0]);
    return restartBackendForFolderAccess();
  },
);

// CSP for the renderer. Allows: own scripts/styles, inline styles (Next.js
// + Tailwind ship them), images from local sources + data URIs, fetch/ws
// to the backend on localhost. Blocks: external scripts, plugins, frames,
// remote images. LLM-rendered markdown is the realistic injection vector;
// this header closes a large class of those without breaking the app.
const RENDERER_CSP = [
  "default-src 'self' http://localhost:* ws://localhost:*",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*",
  "style-src 'self' 'unsafe-inline' http://localhost:*",
  "img-src 'self' data: blob: http://localhost:*",
  "font-src 'self' data: http://localhost:*",
  "connect-src 'self' http://localhost:* ws://localhost:* https://api.anthropic.com https://generativelanguage.googleapis.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

function installCsp(): void {
  // CSP is enforced on packaged builds only. Next.js dev mode (Turbopack)
  // and React Fast Refresh make extra fetches to undocumented endpoints
  // that are awkward to whitelist; in dev we trust the local toolchain.
  // The packaged build serves Next.js standalone output where the URL
  // surface is fixed and the CSP can be locked down.
  if (!app.isPackaged) return;
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...details.responseHeaders };
    // Strip any upstream CSP so ours is the one that applies.
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === "content-security-policy") delete headers[k];
    }
    headers["Content-Security-Policy"] = [RENDERER_CSP];
    cb({ responseHeaders: headers });
  });
}

let childProcessCleanupDone = false;
function cleanupChildProcesses(): void {
  if (childProcessCleanupDone) return;
  childProcessCleanupDone = true;
  stopBackend();
  stopFrontend();
  closeLogging();
}

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    installAppIcon();
    installCsp();
    if (isSessionCheckEnabled() && process.env.DOCKET_SESSION_CHECK_PROJECT_PATH) {
      activeProjectPath = process.env.DOCKET_SESSION_CHECK_PROJECT_PATH;
    }
    win = createWindow();
    installSessionCheck(win);
    void startLocalSession(activeProjectPath).then((result) => {
      if (!result.ok) {
        console.error(
          `[startup] failed to start session: ${result.error ?? "unknown error"}`,
        );
      }
    });
    win.on("closed", () => {
      win = null;
    });
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  cleanupChildProcesses();
});

process.on("SIGINT", () => {
  cleanupChildProcesses();
  app.quit();
});
process.on("SIGTERM", () => {
  cleanupChildProcesses();
  app.quit();
});
process.on("exit", () => {
  cleanupChildProcesses();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
    win = createWindow();
    if (sessionJwt) {
      loadMainApp(win);
      return;
    }
    void startLocalSession(activeProjectPath).then((result) => {
      if (!result.ok) {
        console.error(
          `[activate] failed to start session: ${result.error ?? "unknown error"}`,
        );
      }
    });
  }
});
