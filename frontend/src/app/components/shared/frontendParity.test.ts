import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { preprocessCitations } from "../assistant/citations";
import {
  buildCitationTab,
  upsertAssistantSidePanelTab,
} from "../assistant/sidePanelTabs";
import { highlightQuote } from "./highlightQuote";
import {
  buildCitationPromotionCreatePayload,
  buildPdfAnnotationCreatePayload,
} from "./pdfAnnotationActions";
import {
  expandCitationToEntries,
  type PdfAnnotationRect,
  type DocketCitationAnnotation,
} from "./types";

const annotationA: DocketCitationAnnotation = {
  type: "citation_data",
  ref: 1,
  doc_id: "doc-0",
  document_id: "document-a",
  version_id: "version-a",
  version_number: 4,
  filename: "credit-agreement.pdf",
  page: 7,
  quote: "Borrower shall deliver evidence of authority",
};

const annotationB: DocketCitationAnnotation = {
  type: "citation_data",
  ref: 2,
  doc_id: "doc-1",
  document_id: "document-b",
  version_id: null,
  version_number: null,
  filename: "shareholders.pdf",
  page: "41-42",
  quote:
    "transfer restrictions begin[[PAGE_BREAK]]and continue after the break",
};

test("preprocessCitations preserves click-through metadata and marks missing refs unresolved", () => {
  const citationsList: DocketCitationAnnotation[] = [];
  const rendered = preprocessCitations(
    "The borrower has a CP obligation [1, 2]. Missing refs stay visible [9].",
    [annotationA, annotationB],
    citationsList,
  );

  assert.equal(
    rendered,
    "The borrower has a CP obligation `§0§`\u200B`§1§`\u200B. Missing refs stay visible `§unresolved:9§`\u200B.",
  );
  assert.deepEqual(
    citationsList.map((ann) => ({
      document_id: ann.document_id,
      version_id: ann.version_id,
      page: ann.page,
      quote: ann.quote,
    })),
    [
      {
        document_id: "document-a",
        version_id: "version-a",
        page: 7,
        quote: "Borrower shall deliver evidence of authority",
      },
      {
        document_id: "document-b",
        version_id: null,
        page: "41-42",
        quote:
          "transfer restrictions begin[[PAGE_BREAK]]and continue after the break",
      },
    ],
  );
});

test("expandCitationToEntries preserves source citation on page ranges", () => {
  const entries = expandCitationToEntries(annotationB);
  assert.deepEqual(
    entries.map((entry) => ({
      page: entry.page,
      quote: entry.quote,
      document_id: entry.citation?.document_id,
      version_id: entry.citation?.version_id ?? null,
    })),
    [
      {
        page: 41,
        quote: "transfer restrictions begin",
        document_id: "document-b",
        version_id: null,
      },
      {
        page: 42,
        quote: "and continue after the break",
        document_id: "document-b",
        version_id: null,
      },
    ],
  );
});

test("expandCitationToEntries keeps the quote when there is no usable page (DOCX/TXT)", () => {
  // DOCX/DOC/TXT reads carry no `[Page N]` markers, so the model emits a
  // citation without a numeric page. The highlight must survive: DocxView
  // matches by text and the PDF viewer scans all pages.
  const docxCitation: DocketCitationAnnotation = {
    type: "citation_data",
    ref: 3,
    doc_id: "doc-2",
    document_id: "document-c",
    version_id: "version-c",
    version_number: 1,
    filename: "engagement-letter.docx",
    page: "" as unknown as number,
    quote: "Client agrees to the scope set out in Schedule 1",
  };

  const entries = expandCitationToEntries(docxCitation);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].page, undefined);
  assert.equal(entries[0].quote, "Client agrees to the scope set out in Schedule 1");
  assert.equal(entries[0].citation?.document_id, "document-c");
});

test("expandCitationToEntries drops entries with neither a page nor a quote", () => {
  const empty: DocketCitationAnnotation = {
    type: "citation_data",
    ref: 4,
    doc_id: "doc-3",
    document_id: "document-d",
    filename: "notes.txt",
    page: "n/a" as unknown as number,
    quote: "   ",
  };
  assert.deepEqual(expandCitationToEntries(empty), []);
});

