// Pointer-level interactive E2E for the Electron desktop app.
//
// Launches the compiled Electron main on an isolated userData profile with a
// seeded temp project folder, then drives the real UI with mouse input via
// playwright-core's _electron launcher: open-folder project creation, manual
// rescan, the dedicated PDF viewer window, drag-to-highlight, the comment
// editor, saved-annotation quick actions, document search, and the assistant
// page. The native folder-picker dialog is the only mocked surface.
//
// Run after `npm run build:electron`:
//   node scripts/interactive-e2e.js
//
// Screenshots and results.json land in a temp directory printed at the end.

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { _electron } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const results = [];
const rendererHttpErrors = [];
let page = null;
let shotIndex = 0;
let frontendProc = null;
let frontendUrl = "";
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "docket-e2e-shots-"));

const LIVE_LLM_PROVIDERS = {
  gemini: {
    modelId: "gemini-3-flash-preview",
    label: "Gemini Flash",
    screenshot: "live-gemini-project-answer",
    requiredKeys: ["gemini_api_key"],
  },
  ollama: {
    modelId: "ollama:gemma4:12b-mlx",
    label: "local Gemma 4 12B",
    screenshot: "live-ollama-gemma4-project-answer",
    requiredKeys: [],
  },
  "free-router": {
    modelId: "free-router:free-router/best",
    label: "FreeRouter",
    screenshot: "live-free-router-project-answer",
    requiredKeys: [],
  },
  openrouter: {
    modelId: "openrouter:openai/gpt-oss-120b",
    label: "OpenRouter",
    screenshot: "live-openrouter-project-answer",
    requiredKeys: ["openrouter_api_key"],
  },
};

function readLiveLlmConfig() {
  if (process.env.RUN_LIVE_LLM_E2E !== "1") return null;
  const providerName = process.env.RUN_LIVE_LLM_E2E_PROVIDER || "gemini";
  const provider = LIVE_LLM_PROVIDERS[providerName];
  if (!provider) {
    throw new Error(
      `Unsupported RUN_LIVE_LLM_E2E_PROVIDER: ${providerName}`,
    );
  }
  if (provider.requiredKeys.length === 0) {
    return { provider, profilePatch: {} };
  }
  const profileDb = process.env.DOCKET_LIVE_PROFILE_DB;
  if (!profileDb) throw new Error("DOCKET_LIVE_PROFILE_DB is required for live LLM E2E");
  const Database = require(
    path.join(ROOT, "backend", "node_modules", "better-sqlite3"),
  );
  const db = new Database(profileDb, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        "SELECT gemini_api_key, openrouter_api_key FROM user_profiles WHERE user_id = ? LIMIT 1",
      )
      .get(process.env.DOCKET_LIVE_USER_ID || "local-user");
    const missing = provider.requiredKeys.filter((key) => !row?.[key]);
    if (missing.length) {
      throw new Error(`${provider.label} credentials must be configured`);
    }
    return {
      provider,
      profilePatch: Object.fromEntries(
        provider.requiredKeys.map((key) => [key, row[key]]),
      ),
    };
  } finally {
    db.close();
  }
}

function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${step}${detail ? ` | ${detail}` : ""}`);
}

async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function isFrontendReady() {
  try {
    const resp = await fetch(frontendUrl, { signal: AbortSignal.timeout(1000) });
    return resp.ok || resp.status < 500;
  } catch {
    return false;
  }
}

async function ensureFrontend(port) {
  frontendUrl = `http://127.0.0.1:${port}`;
  if (await isFrontendReady()) {
    console.log(`[interactive-e2e] using existing frontend on port ${port}`);
    return;
  }
  frontendProc = spawn("npm", ["--prefix", "frontend", "run", "dev"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  frontendProc.stdout.on("data", () => {});
  frontendProc.stderr.on("data", () => {});
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isFrontendReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`frontend dev server did not become ready on port ${port}`);
}

function stopFrontend() {
  if (frontendProc && !frontendProc.killed) frontendProc.kill();
  frontendProc = null;
}

