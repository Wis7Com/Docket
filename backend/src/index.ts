import dotenv from "dotenv";
// Under Electron the main process injects FRONTEND_URL, JWT_SECRET, etc.
// directly into our env (signalled by APP_DATA_PATH, or legacy WORKSPACE_PATH
// during old dev/test launches). Loading a .env from disk in that mode would
// let a stray file next to the binary override what Electron set. Only load
// .env in standalone dev runs.
if (!process.env.APP_DATA_PATH && !process.env.WORKSPACE_PATH) {
  dotenv.config();
}
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import * as fs from "fs";
import * as path from "path";
import { runMigrations } from "./db/migrate";
import { probeLibreOffice } from "./lib/libreofficeStatus";
import { setServerPort } from "./lib/serverPort";
import { MAX_UPLOAD_SIZE_BYTES } from "./lib/upload";
import { requireAuth } from "./middleware/auth";
import {
  appDataPath,
  appDbPath,
  enterDatabaseContext,
  resolveDataDir,
} from "./db/sqlite";
import {
  chatDbRequestContext,
  documentDbRequestContext,
  projectDbRequestContext,
} from "./lib/projectRegistry";
import { createProjectFromFolder } from "./lib/projectFolders";
import { createServerSupabase } from "./lib/supabase";
import { migrateLegacyWorkspaceIfNeeded } from "./lib/legacyMigration";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { generateTabularPromptHandler, tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";
import { authRouter } from "./routes/auth";
import { filesRouter } from "./routes/files";

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true,
  }),
);

// Match the multer upload cap (100 MB) so JSON-bodied requests carrying
// a file payload don't 413 below the multipart cap.
app.use(express.json({ limit: MAX_UPLOAD_SIZE_BYTES }));

// Reset the database context on every request. The per-route context
// middlewares use AsyncLocalStorage.enterWith(), which leaks into the
// next request handled on the same keep-alive socket — without this
// reset, e.g. POST /chat/create could run inside whichever project DB
// the previous request touched and fail its project_id foreign key.
app.use((_req, _res, next) => {
  enterDatabaseContext({
    kind: "app",
    dbPath: appDbPath(),
    dataRoot: appDataPath(),
  });
  next();
});

app.use("/chat/:chatId", chatDbRequestContext);
app.use("/chat", chatRouter);
app.use(
  "/projects/:projectId/tabular-reviews",
  requireAuth,
  projectDbRequestContext,
  tabularRouter,
);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", requireAuth, projectDbRequestContext);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents/:documentId", documentDbRequestContext);
app.use("/single-documents", documentsRouter);
app.post("/tabular-column-prompt", requireAuth, generateTabularPromptHandler);
app.use("/tabular-review", requireAuth, (_req, res) => {
  res.status(410).json({
    detail: "Global tabular reviews were removed; open a project instead",
    code: "global_tabular_review_removed",
  });
});
app.use("/workflows", workflowsRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);
app.use("/auth", authRouter);
app.use("/files", filesRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Global error handler — must be the last app.use(). Prevents Express's
// default handler from leaking stack traces into the response body. Errors
// are still logged in full server-side.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[error-handler]", err);
  if (res.headersSent) return;
  // Surface common client errors with their original status, suppress
  // everything else as 500 with a generic message.
  if (
    err instanceof SyntaxError &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number" &&
    (err as { status: number }).status === 400
  ) {
    res.status(400).json({ detail: "Malformed JSON in request body" });
    return;
  }
  res.status(500).json({ detail: "Internal server error" });
});

async function startServer(): Promise<void> {
  try {
    runMigrations();
  } catch (err) {
    console.error("[startup] app migrations failed:", err);
    process.exit(1);
  }

  try {
    migrateLegacyWorkspaceIfNeeded({
      legacyWorkspacePath: process.env.LEGACY_WORKSPACE_PATH,
      appDataPath: appDataPath(),
      userId: process.env.LOCAL_USER_ID ?? "local-user",
    });
  } catch (err) {
    console.error("[startup] legacy workspace migration failed:", err);
  }

  if (process.env.ACTIVE_PROJECT_PATH) {
    try {
      await createProjectFromFolder({
        db: createServerSupabase(),
        userId: process.env.LOCAL_USER_ID ?? "local-user",
        folderPath: process.env.ACTIVE_PROJECT_PATH,
      });
    } catch (err) {
      console.error("[startup] active project registration failed:", err);
    }
  }

  probeLibreOffice().then((p) => {
    console.log(
      p.available
        ? `[startup] LibreOffice detected: ${p.version}`
        : "[startup] LibreOffice not detected (DOC/DOCX → PDF rendition disabled)",
    );
  });

  // C3: bind to the OS-assigned port (PORT=0 from the spawning Electron main),
  // then publish the assigned port to <appData>/runtime.json so the
  // renderer can discover it. Falls back to 3001 if PORT is set explicitly
  // (useful for `npm --prefix backend run dev`).
  const requestedPort = Number(process.env.PORT ?? 3001);

  const server = app.listen(requestedPort, "127.0.0.1", () => {
    const addr = server.address();
    const actualPort =
      typeof addr === "object" && addr ? addr.port : requestedPort;
    setServerPort(actualPort);
    console.log(`Docket backend running on port ${actualPort}`);
    try {
      const runtimeDir = resolveDataDir(appDataPath());
      fs.mkdirSync(runtimeDir, { recursive: true });
      const tmp = path.join(runtimeDir, `runtime.json.${process.pid}.tmp`);
      const dest = path.join(runtimeDir, "runtime.json");
      fs.writeFileSync(
        tmp,
        JSON.stringify({ port: actualPort, pid: process.pid }, null, 2),
      );
      fs.renameSync(tmp, dest);
    } catch (err) {
      console.warn("[startup] failed to write runtime.json:", err);
    }
  });
}

void startServer();