test("highlightQuote finds whitespace-normalized text across PDF text divs", async () => {
  const textDivs = [
    new FakeElement("The Borrower shall"),
    new FakeElement("deliver   evidence"),
    new FakeElement("of authority on closing."),
  ] as unknown as HTMLElement[];

  const found = await highlightQuote(
    textDivs,
    "Borrower shall deliver evidence of authority",
  );

  assert.equal(found, true);
  assert.match(
    (textDivs[0] as unknown as FakeElement).innerHTML,
    /<span class="pdf-text-highlight">Borrower shall<\/span>/,
  );
  assert.match(
    (textDivs[1] as unknown as FakeElement).innerHTML,
    /<span class="pdf-text-highlight">deliver   evidence<\/span>/,
  );
  assert.match(
    (textDivs[2] as unknown as FakeElement).innerHTML,
    /<span class="pdf-text-highlight">of authority\s*<\/span>/,
  );
});

test("highlightQuote preserves Korean and compatibility characters", async () => {
  const textDivs = [
    new FakeElement("DAO의 자율적 본성은"),
    new FakeElement(" 법인격 개념과 양립하기 어렵다."),
  ] as unknown as HTMLElement[];

  const found = await highlightQuote(
    textDivs,
    "DAO의 자율적 본성은 법인격 개념과 양립하기 어렵다",
  );

  assert.equal(found, true);
  assert.match(
    (textDivs[0] as unknown as FakeElement).innerHTML,
    /pdf-text-highlight">DAO의 자율적 본성/,
  );
});

test("PDF citation startup does not measure every page before rendering the target", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /pageSizesRef\.current = Array\.from\(\s*\{ length: doc\.numPages \}/,
    "all page placeholders should be initialized from the first-page size",
  );
  assert.doesNotMatch(
    source,
    /for \(let pageNum = 2; pageNum <= doc\.numPages; pageNum\+\+\)[\s\S]{0,500}await getPageOrNull\(pageNum\)/,
    "citation startup must not await every PDF page before scheduling the target page",
  );
});

test("citation click-through opens the cited PDF version without losing tab state", () => {
  const existing = {
    kind: "document" as const,
    id: "stable-tab-id",
    documentId: "document-a",
    filename: "old-name.pdf",
    versionId: null,
    versionNumber: null,
    warning: "dismissable warning",
    initialScrollTop: 320,
  };

  const tab = buildCitationTab(annotationA);
  const tabs = upsertAssistantSidePanelTab([existing], tab);

  assert.equal(tabs.length, 1);
  assert.deepEqual(tabs[0], {
    kind: "citation",
    id: "stable-tab-id",
    documentId: "document-a",
    filename: "credit-agreement.pdf",
    versionId: "version-a",
    versionNumber: 4,
    citation: annotationA,
    warning: "dismissable warning",
    initialScrollTop: 320,
  });
});

test("assistant citation buttons keep stable click-through smoke selectors", () => {
  const source = fs.readFileSync(
    new URL("../assistant/AssistantMessage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /data-session-check="assistant-citation-button"/,
    "citation buttons must remain discoverable by Electron smoke tests",
  );
  assert.match(
    source,
    /data-citation-ref=\{annotation\.ref\}/,
    "citation buttons must expose the Docket citation ref",
  );
  assert.match(
    source,
    /data-document-id=\{annotation\.document_id\}/,
    "citation buttons must expose the source document id",
  );
});

test("assistant responses expose a bottom copy button for the full answer", () => {
  const source = fs.readFileSync(
    new URL("../assistant/AssistantMessage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const copyableResponseText/,
    "assistant messages should derive copy text from the response content",
  );
  assert.match(
    source,
    /navigator\.clipboard\.writeText\(copyableResponseText\)/,
    "assistant response copy should write the full answer text to the clipboard",
  );
  assert.match(
    source,
    /aria-label="Copy response"/,
    "assistant response copy action should be discoverable",
  );
  assert.match(
    source,
    /Copy response/,
    "assistant response copy action should render at the bottom of each answer",
  );
});

test("project assistant renders the safe streamed error message", () => {
  const projectChatPage = fs.readFileSync(
    new URL(
      "../../(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const chatHook = fs.readFileSync(
    new URL("../../hooks/useAssistantChat.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    projectChatPage,
    /errorMessage=\{\s*typeof msg\.error === "string"/,
    "project assistant messages should receive the safe backend error text",
  );
  assert.match(
    chatHook,
    /if \(data\.type === "error"\)/,
    "the SSE reader should handle structured stream errors",
  );
  assert.match(
    chatHook,
    /if \(!sawDone\)/,
    "a stream closed by a backend restart should not look successful",
  );
});


test("PDF comments use an in-app editor instead of browser prompt", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /data-session-check="pdf-comment-editor"/,
    "comment actions must open a visible in-app editor",
  );
  assert.doesNotMatch(
    source,
    /window\.prompt/,
    "PDF comments should not depend on browser/Electron prompt dialogs",
  );
});

test("temporary Docket citation highlights can be selected for PDF promotion", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /readTemporaryHighlightSelection/,
    "DocView must turn clicked Docket citation highlights into selectable PDF ranges",
  );
  assert.match(
    source,
    /closest<HTMLElement>\([^)]*"\.pdf-text-highlight"/,
    "temporary citation highlight spans must be directly selectable",
  );
  assert.match(
    source,
    /source:\s*"citation"/,
    "temporary highlight selections must preserve citation provenance",
  );
  assert.match(
    source,
    /buildCitationPromotionCreatePayload/,
    "saving a selected temporary citation highlight must use the promotion payload",
  );
});

test("editing a saved PDF annotation anchors the editor near the annotation", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /getAnnotationEditorAnchor/,
    "saved annotation comment editing must compute an anchor from annotation geometry",
  );
  assert.doesNotMatch(
    source,
    /x:\s*window\.innerWidth\s*-\s*220/,
    "saved annotation comment editing should not open at a fixed upper-right fallback",
  );
});