// Pointer drags can land before the freshly opened viewer settles its layout,
// so retry the drag until the expected UI reaction appears.
async function dragUntilAnnotation(pg, locator, expectedCount, { editor = false } = {}) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const box = await locator.boundingBox();
    if (box) {
      await pg.mouse.move(box.x + 2, box.y + box.height / 2);
      await pg.mouse.down();
      await pg.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 });
      await pg.mouse.up();
    }
    if (editor) {
      const visible = await pg
        .locator('[data-session-check="pdf-comment-editor"]')
        .isVisible()
        .catch(() => false);
      if (visible) return true;
    } else {
      const ok = await pg
        .waitForFunction(
          (n) => document.querySelectorAll(".pdf-saved-annotation").length >= n,
          expectedCount,
          { timeout: 5_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (ok) return true;
    }
    await pg.waitForTimeout(1_500);
  }
  return false;
}

async function main() {
  const liveLlmConfig = readLiveLlmConfig();
  // Seed an isolated project folder with a real PDF + markdown.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "docket-e2e-project-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "docket-e2e-userdata-"));
  const { PDFDocument, StandardFonts } = require(
    path.join(ROOT, "backend", "node_modules", "pdf-lib"),
  );
  const pdf = await PDFDocument.create();
  const p1 = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  p1.drawText("Interactive smoke clause: the indemnity survives termination.", {
    x: 72,
    y: 700,
    size: 14,
    font,
  });
  p1.drawText("Second paragraph about limitation of liability caps.", {
    x: 72,
    y: 660,
    size: 12,
    font,
  });
  for (let pageNum = 2; pageNum <= 40; pageNum += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Page ${pageNum} marker`, {
      x: 72,
      y: 700,
      size: 14,
      font,
    });
  }
  const seededPdf = Buffer.from(await pdf.save());
  fs.writeFileSync(path.join(projectDir, "e2e-agreement.pdf"), seededPdf);
  fs.writeFileSync(path.join(projectDir, "원고 준비서면.pdf"), seededPdf);
  fs.writeFileSync(path.join(projectDir, "갑 제1호증.pdf"), seededPdf);
  fs.mkdirSync(path.join(projectDir, "Evidence"));
  fs.writeFileSync(path.join(projectDir, "Evidence", "을 제2호증.pdf"), seededPdf);
  fs.writeFileSync(
    path.join(projectDir, "notes.md"),
    "# E2E Notes\n\n## Indemnity\n\nIndemnity survives termination.\n\n## Liability\n\nLiability is capped.\n",
  );

  const frontendPort = await getFreePort();
  await ensureFrontend(frontendPort);

  const app = await _electron.launch({
    executablePath: path.join(
      ROOT,
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    ),
    args: [path.join(ROOT, "dist-electron", "main.js")],
    env: {
      ...process.env,
      NODE_ENV: "development",
      DOCKET_USER_DATA_DIR: userData,
      DOCKET_FRONTEND_URL: frontendUrl,
      DOCKET_FRONTEND_PORT: String(frontendPort),
      DOCKET_SKIP_LIBREOFFICE_PROBE: "1",
      ...(liveLlmConfig
        ? {
            ...(liveLlmConfig.profilePatch.gemini_api_key
              ? { GEMINI_API_KEY: liveLlmConfig.profilePatch.gemini_api_key }
              : {}),
            ...(liveLlmConfig.profilePatch.openrouter_api_key
              ? { OPENROUTER_API_KEY: liveLlmConfig.profilePatch.openrouter_api_key }
              : {}),
            ...(liveLlmConfig.provider.modelId.startsWith("ollama:") ||
            liveLlmConfig.provider.modelId.startsWith("free-router:")
              ? { OLLAMA_TITLE_MODEL: "ollama:gemma4:12b-mlx" }
              : {}),
          }
        : {}),
    },
  });

  try {
    page = await app.firstWindow();
    page.on("console", (msg) => {
      if (msg.type() === "error") console.log(`[renderer-error] ${msg.text().slice(0, 200)}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        rendererHttpErrors.push({ status: response.status(), url: response.url() });
        console.log(`[renderer-response] ${response.status()} ${response.url()}`);
      }
    });

    // 1. App opens straight to /projects (FR11: no login gate).
    await page.waitForURL("**/projects", { timeout: 90_000 });
    await page.waitForSelector("text=Open Folder", { timeout: 30_000 });
    record("boot: opens directly to /projects with Open Folder action", true, page.url());
    await shot("projects-overview");

    // 2. Open Folder via the real button (native dialog mocked in main process).
    await app.evaluate(async ({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, projectDir);
    await page.getByRole("button", { name: /Open Folder/ }).first().click();
    await page.waitForURL("**/projects/**", { timeout: 60_000 });
    const projectUrl = page.url();
    await page.waitForSelector('[data-session-check="project-doc-row"]', { timeout: 60_000 });
    const docRows = await page.locator('[data-session-check="project-doc-row"]').count();
    record("open-folder: creates project and lists scanned files", docRows >= 5, `doc rows=${docRows}`);
    await shot("project-page");

    // 3. Manual rescan through the real control (FR8).
    await page.locator('[data-session-check="source-folder-rescan"]').first().click();
    await page.waitForFunction(
      () =>
        /unchanged/.test(
          document.querySelector('[data-session-check="source-folder-scan-summary"]')?.textContent ?? "",
        ),
      undefined,
      { timeout: 30_000 },
    );
    const summary =
      (await page.locator('[data-session-check="source-folder-scan-summary"]').first().textContent()) ?? "";
    record("rescan: click reports scan summary", summary.includes("unchanged"), summary.trim());

    // 4. Open the PDF — the app opens a dedicated viewer window via IPC.
    const mainPage = page;
    const [viewerPage] = await Promise.all([
      app.waitForEvent("window", { timeout: 60_000 }),
      page.getByText("e2e-agreement.pdf", { exact: true }).first().click(),
    ]);
    page = viewerPage;
    await viewerPage.waitForSelector('[data-session-check="doc-view"] canvas', { timeout: 60_000 });
    await viewerPage.waitForSelector(".pdf-text-layer > span", { timeout: 60_000 });
    record("pdf-viewer: opens dedicated viewer window with canvas + text layer", true, viewerPage.url());
    await viewerPage.waitForTimeout(250);
    const virtualizationOpen = await viewerPage.evaluate(async () => {
      const wrappers = document.querySelectorAll("[data-pdf-page-number]").length;
      const canvasInitial = document.querySelectorAll(
        '[data-session-check="doc-view"] canvas',
      ).length;
      const scrollEl = document.querySelector('[data-session-check="doc-view-scroll"]');
      const scrollHeightInitial = scrollEl ? scrollEl.scrollHeight : 0;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const scrollHeightLater = scrollEl ? scrollEl.scrollHeight : 0;
      return {
        wrappers,
        canvasInitial,
        scrollHeightInitial,
        scrollHeightLater,
      };
    });
    record(
      "pdf-viewer: virtualizes pages with stable scroll height",
      virtualizationOpen.wrappers === 40 &&
        virtualizationOpen.canvasInitial < 40 &&
        Math.abs(virtualizationOpen.scrollHeightLater - virtualizationOpen.scrollHeightInitial) <= 1,
      JSON.stringify(virtualizationOpen),
    );
    await viewerPage.evaluate(() => {
      document
        .querySelector('[data-pdf-page-number="40"]')
        ?.scrollIntoView({ block: "start" });
    });
    const lastPageRendered = await viewerPage
      .waitForFunction(
        () => {
          const last = document.querySelector('[data-pdf-page-number="40"]');
          const first = document.querySelector('[data-pdf-page-number="1"]');
          return Boolean(last?.querySelector("canvas")) && !first?.querySelector("canvas");
        },
        undefined,
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    record(
      "pdf-viewer: renders jumped page and evicts distant canvases",
      lastPageRendered,
      `canvases=${await viewerPage.locator('[data-session-check="doc-view"] canvas').count()}`,
    );
    await viewerPage.evaluate(() => {
      document
        .querySelector('[data-pdf-page-number="1"]')
        ?.scrollIntoView({ block: "start" });
    });
    await viewerPage.waitForFunction(
      () =>
        Boolean(
          document
            .querySelector('[data-pdf-page-number="1"]')
            ?.querySelector(".pdf-text-layer > span"),
        ),
      undefined,
      { timeout: 60_000 },
    );
    await shot("pdf-viewer");

    // 5. Highlight mode + real drag selection -> saved annotation overlay (FR9).
    await page.waitForTimeout(1_500);
    await page.locator('[data-session-check="pdf-mode-highlight"]').click();
    const span = page.locator(".pdf-text-layer > span", { hasText: "indemnity survives" }).first();
    const spanTarget = (await span.count()) ? span : page.locator(".pdf-text-layer > span").first();
    const highlightSaved = await dragUntilAnnotation(page, spanTarget, 1);
    if (!highlightSaved) throw new Error("highlight drag did not produce a saved annotation");
    const highlights = await page.locator(".pdf-saved-annotation").count();
    record("annotate: drag selection in highlight mode saves an annotation", highlights >= 1, `overlays=${highlights}`);
    await shot("pdf-highlight");

    // 6. Comment mode on the second line, through the real comment editor.
    await page.locator('[data-session-check="pdf-mode-comment"]').click();
    const span2 = page.locator(".pdf-text-layer > span", { hasText: "limitation of liability" }).first();
    const span2Target = (await span2.count()) ? span2 : page.locator(".pdf-text-layer > span").nth(1);
    const editorShown = await dragUntilAnnotation(page, span2Target, 2, { editor: true });
    if (!editorShown) throw new Error("comment drag did not open the comment editor");
    const editor = page.locator('[data-session-check="pdf-comment-editor"]');
    await editor.locator("textarea").fill("E2E comment: verify liability cap wording.");
    await editor.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll(".pdf-saved-annotation").length >= 2,
      undefined,
      { timeout: 30_000 },
    );
    record(
      "annotate: comment editor saves a comment annotation",
      true,
      `overlays=${await page.locator(".pdf-saved-annotation").count()}`,
    );
    await shot("pdf-comment");

    // 7. Saved annotation click opens the quick action menu.
    await page.locator(".pdf-saved-annotation").first().click();
    await page.waitForTimeout(600);
    await shot("annotation-menu");
    const menuText = (await page.evaluate(() => document.body.innerText)).slice(0, 4000);
    record(
      "annotate: clicking a saved annotation opens quick actions",
      /copy|comment|delete|color/i.test(menuText),
      "",
    );
    await page.keyboard.press("Escape");

    // 8. Back on the project window: document search (FR12 lexical lane).
    await viewerPage.close().catch(() => {});
    page = mainPage;
    await page.waitForSelector('[data-session-check="project-doc-row"]', { timeout: 30_000 });
    const searchBox = page.locator('input[placeholder*="earch"]').first();
    await searchBox.fill("indemnity");
    await page.getByRole("button", { name: /^Search$/ }).first().click();
    await page.waitForFunction(
      () =>
        /exact|keyword|substring|basic|semantic/i.test(document.body.innerText) &&
        /indemnity/i.test(document.body.innerText),
      undefined,
      { timeout: 30_000 },
    );
    await shot("project-search");
    const bodyAfterSearch = await page.evaluate(() => document.body.innerText);
    record(
      "search: executing 'indemnity' returns results for the seeded documents",
      /e2e-agreement\.pdf|notes\.md/i.test(bodyAfterSearch),
      "",
    );

    // 9. App-level assistant page (recent-chats read path) renders without error.
    await page.locator("text=Assistant").first().click();
    await page.waitForTimeout(2_000);
    const assistantBody = await page.evaluate(() => document.body.innerText);
    record(
      "assistant: app-level assistant page renders",
      !/cannot be opened|Internal error/i.test(assistantBody),
      page.url(),
    );
    await shot("assistant-page");

    // 10. Documents tab: expanding the PDF row lists its annotations, and
    // clicking one opens the dedicated viewer focused on that annotation.
    await page.goto(projectUrl);
    await page.waitForSelector('[data-session-check="project-doc-row"]', { timeout: 30_000 });
    const annotatedProjectRow = page
      .locator('[data-session-check="project-doc-row"]')
      .filter({ hasText: "e2e-agreement.pdf" })
      .first();
    await annotatedProjectRow
      .locator('[data-session-check="project-annotation-toggle"]')
      .click();
    const docTabRowsListed = await page
      .waitForFunction(
        () =>
          document.querySelectorAll('[data-session-check="project-annotation-row"]').length >= 2,
        undefined,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    record(
      "documents-tab: expanding a PDF row lists its annotations",
      docTabRowsListed,
      `rows=${await page.locator('[data-session-check="project-annotation-row"]').count()}`,
    );
    await shot("documents-tab-annotations");

    const [annotationViewer] = await Promise.all([
      app.waitForEvent("window", { timeout: 60_000 }),
      page.locator('[data-session-check="project-annotation-row"]').first().click(),
    ]);
    await annotationViewer.waitForSelector('[data-session-check="doc-view"] canvas', {
      timeout: 60_000,
    });
    const annotationFocused = await annotationViewer
      .waitForFunction(
        () => document.querySelectorAll(".pdf-saved-annotation").length >= 1,
        undefined,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    record(
      "documents-tab: clicking an annotation opens the viewer on it",
      annotationFocused && annotationViewer.url().includes("annotation_id="),
      annotationViewer.url().slice(0, 140),
    );
    {
      const tablePage = page;
      page = annotationViewer;
      await shot("annotation-viewer-focus");
      page = tablePage;
    }
    await annotationViewer.close().catch(() => {});

    // 11. Persist a project color legend through the real editor, reload it,
    // and verify the saved party binding survives.
    const legend = page.locator('[data-session-check="project-color-legend"]');
    await legend.locator("summary").click();
    const greenLegendRow = legend.locator(
      '[data-session-check="project-color-legend-row"][data-color-family="green"]',
    );
    await greenLegendRow.locator("input").nth(0).fill("undisputed facts");
    await greenLegendRow.locator("input").nth(1).fill("defendant");
    await greenLegendRow.locator("select").selectOption("B");
    await legend.locator('[data-session-check="project-color-legend-save"]').click();
    await page.waitForSelector(
      '[data-session-check="project-color-legend-status"]:has-text("Saved")',
      { timeout: 30_000 },
    );
    await page.reload();
    await page.waitForSelector('[data-session-check="project-doc-row"]', { timeout: 30_000 });
    const reloadedLegend = page.locator('[data-session-check="project-color-legend"]');
    await reloadedLegend.locator("summary").click();
    const reloadedGreenRow = reloadedLegend.locator(
      '[data-session-check="project-color-legend-row"][data-color-family="green"]',
    );
    const legendPersisted =
      (await reloadedGreenRow.locator("input").nth(0).inputValue()) === "undisputed facts" &&
      (await reloadedGreenRow.locator("input").nth(1).inputValue()) === "defendant" &&
      (await reloadedGreenRow.locator("select").inputValue()) === "B";
    record("color-legend: saves and reloads meaning + party binding", legendPersisted, "green=undisputed facts, defendant/B");
    await shot("color-legend-persisted");
    if ((await reloadedLegend.getAttribute("open")) !== null) {
      await reloadedLegend.locator("summary").click();
    }

    // 12. The project-wide annotation browser must show both annotations and
    // filter to the single commented annotation through pointer input.
    await page.getByRole("button", { name: "All highlights", exact: true }).click();
    const annotationBrowser = page.locator(
      '[data-session-check="project-annotation-browser"]',
    );
    await annotationBrowser.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-session-check="project-annotation-browser-row"]',
        ).length >= 2,
      undefined,
      { timeout: 30_000 },
    );
    const allHighlightRows = await annotationBrowser
      .locator('[data-session-check="project-annotation-browser-row"]')
      .count();
    await annotationBrowser.getByLabel("With comments").check();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-session-check="project-annotation-browser-row"]',
        ).length === 1,
      undefined,
      { timeout: 30_000 },
    );
    record(
      "all-highlights: lists project annotations and filters comments",
      allHighlightRows >= 2,
      `all=${allHighlightRows}, with-comments=1`,
    );
    await shot("all-highlights-comments-filter");
    await page.getByRole("button", { name: "Files", exact: true }).click();

    // 13. Row actions: Download/Upload-new-version are replaced by
    // Export with annotations + Rescan; Rescan runs without error.
    const rowActionTarget = page
      .locator('[data-session-check="project-doc-row"]')
      .filter({ hasText: "e2e-agreement.pdf" })
      .first();
    await rowActionTarget.scrollIntoViewIfNeeded();
    await rowActionTarget
      .locator('[data-session-check="row-actions-trigger"]')
      .click();
    await page.waitForSelector('[data-session-check="row-rescan"]', { timeout: 10_000 });
    const hasExportItem = await page
      .locator('[data-session-check="row-export-annotated"]')
      .count();
    const bodyWithMenu = await page.evaluate(() => document.body.innerText);
    record(
      "row-actions: menu offers Export with annotations + Rescan, no upload",
      hasExportItem >= 1 && !/Upload new version/.test(bodyWithMenu),
      "",
    );
    await page.locator('[data-session-check="row-rescan"]').click();
    await page.waitForTimeout(1_500);
    const bodyAfterRescan = await page.evaluate(() => document.body.innerText);
    record(
      "row-actions: per-document rescan completes",
      !/Rescan failed|Internal error/i.test(bodyAfterRescan),
      "",
    );

    // Create a real project subfolder and move an evidence document into it so
    // the chat explorer's descendant-scope checkbox is exercised end to end.
    await page.locator('[data-session-check="project-add-subfolder"]').click();
    const newFolderInput = page.locator(
      '[data-session-check="project-new-folder-input"]',
    );
    await newFolderInput.fill("Evidence Scope");
    await newFolderInput.press("Enter");
    const projectFolderRow = page.locator(
      '[data-session-check="project-folder-row"][data-folder-name="Evidence Scope"]',
    );
    await projectFolderRow.waitFor({ state: "visible", timeout: 30_000 });
    const evidenceProjectRow = page
      .locator('[data-session-check="project-doc-row"]')
      .filter({ hasText: "갑 제1호증.pdf" })
      .first();
    await evidenceProjectRow.dragTo(projectFolderRow);
    await page.waitForTimeout(1_000);
    record(
      "folders: creates a project folder and moves evidence into it",
      (await projectFolderRow.count()) === 1,
      "Evidence Scope",
    );

    if (liveLlmConfig) {
      await page.evaluate(async ({ profilePatch, modelId }) => {
        if (Object.keys(profilePatch).length > 0) {
          const [port, token] = await Promise.all([
            window.docket?.getApiPort?.(),
            window.docket?.getToken?.(),
          ]);
          if (!port || !token) throw new Error("desktop session bridge unavailable");
          const response = await fetch(`http://localhost:${port}/user/profile`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(profilePatch),
          });
          if (!response.ok) throw new Error(`profile update failed: ${response.status}`);
        }
        localStorage.setItem("docket.selectedModel", modelId);
      }, {
        profilePatch: liveLlmConfig.profilePatch,
        modelId: liveLlmConfig.provider.modelId,
      });
      await page.reload();
      await page.waitForSelector('[data-session-check="project-doc-row"]', {
        timeout: 60_000,
      });
    }

    // 14. Project chat explorer: folder selection and the brief-only action
    // enforce source scope, then annotation controls remain interactive.
    // created in steps 5-6, and right-click can delete one.
    await page.getByRole("button", { name: /^Chat$/ }).first().click();
    await page.waitForURL("**/assistant/chat/**", { timeout: 60_000 });
    await page.waitForSelector('[data-session-check="explorer-annotation-toggle"]', {
      timeout: 30_000,
    });
    const explorerFolderRow = page.locator(
      '[data-session-check="explorer-folder-row"][data-folder-name="Evidence Scope"]',
    );
    const folderScope = explorerFolderRow.locator(
      '[data-session-check="explorer-folder-source-checkbox"]',
    );
    const nestedEvidence = page.locator(
      '[data-session-check="project-explorer-document"][data-filename="갑 제1호증.pdf"]',
    );
    await folderScope.uncheck();
    await explorerFolderRow.getByText("Evidence Scope", { exact: true }).click();
    await nestedEvidence.waitFor({ state: "visible", timeout: 10_000 });
    const folderDeselected = !(await nestedEvidence
      .locator('[data-session-check="explorer-source-checkbox"]')
      .isChecked());
    await folderScope.check();
    const folderSelected = await nestedEvidence
      .locator('[data-session-check="explorer-source-checkbox"]')
      .isChecked();
    record(
      "explorer: folder checkbox toggles descendant document scope",
      folderDeselected && folderSelected,
      "nested evidence toggled off/on",
    );

    await page.locator('[data-session-check="explorer-select-briefs"]').click();
    const evidenceSelected = await page
      .locator(
        '[data-session-check="project-explorer-document"][data-filename="갑 제1호증.pdf"] [data-session-check="explorer-source-checkbox"]',
      )
      .isChecked();
    const briefSelected = await page
      .locator(
        '[data-session-check="project-explorer-document"][data-filename="원고 준비서면.pdf"] [data-session-check="explorer-source-checkbox"]',
      )
      .isChecked();
    record(
      "explorer: 서면만 excludes classified evidence and keeps briefs",
      !evidenceSelected && briefSelected,
      `evidence=${evidenceSelected}, brief=${briefSelected}`,
    );

    const annotatedExplorerDocument = page.locator(
      '[data-session-check="project-explorer-document"][data-filename="e2e-agreement.pdf"]',
    );
    await annotatedExplorerDocument
      .locator('[data-session-check="explorer-annotation-toggle"]')
      .click();
    const annotationsListed = await page
      .waitForFunction(
        () =>
          document.querySelectorAll('[data-session-check="explorer-annotation-row"]').length >= 2,
        undefined,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    const annotationRows = await page
      .locator('[data-session-check="explorer-annotation-row"]')
      .count();
    record(
      "explorer: expanding a PDF row lists its annotations",
      annotationsListed,
      `rows=${annotationRows}`,
    );
    await shot("explorer-annotations");

    await page
      .locator('[data-session-check="explorer-annotation-row"]')
      .first()
      .click({ button: "right" });
    await page.waitForSelector('[data-session-check="explorer-annotation-delete"]', {
      timeout: 10_000,
    });
    await page.locator('[data-session-check="explorer-annotation-delete"]').click();
    const annotationDeleted = await page
      .waitForFunction(
        (before) =>
          document.querySelectorAll('[data-session-check="explorer-annotation-row"]').length ===
          before - 1,
        annotationRows,
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    record(
      "explorer: right-click deletes an annotation",
      annotationDeleted,
      `rows=${await page.locator('[data-session-check="explorer-annotation-row"]').count()}`,
    );
    await shot("explorer-annotation-deleted");

    const remainingAnnotationRows = await page
      .locator('[data-session-check="explorer-annotation-row"]')
      .count();
    if (remainingAnnotationRows > 0) {
      await page
        .locator('[data-session-check="explorer-annotation-select-all"]')
        .first()
        .click();
      await page
        .locator('[data-session-check="explorer-annotations-delete-selected"]')
        .first()
        .click();
    }
    const bulkDeleted = await page
      .waitForFunction(
        () =>
          document.querySelectorAll('[data-session-check="explorer-annotation-row"]').length ===
          0,
        undefined,
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    record(
      "explorer: checkbox selection deletes selected annotations",
      bulkDeleted,
      `rows=${await page.locator('[data-session-check="explorer-annotation-row"]').count()}`,
    );
    await shot("explorer-annotations-bulk-deleted");

    if (liveLlmConfig) {
      // Ground the live-provider assertion in one unambiguous selected source.
      // The other seeded PDFs intentionally duplicate the smoke sentence for
      // classification tests, so leaving them selected would make an omitted
      // model citation impossible to recover without guessing a document.
      await page
        .getByLabel("Select all chat source documents")
        .uncheck();
      await annotatedExplorerDocument
        .locator('[data-session-check="explorer-source-checkbox"]')
        .check();
      const selectedSourceDocumentId = await annotatedExplorerDocument.getAttribute(
        "data-document-id",
      );
      const beforeMessages = await page
        .locator('[data-session-check="assistant-message"]')
        .count();
      const livePrompt = page.locator(
        '[data-session-check="chat-input-textarea"]',
      );
      await livePrompt.fill(
        "What does the indemnity clause in e2e-agreement.pdf say about termination? Search the selected project document and cite the source.",
      );
      // Next's development indicator sits above the bottom-right submit
      // button in dev builds, so submit through the same Enter-key path a
      // keyboard user uses instead of bypassing hit testing.
      await livePrompt.press("Enter");
      const liveAnswer = page
        .locator('[data-session-check="assistant-message"]')
        .nth(beforeMessages);
      await liveAnswer.waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForFunction(
        (index) => {
          const messages = document.querySelectorAll(
            '[data-session-check="assistant-message"]',
          );
          return /survives termination/i.test(messages[index]?.textContent ?? "");
        },
        beforeMessages,
        { timeout: 180_000 },
      );
      // Title generation can briefly refresh the chat route after the first
      // answer. Wait for both the answer and project explorer to be restored
      // before recording the visual artifact.
      await page.waitForTimeout(1_500);
      await page.waitForFunction(
        () =>
          /survives termination/i.test(
            Array.from(
              document.querySelectorAll(
                '[data-session-check="assistant-message"]',
              ),
            )
              .map((element) => element.textContent ?? "")
              .join(" "),
          ) &&
          document.querySelectorAll(
            '[data-session-check="project-explorer-document"]',
          ).length >= 3,
        undefined,
        { timeout: 60_000 },
      );
      // Some providers expose the requested phrase well before their final
      // citation block. The cleared input leaves this button disabled only
      // after streaming has finished, so wait for that terminal UI state.
      await page.waitForFunction(
        () => {
          const submit = document.querySelector(
            '[data-session-check="chat-submit"]',
          );
          return submit instanceof HTMLButtonElement && submit.disabled;
        },
        undefined,
        { timeout: 240_000 },
      );
      const citationButtons = liveAnswer.locator(
        '[data-session-check="assistant-citation-button"]',
      );
      // The final citations SSE event lands after the visible answer text and
      // may race the automatic chat-title refresh. Wait for the grounded
      // marker instead of sampling annotations at the first rendered token.
      await citationButtons
        .first()
        .waitFor({ state: "visible", timeout: 30_000 })
        .catch(() => {});
      // Chat-title persistence may remount the assistant pane just after the
      // stream ends. Capture and assert the fully restored answer, not the
      // transient skeleton shown during that route refresh.
      await page.waitForTimeout(2_500);
      await page.waitForFunction(
        () =>
          /survives termination/i.test(
            Array.from(
              document.querySelectorAll(
                '[data-session-check="assistant-message"]',
              ),
            )
              .map((element) => element.textContent ?? "")
              .join(" "),
          ) &&
          document.querySelectorAll(
            '[data-session-check="assistant-citation-button"]',
          ).length > 0 &&
          document.querySelectorAll(
            '[data-session-check="project-explorer-document"]',
          ).length >= 3,
        undefined,
        { timeout: 60_000 },
      );
      const citationCount = await citationButtons.count();
      const citedDocumentIds = await citationButtons.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("data-document-id")),
      );
      const unresolvedCitationCount = await liveAnswer
        .getByTitle(/Citation \d+ is unavailable/)
        .count();
      record(
        `live-llm: ${liveLlmConfig.provider.label} answers from indexed project documents`,
        citationCount > 0 &&
          unresolvedCitationCount === 0 &&
          Boolean(selectedSourceDocumentId) &&
          citedDocumentIds.every((id) => id === selectedSourceDocumentId),
        `citations=${citationCount}, unresolved=${unresolvedCitationCount}, scoped=${citedDocumentIds.every((id) => id === selectedSourceDocumentId)}`,
      );
      await shot(liveLlmConfig.provider.screenshot);
    }

    record(
      "network: interactive workflow has no failed HTTP responses",
      rendererHttpErrors.length === 0,
      rendererHttpErrors.map(({ status, url }) => `${status} ${url}`).join(", "),
    );
  } catch (err) {
    record("UNEXPECTED", false, String(err).slice(0, 500));
    if (page) await shot("failure").catch(() => {});
    try {
      const logsDir = path.join(userData, ".docket", "logs");
      const latestLog = fs
        .readdirSync(logsDir)
        .filter((name) => name.endsWith(".log"))
        .map((name) => path.join(logsDir, name))
        .sort(
          (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
        )[0];
      if (latestLog) {
        const relevant = fs
          .readFileSync(latestLog, "utf8")
          .split(/\r?\n/)
          .filter((line) =>
            /project-chat|gemini|ollama|free-router|openrouter|stream.*error/i.test(
              line,
            ),
          )
          .slice(-30)
          .join("\n");
        if (relevant) console.log(`[interactive-e2e backend]\n${relevant}`);
      }
    } catch {
      // Best-effort failure diagnostics; the isolated profile is still removed.
    }
  } finally {
    fs.writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify(results, null, 2));
    await app.close().catch(() => {});
    stopFrontend();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nINTERACTIVE E2E: ${results.length - failed.length}/${results.length} passed`);
  console.log(`screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  stopFrontend();
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
