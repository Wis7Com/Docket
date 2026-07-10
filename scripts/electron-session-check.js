// Boots the compiled Electron main with a temporary project folder and waits
// until the spawned backend responds on /health.
//
// Run after `npm run build:electron`:
//   node scripts/electron-session-check.js

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const electron = require("electron");

const root = path.resolve(__dirname, "..");
const defaultSessionCheck =
  process.env.DOCKET_SESSION_CHECK_DEFAULT_SESSION === "1";
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docket-session-check-"));
const userDataRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "docket-session-user-data-"),
);
const sourceRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "docket-session-source-"),
);
const promptSourceRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "docket-session-prompt-source-"),
);
let frontendPort = 0;
let frontendUrl = "";
let frontendProc = null;
let fakeOpenAiServer = null;
let fakeOpenAiBaseUrl = "";

async function main() {
  fs.mkdirSync(path.join(projectRoot, ".docket"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "files"), { recursive: true });
  if (!defaultSessionCheck) {
    await writeSamplePdf(path.join(sourceRoot, "session-source.pdf"));
    await writePromptSourceFolder(promptSourceRoot);
  }
  // Bookmark-less PDF with numbered/large headings across two pages. The
  // outline-generation smoke uploads this, asserts the "Generate outline"
  // empty state appears, and drives the heuristic outline flow (C2).
  const outlinePdfB64 = defaultSessionCheck
    ? ""
    : Buffer.from(await buildOutlineFixturePdfBytes()).toString("base64");
  await startFakeOpenAiServer();
  frontendPort = await getFreePort();
  frontendUrl = `http://127.0.0.1:${frontendPort}`;
  await ensureFrontend();

  const sessionEnv = defaultSessionCheck
    ? {
        DOCKET_SESSION_CHECK_DEFAULT_SESSION: "1",
      }
    : {
        DOCKET_SESSION_CHECK_PROJECT_PATH: projectRoot,
        DOCKET_SESSION_CHECK_SOURCE_DIR: sourceRoot,
        DOCKET_SESSION_CHECK_PROMPT_SOURCE_DIR: promptSourceRoot,
        DOCKET_SESSION_CHECK_OUTLINE_PDF_B64: outlinePdfB64,
      };

  const proc = spawn(electron, [path.join(root, "dist-electron", "main.js")], {
    env: {
      ...electronEnv(),
      NODE_ENV: "development",
      DOCKET_USER_DATA_DIR: userDataRoot,
      DOCKET_SESSION_CHECK: "1",
      DOCKET_SESSION_CHECK_TIMEOUT_MS:
        process.env.DOCKET_SESSION_CHECK_TIMEOUT_MS ?? "120000",
      ...(defaultSessionCheck
        ? {}
        : { DOCKET_SESSION_CHECK_EXPECT_PROJECT_PATH: projectRoot }),
      ...sessionEnv,
      DOCKET_SKIP_LIBREOFFICE_PROBE: "1",
      DOCKET_FRONTEND_PORT: String(frontendPort),
      DOCKET_FRONTEND_URL: frontendUrl,
      OPENAI_BASE_URL: fakeOpenAiBaseUrl,
      OPENAI_API_KEY: "session-check-openai-key",
      FREE_ROUTER_PROXY_BASE_URL: fakeOpenAiBaseUrl,
      FREE_ROUTER_PROXY_LOCAL_API_KEY: "session-check-openai-key",
      FREE_ROUTER_TITLE_MODEL: "free-router:free-router/best",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (b) => {
    const s = b.toString();
    stdout += s;
    process.stdout.write(s);
  });
  proc.stderr.on("data", (b) => {
    const s = b.toString();
    stderr += s;
    process.stderr.write(s);
  });

  const killAfter = setTimeout(() => {
    proc.kill();
  }, Number(process.env.DOCKET_SESSION_CHECK_TIMEOUT_MS ?? "120000") + 10_000);

  const result = await new Promise((resolve) => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(killAfter);
  stopFrontend();
  stopFakeOpenAiServer();
  cleanupTempDirs();

  const passed = stdout.includes("SESSION CHECK: PASS");
  console.log(`exit code=${result.code} signal=${result.signal}`);
  if (passed && result.code === 0) {
    process.exit(0);
  }
  console.error("---STDOUT---");
  console.error(stdout);
  console.error("---STDERR---");
  console.error(stderr);
  process.exit(1);
}

function electronEnv() {
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  return env;
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

main().catch((err) => {
  stopFrontend();
  stopFakeOpenAiServer();
  cleanupTempDirs();
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

async function writeSamplePdf(filePath) {
  const { PDFDocument, StandardFonts } = require(
    path.join(root, "backend", "node_modules", "pdf-lib"),
  );
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Session check source clause for citation promotion.", {
    x: 72,
    y: 700,
    size: 12,
    font,
  });
  const bytes = await pdf.save();
  fs.writeFileSync(filePath, Buffer.from(bytes));
}

// A two-page PDF with no /Outlines (bookmarks) but visually distinct numbered
// headings (large font) over body text — the shape the heuristic outline
// generator is meant to detect. Returns raw bytes.
async function buildOutlineFixturePdfBytes() {
  const { PDFDocument, StandardFonts } = require(
    path.join(root, "backend", "node_modules", "pdf-lib"),
  );
  const pdf = await PDFDocument.create();
  const headingFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const bodyFont = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [
    {
      heading: "1. Introduction",
      later: "2. Scope Of Services",
    },
    {
      heading: "3. Definitions And Interpretation",
      later: "4. Obligations Of The Parties",
    },
  ];
  for (const spec of pages) {
    const page = pdf.addPage([612, 792]);
    page.drawText(spec.heading, { x: 72, y: 720, size: 22, font: headingFont });
    let y = 690;
    for (let i = 0; i < 8; i += 1) {
      page.drawText(
        "This clause contains ordinary body copy used to establish the dominant font size.",
        { x: 72, y, size: 11, font: bodyFont },
      );
      y -= 18;
    }
    page.drawText(spec.later, { x: 72, y: y - 12, size: 22, font: headingFont });
    y -= 40;
    for (let i = 0; i < 6; i += 1) {
      page.drawText(
        "More ordinary body copy so the heading stands out against the paragraph text.",
        { x: 72, y, size: 11, font: bodyFont },
      );
      y -= 18;
    }
  }
  const bytes = await pdf.save();
  return bytes;
}

async function writePromptSourceFolder(rootDir) {
  await writeSamplePdf(path.join(rootDir, "00-session-source.pdf"));
  for (let i = 1; i <= 20; i += 1) {
    const name = String(i).padStart(2, "0");
    fs.writeFileSync(
      path.join(rootDir, `${name}-filler.md`),
      `# Filler ${name}\n\nThis file exists only to make the prompt test use indexed search rather than the small-corpus full-read shortcut.\n`,
    );
  }
}

async function startFakeOpenAiServer() {
  fakeOpenAiServer = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(bodyText);
      console.log(`[prompt-fake-openai] completion model=${body.model}`);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const toolNames = tools.map((tool) => tool?.function?.name).filter(Boolean);
      const hasToolResult = messages.some((message) => message.role === "tool");
      const messageText = messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
        )
        .join("\n");
      const wantsSessionClause =
        /Session check source clause|00-session-source\.pdf|source clause/i.test(
          messageText,
        );

      if (!body.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "Session prompt citation test" } }],
          }),
        );
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      if (!hasToolResult && toolNames.includes("search_project_documents")) {
        console.log("[prompt-fake-openai] requesting search_project_documents");
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-search-session-source",
                      type: "function",
                      function: {
                        name: "search_project_documents",
                        arguments: JSON.stringify({
                          query: wantsSessionClause
                            ? "Session check source clause"
                            : "DAO scoping paper Law Commission",
                          limit: 4,
                          include_neighbors: true,
                          file_types: ["pdf"],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }

      console.log("[prompt-fake-openai] returning cited answer");
      const toolMessage = [...messages]
        .reverse()
        .find((message) => message.role === "tool" && typeof message.content === "string");
      let firstResult = null;
      if (toolMessage) {
        try {
          const parsed = JSON.parse(toolMessage.content);
          firstResult = Array.isArray(parsed?.results) ? parsed.results[0] : null;
        } catch {
          firstResult = null;
        }
      }
      const rawDocId = firstResult?.doc_id || firstResult?.document_id || "doc-0";
      const docId = /^doc-\d+$/.test(String(rawDocId)) ? rawDocId : "doc-0";
      const page = firstResult?.page || firstResult?.page_number || 1;
      function compactProjectQuote(result) {
        const raw =
          (typeof result?.content === "string" && result.content.trim()) ||
          (typeof result?.quote === "string" && result.quote.trim()) ||
          "";
        const normalized = raw.replace(/\s+/g, " ").trim();
        if (!normalized) return "Law Commission DAO scoping paper";
        const lower = normalized.toLowerCase();
        const anchors = ["law commission", "dao", "decentralised"];
        const anchorIndex = anchors
          .map((anchor) => lower.indexOf(anchor))
          .filter((index) => index >= 0)
          .sort((a, b) => a - b)[0];
        const start = Math.max(0, (anchorIndex ?? 0) - 20);
        let excerpt = normalized.slice(start, start + 120).trim();
        const lastSpace = excerpt.lastIndexOf(" ");
        if (lastSpace > 60) excerpt = excerpt.slice(0, lastSpace).trim();
        return excerpt || normalized.slice(0, 80).trim();
      }
      const quote = wantsSessionClause
        ? "Session check source clause"
        : compactProjectQuote(firstResult);
      const answerQuote = wantsSessionClause
        ? "Session check source clause for citation promotion."
        : quote.replace(/\s+/g, " ").slice(0, 220);
      const answer = wantsSessionClause
        ? 'The source clause says "Session check source clause for citation promotion." [1]\n\n' +
          "<CITATIONS>\n" +
          JSON.stringify(
            [
              {
                ref: 1,
                doc_id: docId,
                page,
                quote: "Session check source clause",
              },
            ],
            null,
            2,
          ) +
          "\n</CITATIONS>"
        : `The retrieved project source says "${answerQuote}" [1]\n\n` +
          "<CITATIONS>\n" +
          JSON.stringify(
            [
              {
                ref: 1,
                doc_id: docId,
                page,
                quote,
              },
            ],
            null,
            2,
          ) +
          "\n</CITATIONS>";
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: answer } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  fakeOpenAiServer.listen(0, "127.0.0.1");
  await new Promise((resolve) => fakeOpenAiServer.once("listening", resolve));
  const address = fakeOpenAiServer.address();
  fakeOpenAiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  console.log(`[prompt-fake-openai] listening on ${fakeOpenAiBaseUrl}`);
}

function stopFakeOpenAiServer() {
  if (fakeOpenAiServer?.listening) {
    fakeOpenAiServer.close();
  }
  fakeOpenAiServer = null;
}

async function ensureFrontend() {
  if (await isFrontendReady()) {
    console.log(
      `[session-check] using existing frontend on port ${frontendPort}`,
    );
    return;
  }
  frontendProc = spawn("npm", ["--prefix", "frontend", "run", "dev"], {
    cwd: root,
    env: { ...process.env, PORT: String(frontendPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  frontendProc.stdout.on("data", (b) => {
    process.stdout.write(`[frontend] ${b.toString()}`);
  });
  frontendProc.stderr.on("data", (b) => {
    process.stderr.write(`[frontend] ${b.toString()}`);
  });
  frontendProc.on("exit", (code, signal) => {
    if (frontendProc) {
      console.log(`[frontend] exited code=${code} signal=${signal}`);
    }
    frontendProc = null;
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isFrontendReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `frontend dev server did not become ready on port ${frontendPort}`,
  );
}

async function isFrontendReady() {
  try {
    const resp = await fetch(frontendUrl, {
      signal: AbortSignal.timeout(1000),
    });
    return resp.ok || resp.status < 500;
  } catch {
    return false;
  }
}

function stopFrontend() {
  if (frontendProc && !frontendProc.killed) {
    frontendProc.kill();
  }
  frontendProc = null;
}

function cleanupTempDirs() {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(userDataRoot, { recursive: true, force: true });
  fs.rmSync(sourceRoot, { recursive: true, force: true });
  fs.rmSync(promptSourceRoot, { recursive: true, force: true });
}