test("PDF annotation UI supports draggable comment bubbles and Escape clear", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );
  // Pointer-drag interactions live in the extracted interactions module.
  const interactionsSource = fs.readFileSync(
    new URL("./pdfAnnotationInteractions.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    interactionsSource,
    /beginNoteDrag/,
    "comment note bubbles should be draggable",
  );
  assert.match(
    interactionsSource,
    /source_citation:\s*withNotePosition/,
    "dragging comment bubbles should persist note_position metadata",
  );
  assert.match(
    source,
    /event\.key !== "Escape"/,
    "Escape should clear PDF selection state",
  );
  assert.match(
    source,
    /removeAllRanges/,
    "Escape clear should also clear native browser text selection",
  );
});

test("PDF annotation UI clears selection chrome on empty viewer clicks", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /function clearPdfInteractionSelection\(\)/,
    "DocView should keep PDF selection cleanup in one shared routine",
  );
  assert.match(
    source,
    /setSelectedAnnotationId\(null\);[\s\S]*setContextMenu\(null\);[\s\S]*removeAllRanges/,
    "PDF cleanup must remove saved-annotation handles, quick menus, and native text selection",
  );
  assert.match(
    source,
    /if \(!current\) \{[\s\S]*clearPdfInteractionSelection\(\);[\s\S]*return;/,
    "clicking the viewer without a current selection should clear stale selection UI",
  );
  assert.match(
    source,
    /onPointerDown=\{handlePdfPointerDown\}/,
    "pointer-down should dismiss stale quick menus before an empty-click mouseup",
  );
});

test("desktop API base does not permanently cache fallback before Electron port is ready", () => {
  const source = fs.readFileSync(
    new URL("../../lib/docketApi.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /if \(bridge\?\.getApiPort\) {\s*return FALLBACK_API_BASE;\s*}/,
    "Electron bridge fallback must remain uncached so later dynamic ports can recover",
  );
  assert.doesNotMatch(
    source,
    /cachedApiBase = `http:\/\/localhost:\$\{port\}`/,
    "Electron bridge ports must not be session-cached because the dev backend watcher can restart on a new port",
  );
});

test("profile fetch failures degrade to the local default profile", () => {
  const source = fs.readFileSync(
    new URL("../../../contexts/UserProfileContext.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /\[profile\] fetch failed:/,
    "profile fetch failures should be caught instead of reaching the Next.js error overlay",
  );
  assert.match(
    source,
    /return null;/,
    "failed profile fetches should fall back through toClientProfile(null)",
  );
});

test("sidebar exposes account settings as a Settings nav item", () => {
  const source = fs.readFileSync(
    new URL("./AppSidebar.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /\{ href: "\/account", label: "Settings", icon: Settings \}/,
    "account settings must stay reachable from the sidebar nav",
  );
  assert.doesNotMatch(
    source,
    /pb-24/,
    "the bottom-left account control was removed; its pill-clearing padding must not return without it",
  );
});

test("desktop startup skips the project chooser and opens projects", () => {
  const rootPage = fs.readFileSync(
    new URL("../../page.tsx", import.meta.url),
    "utf8",
  );
  const mainTs = fs.readFileSync(
    new URL("../../../../../electron/main.ts", import.meta.url),
    "utf8",
  );
  const preloadJs = fs.readFileSync(
    new URL("../../../../../electron/preload.js", import.meta.url),
    "utf8",
  );
  const copyScript = fs.readFileSync(
    new URL("../../../../../scripts/copy-electron-assets.js", import.meta.url),
    "utf8",
  );

  assert.match(rootPage, /redirect\("\/projects"\)/);
  assert.match(mainTs, /new URL\("\/projects", FRONTEND_URL\)/);
  assert.doesNotMatch(mainTs, /loadLockScreen/);
  assert.doesNotMatch(preloadJs, /pickWorkspace|startDefaultSession|getState/);
  assert.match(copyScript, /rmSync\(path\.join\(out, "lock"\)/);
  assert.equal(
    fs.existsSync(new URL("../../../../../electron/lock", import.meta.url)),
    false,
    "desktop start chooser assets should not exist",
  );
});

test("desktop launch starts an app-level session while preserving project-path smoke support", () => {
  const mainTs = fs.readFileSync(
    new URL("../../../../../electron/main.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    mainTs,
    /installSessionCheck\(win\);\s*void startLocalSession\(activeProjectPath\)/,
    "desktop startup should immediately start a session instead of loading a chooser",
  );
  assert.match(
    mainTs,
    /spawnBackend\(\{[\s\S]*appDataPath: appData/,
    "project-free startup should run against app-level state so registry projects remain visible",
  );
  assert.match(
    mainTs,
    /DOCKET_SESSION_CHECK_DEFAULT_SESSION/,
    "session smoke can exercise project-free startup",
  );
  assert.match(
    mainTs,
    /DOCKET_SESSION_CHECK_PROJECT_PATH/,
    "session-check can still start with an explicitly supplied project folder",
  );
  assert.doesNotMatch(
    mainTs,
    /isDirectoryUsable\(cfg\.lastWorkspace\)/,
    "desktop startup should not validate or auto-load the legacy lastWorkspace key",
  );
  assert.doesNotMatch(
    mainTs,
    /activeProjectPath = cfg\.lastWorkspace/,
    "desktop startup should not promote the legacy lastWorkspace key to the active project",
  );
  assert.doesNotMatch(mainTs, /ipcMain\.handle\("docket:pickWorkspace"/);
  assert.doesNotMatch(mainTs, /ipcMain\.handle\("docket:startDefaultSession"/);
});

test("projects list route stays registry-only for fast desktop startup", () => {
  const projectsRoute = fs.readFileSync(
    new URL("../../../../../backend/src/routes/projects.ts", import.meta.url),
    "utf8",
  );
  const listRouteStart = projectsRoute.indexOf('projectsRouter.get("/",');
  const nextRouteStart = projectsRoute.indexOf("projectsRouter.post", listRouteStart);
  const listRoute = projectsRoute.slice(listRouteStart, nextRouteStart);

  assert.match(
    listRoute,
    /listRegisteredProjects/,
    "project lists should come from the app-level registry",
  );
  assert.doesNotMatch(
    listRoute,
    /ensureProjectRowInProjectDb|projectContextFor|runWithDatabaseContext/,
    "project lists must not open every project database during startup",
  );
});

test("local desktop app does not route users through login", () => {
  const appLayout = fs.readFileSync(
    new URL("../../(pages)/layout.tsx", import.meta.url),
    "utf8",
  );
  const accountLayout = fs.readFileSync(
    new URL("../../(pages)/account/layout.tsx", import.meta.url),
    "utf8",
  );
  const loginPage = fs.readFileSync(
    new URL("../../login/page.tsx", import.meta.url),
    "utf8",
  );
  const signupPage = fs.readFileSync(
    new URL("../../signup/page.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(appLayout, /\/login/);
  assert.doesNotMatch(accountLayout, /isAuthenticated|authLoading/);
  assert.match(loginPage, /router\.replace\("\/projects"\)/);
  assert.match(signupPage, /router\.replace\("\/projects"\)/);
});

test("local desktop app does not expose sign out or account deletion UI", () => {
  const accountPage = fs.readFileSync(
    new URL("../../(pages)/account/page.tsx", import.meta.url),
    "utf8",
  );
  const preload = fs.readFileSync(
    new URL("../../../../../electron/preload.js", import.meta.url),
    "utf8",
  );
  const electronMain = fs.readFileSync(
    new URL("../../../../../electron/main.ts", import.meta.url),
    "utf8",
  );
  const authContext = fs.readFileSync(
    new URL("../../../contexts/AuthContext.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(accountPage, /Sign Out|Delete Account|deleteAccount/);
  assert.doesNotMatch(preload, /signOut|docket:signOut/);
  assert.doesNotMatch(electronMain, /docket:signOut/);
  assert.match(authContext, /const LOCAL_USER/);
  assert.match(authContext, /isAuthenticated:\s*true/);
});

test("project assistant citation tabs pass the cited version into the PDF viewer", () => {
  const source = fs.readFileSync(
    new URL(
      "../../(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    source,
    /version_id:\s*activeTab\.versionId\s*\?\?\s*null/,
    "project chat DocView must load the active tab version",
  );
  assert.match(
    source,
    /normalizedCitation/,
    "citation click handling should normalize incomplete citation metadata before opening a tab",
  );
  assert.match(
    source,
    /docLabelMatch[\s\S]*docs\[Number\(docLabelMatch\[1\]\)\]/,
    "citation click handling should resolve chat-local doc-N labels when backend metadata is incomplete",
  );
});

test("project assistant document tabs expose previous and next navigation", () => {
  const source = fs.readFileSync(
    new URL(
      "../../(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /data-session-check="project-doc-prev-tab"/);
  assert.match(source, /data-session-check="project-doc-next-tab"/);
  assert.match(source, /onClick=\{\(\) => switchTabByOffset\(-1\)\}/);
  assert.match(source, /onClick=\{\(\) => switchTabByOffset\(1\)\}/);
  assert.match(source, /disabled=\{activeTabIndex <= 0\}/);
  assert.match(source, /disabled=\{activeTabIndex >= tabs\.length - 1\}/);
});

test("PDF annotation custom colors replace a persisted seven-color palette slot", () => {
  const docView = fs.readFileSync(new URL("./DocView.tsx", import.meta.url), "utf8");
  const picker = fs.readFileSync(
    new URL("./PdfCustomColorPicker.tsx", import.meta.url),
    "utf8",
  );
  const providers = fs.readFileSync(
    new URL("../../../components/providers.tsx", import.meta.url),
    "utf8",
  );

  assert.match(docView, /replacePaletteColor\(paletteIndex, color\)/);
  assert.match(docView, /annotationColors\.map\(\(color, index\) =>/);
  assert.match(picker, /onApply\(hex, slotIndex\)/);
  assert.match(picker, /const displayedColor = selected \? hex : color/);
  assert.match(picker, /data-palette-index=\{index\}/);
  assert.match(picker, /aria-pressed=\{selected\}/);
  assert.match(providers, /AnnotationColorPaletteProvider/);
});

test("project chat preserves document search context in the explorer pane", () => {
  const projectPage = fs.readFileSync(
    new URL("../projects/ProjectPage.tsx", import.meta.url),
    "utf8",
  );
  const chatPage = fs.readFileSync(
    new URL(
      "../../(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    projectPage,
    /params\.set\("q", q\)/,
    "creating a chat from the documents page should carry the active search query",
  );
  assert.match(
    projectPage,
    /params\.set\("type", projectSearchType\)/,
    "creating a chat from the documents page should carry the active file-type filter",
  );
  assert.match(
    chatPage,
    /useSearchParams/,
    "project chat should read the search context from the URL",
  );
  assert.match(
    chatPage,
    /searchProjectDocuments\(projectId/,
    "project chat explorer should execute project document searches",
  );
  assert.match(
    chatPage,
    /const CHAT_SEARCH_PAGE_SIZES = \[10, 25, 50\] as const/,
    "project chat explorer search should keep the same result-page size controls",
  );
  assert.match(
    chatPage,
    /explorerSearchActive \? \(/,
    "project chat should show search results in the explorer pane when a search is active",
  );
  assert.match(
    chatPage,
    /<ProjectExplorer/,
    "project chat should keep the original folder explorer when no search is active",
  );
  assert.match(
    chatPage,
    /buildAssistantSearchQuote\(\s*result,/,
    "clicking a chat explorer search result should open the document at the matched quote",
  );
});

test("project document search highlights basic-match snippets", () => {
  const source = fs.readFileSync(
    new URL("../projects/ProjectPage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /function findSearchHighlightRanges/,
    "project search should have a client-side fallback highlighter for basic matches",
  );
  assert.match(
    source,
    /normalizeSearchTerms/,
    "project search should use the same normalized terms for matching and highlighting",
  );
  assert.match(
    source,
    /\(\?:\['’\]s\)\?/,
    "multi-word project searches should highlight possessive forms like judge's discretion",
  );
  assert.match(
    source,
    /function trimSearchTerm/,
    "basic-match keyword highlighting should trim punctuation without dropping non-English terms",
  );
  assert.match(
    source,
    /renderSearchSnippet\(\s*result\.snippet,\s*projectSearchDisplayQuery,\s*\)/,
    "search result snippets must receive the active query for basic-match highlighting",
  );
});

test("project index status shows circular indexing and embedding progress", () => {
  const source = fs.readFileSync(
    new URL("../projects/ProjectPage.tsx", import.meta.url),
    "utf8",
  );
  const api = fs.readFileSync(
    new URL("../../lib/docketApi.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /function CircularProgressPill/,
    "project index status should render a circular progress pill",
  );
  assert.match(
    source,
    /conic-gradient/,
    "the circular progress indicator should fill by percentage",
  );
  assert.match(
    source,
    /label="indexing"/,
    "documents tab should show indexing progress as a labeled percentage",
  );
  assert.match(
    source,
    /label="embedding"/,
    "documents tab should show embedding progress as a labeled percentage",
  );
  assert.match(
    source,
    /currentIndexProgress\?\.active \|\| currentSemanticProgress\?\.active[\s\S]*\? 1000[\s\S]*: 5000/,
    "index status polling should speed up while indexing or embedding is active",
  );
  assert.match(
    source,
    /Start Embedding/,
    "documents tab should expose a manual embedding start button",
  );
  assert.match(
    source,
    /Pause Embedding/,
    "documents tab should expose a manual embedding pause button",
  );
  assert.match(
    source,
    /Compact Database/,
    "documents tab should expose manual project database compaction",
  );
  assert.match(
    source,
    /indexStatus\.semantic\?\.paused/,
    "semantic status should visibly reflect paused embedding",
  );
  assert.match(
    api,
    /index\/semantic\/start/,
    "frontend API should call the semantic embedding start endpoint",
  );
  assert.match(
    api,
    /index\/semantic\/pause/,
    "frontend API should call the semantic embedding pause endpoint",
  );
  assert.match(
    api,
    /index\/compact/,
    "frontend API should call the project database compaction endpoint",
  );
});

test("project document search paginates and opens results at the matched page", () => {
  const projectPage = fs.readFileSync(
    new URL("../projects/ProjectPage.tsx", import.meta.url),
    "utf8",
  );
  const modal = fs.readFileSync(
    new URL("./DocViewModal.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    projectPage,
    /const PROJECT_SEARCH_PAGE_SIZES = \[10, 25, 50\] as const/,
    "project search should expose 10/25/50 result page sizes",
  );
  assert.match(
    projectPage,
    /projectSearchVisibleResults\.map/,
    "search result rendering should use the paginated result slice",
  );
  assert.doesNotMatch(
    projectPage,
    /neighbors:\s*true/,
    "the visible project search list should not include neighboring chunks that do not themselves match",
  );
  assert.match(
    projectPage,
    /openDocumentViewerFromSearch\(doc,\s*result\)/,
    "clicking a search result should route through the shared search-result viewer opener",
  );
  assert.match(
    projectPage,
    /const payload: DocumentViewerPayload = \{\s*documentId: doc\.id,\s*filename: options\.filename \|\| doc\.filename,\s*versionId: version\?\.id \?\? null,\s*versionLabel: version\?\.label \?\? null,\s*searchQuote: searchTarget\?\.quote \?\? null,\s*searchPage: searchTarget\?\.page \?\? null,\s*searchKey: searchTarget\?\.key \?\? null,\s*annotationId: annotation\?\.id \?\? null,\s*projectId,\s*\}/,
    "Electron search-result opening should pass the matched quote, page, chunk key, annotation focus, and project to the native viewer window",
  );
  assert.match(
    projectPage,
    /bridge\s*\.openDocumentViewer\(payload\)/,
    "Electron document opening should send the prepared viewer payload through the native bridge",
  );
  assert.match(
    projectPage,
    /setViewingDocSearchTarget\(searchTarget\)/,
    "non-Electron fallback should still carry the per-result opener quote and chunk page into the modal viewer",
  );
  assert.match(
    projectPage,
    /initialSearchPage=\{viewingDocSearchTarget\?\.page \?\? null\}/,
    "the project page should pass the matched page into the document modal",
  );
  assert.match(
    modal,
    /fallbackPage=\{initialSearchPage \?\? undefined\}/,
    "the document modal should ask the PDF viewer to start at the matched page",
  );
  assert.match(
    modal,
    /quotes=\{searchQuotes\}/,
    "the document modal should pass the search quote to PDF and DOCX viewers",
  );
});

test("project search opens markdown results at the matching chunk instead of the first keyword", () => {
  const projectPage = fs.readFileSync(
    new URL("../projects/ProjectPage.tsx", import.meta.url),
    "utf8",
  );
  const markdownView = fs.readFileSync(
    new URL("./MarkdownDocView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    projectPage,
    /function buildSearchOpenQuote\(result: ProjectSearchResult, query: string\)/,
    "search result clicks should choose an opener quote per result",
  );
  assert.match(
    projectPage,
    /const opener = stripSearchHighlightMarkers\(\s*result\.snippet \|\| result\.quote \|\| result\.content \|\| query,\s*\)/,
    "search results should open using their own snippet or chunk, not the first global query match",
  );
  assert.match(
    projectPage,
    /return opener \|\| query;/,
    "PDF results should also open using the matched snippet when available",
  );
  assert.match(
    projectPage,
    /const quote = buildSearchOpenQuote\(result, projectSearchDisplayQuery\)/,
    "search result click-through should pass the per-result opener quote",
  );
  assert.match(
    markdownView,
    /for \(let start = 0; start < words\.length; start \+= 8\)/,
    "long markdown chunks should be broken into matchable windows",
  );
});

test("PDF search result opening virtualizes and prioritizes the hinted page", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const initialPage = Math\.min\([\s\S]*Math\.max\(1, hintedPage\),[\s\S]*\);/,
    "PDF rendering should derive an initial page from the citation/search page hint",
  );
  assert.match(
    source,
    /for \(let pageNum = 1; pageNum <= doc\.numPages; pageNum\+\+\) \{[\s\S]*resetWrapperToPlaceholder\(wrapper, pageNum, scale\);[\s\S]*pageWrappersRef\.current\[pageNum - 1\] = wrapper;[\s\S]*\}/,
    "PDF rendering should create fixed placeholders for every page before windowed rendering",
  );
  assert.match(
    source,
    /pdfRuntimeRef\.current = \{ doc, lib, scale, renderRun, container \};[\s\S]*scheduleWindowRender\(initialPage\);/,
    "PDF rendering should schedule the hinted page window first",
  );
  assert.match(
    source,
    /const pageEntry = await ensurePageRendered\(candidatePage\);/,
    "citation and search highlights should render only their target page before scrolling",
  );
});

test("document viewer renders markdown files without a new dependency", () => {
  const docView = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );
  const markdownView = fs.readFileSync(
    new URL("./MarkdownDocView.tsx", import.meta.url),
    "utf8",
  );
  const fetchHook = fs.readFileSync(
    new URL("../../hooks/useFetchSingleDoc.ts", import.meta.url),
    "utf8",
  );
  const documentsRoute = fs.readFileSync(
    new URL("../../../../../backend/src/routes/documents.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    fetchHook,
    /contentType\.includes\("text\/markdown"\)/,
    "the display fetcher should recognize markdown responses",
  );
  assert.match(
    documentsRoute,
    /text\/markdown; charset=utf-8/,
    "the backend display route should serve .md files as markdown",
  );
  assert.match(
    docView,
    /<MarkdownDocView[\s\S]*kind=\{result\.type === "markdown" \? "markdown" : "text"\}/,
    "DocView should route markdown/text display results to the lightweight renderer",
  );
  assert.match(
    markdownView,
    /import ReactMarkdown from "react-markdown"/,
    "markdown rendering should reuse the existing ReactMarkdown dependency",
  );
  assert.match(
    markdownView,
    /remarkPlugins=\{\[remarkGfm\]\}/,
    "markdown files should render GitHub-flavored tables and lists",
  );
  assert.match(
    markdownView,
    /data-session-check="markdown-doc-view"/,
    "markdown rendering needs a stable smoke-test selector",
  );
  assert.match(
    markdownView,
    /data-markdown-search-highlight/,
    "search-opened markdown files should highlight the passed quote when possible",
  );
});

test("PDF annotation payload captures color, comment, version, and geometry", () => {
  const rects: PdfAnnotationRect[] = [
    { page: 3, x: 10, y: 20, width: 150, height: 12 },
  ];

  const payload = buildPdfAnnotationCreatePayload({
    rects,
    annotationType: "comment",
    color: "#74c0fc",
    displayVersionId: "display-version",
    documentVersionId: "original-version",
    quote: "Selected clause text",
    comment: "Needs follow-up",
  });

  assert.deepEqual(payload, {
    version_id: "display-version",
    page_number: 3,
    annotation_type: "comment",
    color: "#74c0fc",
    quote: "Selected clause text",
    comment: "Needs follow-up",
    rects,
    source: "user",
    source_citation: null,
  });
});

test("citation promotion payload preserves Docket temporary highlight provenance", () => {
  const rects: PdfAnnotationRect[] = [
    { page: 7, x: 14, y: 22, width: 180, height: 10 },
    { page: 7, x: 14, y: 38, width: 120, height: 10 },
  ];

  const payload = buildCitationPromotionCreatePayload({
    rects,
    quoteList: [
      {
        quote: "Borrower shall deliver evidence of authority",
        citation: annotationA,
      },
    ],
    color: "#ffe066",
    documentVersionId: "version-a",
  });

  assert.equal(payload?.annotation_type, "highlight");
  assert.equal(payload?.source, "citation_promotion");
  assert.equal(payload?.source_citation?.document_id, "document-a");
  assert.equal(payload?.source_citation?.version_id, "version-a");
  assert.equal(payload?.quote, annotationA.quote);
  assert.deepEqual(payload?.rects, rects);
});

test("PDF annotation save status is transient", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const showAnnotationStatus = useCallback\(\s*\(message: string \| null, autoClearMs\?: number\) => \{/,
    "DocView should route annotation status changes through one helper",
  );
  assert.match(
    source,
    /annotationStatusRunRef\.current \+= 1;[\s\S]*window\.setTimeout\(\(\) => \{[\s\S]*setAnnotationStatus\(null\);[\s\S]*\}, autoClearMs\);/,
    "transient status messages should clear themselves without clearing newer statuses",
  );
  assert.match(
    source,
    /showAnnotationStatus\("Saved", 1600\)/,
    "successful annotation saves should show a short-lived Saved status",
  );
});

test("citation save promotes highlights to app metadata until explicit PDF export", () => {
  const source = fs.readFileSync(
    new URL("./DocView.tsx", import.meta.url),
    "utf8",
  );
  const promoteBody = source.match(
    /async function handlePromoteCitationHighlight\(\) \{([\s\S]*?)\n    \}/,
  )?.[1];
  assert.ok(promoteBody);

  assert.match(
    promoteBody,
    /saveAnnotationPayload\([\s\S]*buildCitationPromotionCreatePayload/,
    "citation Save should create an app-managed annotation row",
  );
  assert.doesNotMatch(
    promoteBody,
    /exportAnnotatedPdf/,
    "citation Save must not embed annotations into PDF bytes",
  );
  assert.match(
    source,
    /async function handleExportAnnotatedPdf\(\)[\s\S]*exportAnnotatedPdf\(/,
    "PDF embedding should remain behind the explicit Export PDF action",
  );
  assert.doesNotMatch(
    source,
    /setDisplayVersionId\(version\.id\)|setAnnotationVersionId\(version\.id\)/,
    "Export PDF should download a generated artifact without switching the editable annotation source",
  );
});

class FakeElement {
  textContent: string;
  innerHTML = "";
  private readonly attrs = new Map<string, string>();

  constructor(text: string) {
    this.textContent = text;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
}
