import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import express from "express";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";

let testRoot = "";
let appDataDir = "";

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docket-local-test-"));
  appDataDir = path.join(testRoot, "app-data");
  process.env.APP_DATA_PATH = appDataDir;
  delete process.env.WORKSPACE_PATH;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  process.env.DOWNLOAD_SIGNING_SECRET = crypto.randomBytes(32).toString("hex");
  process.env.FRONTEND_URL = "http://localhost:3000";
  process.env.PORT = "0";
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
});

after(async () => {
  const { closeDb } = await import("../db/sqlite");
  closeDb();
  if (testRoot) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test("createProjectFromFolder registers an app project and stores document data in the project folder", async () => {
  const { createServerSupabase } = await import("./supabase");
  const { createProjectFromFolder } = await import("./projectFolders");
  const { projectContextFor } = await import("./projectRegistry");
  const { runWithDatabaseContext } = await import("../db/sqlite");
  const db = createServerSupabase();
  const projectFolder = path.join(testRoot, "project-root");
  fs.mkdirSync(projectFolder, { recursive: true });
  const rootPdf = path.join(projectFolder, "project-root.pdf");
  const internalPdf = path.join(projectFolder, ".docket", "internal.pdf");
  fs.mkdirSync(path.dirname(internalPdf), { recursive: true });
  fs.writeFileSync(
    rootPdf,
    Buffer.from(await samplePdfBytes("project root source")),
  );
  fs.writeFileSync(
    internalPdf,
    Buffer.from(await samplePdfBytes("internal storage should be skipped")),
  );

  const opened = await createProjectFromFolder({
    db,
    userId: "local-user",
    folderPath: projectFolder,
  });

  const { data: ownerProjects } = await db
    .from("projects")
    .select("id, name")
    .eq("user_id", "owner-user");
  assert.equal(ownerProjects?.length ?? 0, 0);

  const { data: localProjects } = await db
    .from("projects")
    .select("id, name, path")
    .eq("user_id", "local-user");
  assert.equal(localProjects?.length, 1);
  assert.equal(localProjects?.[0]?.name, path.basename(projectFolder));
  assert.equal(localProjects?.[0]?.id, opened.project.id);
  assert.equal(localProjects?.[0]?.path, fs.realpathSync(projectFolder));

  const projectId = localProjects?.[0]?.id as string;
  const projectRow = localProjects?.[0] as {
    id: string;
    path: string;
    name: string;
  };
  await runWithDatabaseContext(projectContextFor(projectRow), async () => {
    const projectDb = createServerSupabase();
    const { data: sourceFolders } = await projectDb
      .from("source_folders")
      .select("root_path, display_name")
      .eq("project_id", projectId);
    assert.equal(sourceFolders?.length, 1);
    assert.equal(sourceFolders?.[0]?.root_path, "project:.");

    const { data: docs } = await projectDb
      .from("documents")
      .select("filename, project_id")
      .eq("project_id", projectId);
    assert.deepEqual((docs ?? []).map((doc) => doc.filename).sort(), [
      "project-root.pdf",
    ]);
  });

  const { data: cachedProject } = await db
    .from("projects")
    .select("document_count_cache, chat_count_cache, review_count_cache")
    .eq("id", projectId)
    .single();
  assert.equal(cachedProject?.document_count_cache, 1);
  assert.equal(cachedProject?.chat_count_cache, 0);
  assert.equal(cachedProject?.review_count_cache, 0);
});

test("createProjectFromFolder opens the selected folder as a self-contained project", async () => {
  const { createServerSupabase } = await import("./supabase");
  const { createProjectFromFolder } = await import("./projectFolders");
  const { projectContextFor } = await import("./projectRegistry");
  const { runWithDatabaseContext } = await import("../db/sqlite");
  const db = createServerSupabase();
  const sourceRoot = fs.mkdtempSync(path.join(testRoot, "opened-folder-"));
  const sourceFile = path.join(sourceRoot, "matter.pdf");
  fs.writeFileSync(
    sourceFile,
    Buffer.from(await samplePdfBytes("opened project folder source")),
  );

  const opened = await createProjectFromFolder({
    db,
    userId: "folder-open-user",
    folderPath: sourceRoot,
  });

  assert.equal(opened.project.name, path.basename(sourceRoot));
  assert.equal(opened.scan.imported.length, 1);
  assert.equal(opened.sourceFolder.root_path, "project:.");

  const reopened = await createProjectFromFolder({
    db,
    userId: "folder-open-user",
    folderPath: sourceRoot,
  });
  assert.equal(reopened.project.id, opened.project.id);
  assert.equal(reopened.sourceFolder.id, opened.sourceFolder.id);

  await runWithDatabaseContext(
    projectContextFor(opened.project as { id: string; path: string }),
    async () => {
      const projectDb = createServerSupabase();
      const { data: docs } = await projectDb
        .from("documents")
        .select("filename")
        .eq("project_id", opened.project.id);
      assert.deepEqual(
        (docs ?? []).map((doc) => doc.filename),
        ["matter.pdf"],
      );
      const { data: sourceFolders } = await projectDb
        .from("source_folders")
        .select("id")
        .eq("project_id", opened.project.id);
      assert.equal(sourceFolders?.length, 1);
    },
  );

  const copiedUploadPath = path.join(appDataDir, "files", "documents");
  assert.equal(
    fs.existsSync(copiedUploadPath),
    false,
    "opening a project folder should not copy existing project-local source files",
  );
});

test("global chat history includes chats stored in owned project databases", async () => {
  const { signLocalJwt } = await import("../auth/local");
  const { chatRouter } = await import("../routes/chat");
  const { ensureProjectRowInProjectDb, registerProjectFolder } =
    await import("./projectRegistry");
  const { getAppDb, getDbForPath } = await import("../db/sqlite");

  const userId = "global-chat-user";
  const userEmail = "global-chat@example.com";
  const ownedRoot = fs.mkdtempSync(path.join(testRoot, "owned-chat-root-"));
  const sharedRoot = fs.mkdtempSync(path.join(testRoot, "shared-chat-root-"));
  const ownedProject = registerProjectFolder({
    folderPath: ownedRoot,
    userId,
    projectId: "owned-chat-project",
    name: "Owned Chat Project",
  });
  const sharedProject = registerProjectFolder({
    folderPath: sharedRoot,
    userId: "other-global-chat-user",
    projectId: "shared-chat-project",
    name: "Shared Chat Project",
  });
  const unavailableRoot = fs.mkdtempSync(
    path.join(testRoot, "unavailable-chat-root-"),
  );
  const unavailableDbPath = path.join(unavailableRoot, ".docket", "project.db");
  fs.mkdirSync(unavailableDbPath, {
    recursive: true,
  });
  getAppDb()
    .prepare(
      `INSERT INTO projects (
        id, user_id, name, path, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'available', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(
      "unavailable-chat-project",
      userId,
      "Unavailable Chat Project",
      unavailableRoot,
    );

  getAppDb()
    .prepare(
      "INSERT INTO chats (id, project_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "global-chat-app",
      null,
      userId,
      "Global Chat App Row",
      "2026-07-02T10:00:00.000Z",
    );

  const ownedCtx = ensureProjectRowInProjectDb(ownedProject);
  getDbForPath(ownedCtx.dbPath)
    .prepare(
      "INSERT INTO chats (id, project_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "global-chat-owned-project",
      ownedProject.id,
      "project-collaborator",
      "Global Chat Owned Project Row",
      "2026-07-02T11:00:00.000Z",
    );

  const sharedCtx = ensureProjectRowInProjectDb(sharedProject);
  getDbForPath(sharedCtx.dbPath)
    .prepare(
      "INSERT INTO chats (id, project_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "global-chat-shared-project",
      sharedProject.id,
      userId,
      "Global Chat Shared Project Row",
      "2026-07-02T12:00:00.000Z",
    );

  const app = express();
  app.use("/chat", chatRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const auth = {
      Authorization: `Bearer ${signLocalJwt(userId, userEmail)}`,
    };

    const startedAt = Date.now();
    const chats = await requestJson<{ id: string; title: string | null }[]>(
      `${base}/chat`,
      { headers: auth },
    );
    assert.ok(
      Date.now() - startedAt < 1_000,
      "global chat startup should skip an unavailable project DB without retrying",
    );
    const returnedIds = chats.map((chat) => chat.id);

    assert.deepEqual(
      returnedIds.filter((id) => id.startsWith("global-chat-")),
      ["global-chat-owned-project", "global-chat-app"],
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("viewer chat creation and lookup stay fast when a project database is unavailable", async () => {
  const { signLocalJwt } = await import("../auth/local");
  const { chatRouter } = await import("../routes/chat");
  const {
    chatDbRequestContext,
    ensureProjectRowInProjectDb,
    registerProjectFolder,
  } = await import("./projectRegistry");
  const {
    appDataPath,
    appDbPath,
    enterDatabaseContext,
    getAppDb,
    getDbForPath,
  } = await import("../db/sqlite");

  const userId = "viewer-chat-latency-user";
  const userEmail = "viewer-chat-latency@example.com";
  const projectRoot = fs.mkdtempSync(
    path.join(testRoot, "viewer-chat-project-"),
  );
  const project = registerProjectFolder({
    folderPath: projectRoot,
    userId,
    projectId: "viewer-chat-latency-project",
    name: "Viewer Chat Latency Project",
  });
  const projectCtx = ensureProjectRowInProjectDb(project);
  const projectDb = getDbForPath(projectCtx.dbPath);
  const insertProjectChat = projectDb.prepare(
    "INSERT INTO chats (id, project_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertProjectChat.run(
    "create",
    project.id,
    userId,
    "Static Route Collision Sentinel",
    "2026-07-10T10:00:00.000Z",
  );
  insertProjectChat.run(
    "viewer-chat-app-priority",
    project.id,
    userId,
    "Project DB Duplicate",
    "2026-07-10T10:01:00.000Z",
  );
  insertProjectChat.run(
    "viewer-chat-project-fallback",
    project.id,
    userId,
    "Project DB Fallback",
    "2026-07-10T10:02:00.000Z",
  );

  getAppDb()
    .prepare(
      "INSERT INTO chats (id, project_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "viewer-chat-app-priority",
      project.id,
      userId,
      "App DB Preferred",
      "2026-07-10T10:01:00.000Z",
    );

  const unavailableRoot = fs.mkdtempSync(
    path.join(testRoot, "viewer-chat-unavailable-"),
  );
  fs.mkdirSync(path.join(unavailableRoot, ".docket", "project.db"), {
    recursive: true,
  });
  getAppDb()
    .prepare(
      `INSERT INTO projects (
        id, user_id, name, path, status, last_opened_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'available', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(
      "viewer-chat-unavailable-project",
      userId,
      "Viewer Chat Unavailable Project",
      unavailableRoot,
      "9999-12-31T23:59:59.000Z",
    );

  const app = express();
  app.use(express.json());
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
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: `Bearer ${signLocalJwt(userId, userEmail)}`,
      "Content-Type": "application/json",
    };

    const createStartedAt = Date.now();
    const created = await requestJson<{ id: string }>(`${base}/chat/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project_id: project.id }),
    });
    const createElapsedMs = Date.now() - createStartedAt;
    assert.ok(
      createElapsedMs < 1_000,
      `chat creation should not scan project DBs, took ${createElapsedMs}ms`,
    );
    assert.ok(
      getAppDb().prepare("SELECT 1 FROM chats WHERE id = ?").get(created.id),
      "POST /chat/create should write to the app DB",
    );
    assert.equal(
      projectDb.prepare("SELECT 1 FROM chats WHERE id = ?").get(created.id),
      undefined,
      "the static create route must not inherit a project DB context",
    );

    const viewerFlowStartedAt = Date.now();
    const createdChat = await requestJson<{
      chat: { id: string; title: string | null };
    }>(`${base}/chat/${created.id}`, { headers });
    const viewerFlowElapsedMs = Date.now() - viewerFlowStartedAt;
    assert.equal(createdChat.chat.id, created.id);
    assert.ok(
      viewerFlowElapsedMs < 1_000,
      `viewer create-to-chat lookup should use the app DB, took ${viewerFlowElapsedMs}ms`,
    );

    const appPriorityStartedAt = Date.now();
    const appPriority = await requestJson<{
      chat: { id: string; title: string | null };
    }>(`${base}/chat/viewer-chat-app-priority`, { headers });
    const appPriorityElapsedMs = Date.now() - appPriorityStartedAt;
    assert.equal(appPriority.chat.title, "App DB Preferred");
    assert.ok(
      appPriorityElapsedMs < 1_000,
      `app DB chat lookup should not scan projects, took ${appPriorityElapsedMs}ms`,
    );

    const fallbackStartedAt = Date.now();
    const projectFallback = await requestJson<{
      chat: { id: string; title: string | null };
    }>(`${base}/chat/viewer-chat-project-fallback`, { headers });
    const fallbackElapsedMs = Date.now() - fallbackStartedAt;
    assert.equal(projectFallback.chat.title, "Project DB Fallback");
    assert.ok(
      fallbackElapsedMs < 1_000,
      `project fallback should skip unreadable DBs once, took ${fallbackElapsedMs}ms`,
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("project detail rejects inaccessible registered folders without SQLite retries", async () => {
  const { signLocalJwt } = await import("../auth/local");
  const { projectsRouter } = await import("../routes/projects");
  const { getAppDb } = await import("../db/sqlite");
  const userId = "inaccessible-project-user";
  const userEmail = "inaccessible-project@example.com";
  const projectId = "inaccessible-project-detail";
  const projectRoot = fs.mkdtempSync(
    path.join(testRoot, "inaccessible-project-root-"),
  );
  fs.mkdirSync(path.join(projectRoot, ".docket", "project.db"), {
    recursive: true,
  });
  getAppDb()
    .prepare(
      `INSERT INTO projects (
        id, user_id, name, path, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'available', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(projectId, userId, "Inaccessible Project", projectRoot);

  const app = express();
  app.use("/projects", projectsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const startedAt = Date.now();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/projects/${projectId}`,
      {
        headers: {
          Authorization: `Bearer ${signLocalJwt(userId, userEmail)}`,
        },
      },
    );
    const elapsedMs = Date.now() - startedAt;
    const body = (await response.json()) as { detail?: string };

    assert.equal(response.status, 503);
    assert.match(body.detail ?? "", /cannot be opened/i);
    assert.ok(
      elapsedMs < 1_000,
      `inaccessible project detail should fail fast, took ${elapsedMs}ms`,
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("project deletion unregisters a project whose local folder is gone", async () => {
  const { signLocalJwt } = await import("../auth/local");
  const { projectsRouter } = await import("../routes/projects");
  const { registerProjectFolder } = await import("./projectRegistry");
  const { getAppDb } = await import("../db/sqlite");
  const userId = "missing-folder-delete-user";
  const userEmail = "missing-folder-delete@example.com";
  const projectRoot = fs.mkdtempSync(
    path.join(testRoot, "missing-folder-delete-root-"),
  );
  const project = registerProjectFolder({
    folderPath: projectRoot,
    userId,
    name: "Missing Folder Project",
  });
  fs.rmSync(projectRoot, { recursive: true, force: true });

  const app = express();
  app.use("/projects", projectsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/projects/${project.id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${signLocalJwt(userId, userEmail)}`,
        },
      },
    );

    assert.equal(response.status, 204);
    assert.equal(
      getAppDb().prepare("SELECT 1 FROM projects WHERE id = ?").get(project.id),
      undefined,
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("project uploads copy files into the opened project folder root", async () => {
  const { createServerSupabase } = await import("./supabase");
  const { signLocalJwt } = await import("../auth/local");
  const { projectsRouter } = await import("../routes/projects");
  const { toStoredSourceFolderPath } = await import("./sourceFolderPaths");
  const { ensureProjectRowInProjectDb, registerProjectFolder } =
    await import("./projectRegistry");
  const { runWithDatabaseContext } = await import("../db/sqlite");
  const userId = "project-upload-user";
  const userEmail = "project-upload@example.com";
  const projectId = "project-folder-upload";
  const sourceFolderId = "source-folder-upload";
  const sourceRoot = fs.mkdtempSync(path.join(testRoot, "upload-root-"));

  const project = registerProjectFolder({
    folderPath: sourceRoot,
    userId,
    projectId,
    name: "Upload Root Project",
  });
  const ctx = ensureProjectRowInProjectDb(project);
  await runWithDatabaseContext(ctx, async () => {
    const projectDb = createServerSupabase();
    const rootPath = toStoredSourceFolderPath(sourceRoot);
    await projectDb.from("source_folders").insert({
      id: sourceFolderId,
      project_id: projectId,
      user_id: userId,
      root_path: rootPath,
      display_name: "upload-root",
    });
  });

  const app = express();
  app.use("/projects", projectsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const auth = {
      Authorization: `Bearer ${signLocalJwt(userId, userEmail)}`,
    };

    const form = new FormData();
    form.append(
      "file",
      new Blob([await samplePdfBytes("uploaded root file")], {
        type: "application/pdf",
      }),
      "uploaded.pdf",
    );
    const uploaded = await requestJson<{
      id: string;
      filename: string;
      storage_path: string;
    }>(`${base}/projects/${projectId}/documents`, {
      method: "POST",
      headers: auth,
      body: form,
    });

    assert.equal(uploaded.filename, "uploaded.pdf");
    assert.match(uploaded.storage_path, /^linked-source:/);
    assert.equal(fs.existsSync(path.join(sourceRoot, "uploaded.pdf")), true);
    assert.equal(
      fs.existsSync(
        path.join(appDataDir, "files", "documents", userId, uploaded.id),
      ),
      false,
      "project-folder uploads should not create an app-storage source copy",
    );

    const collisionForm = new FormData();
    collisionForm.append(
      "file",
      new Blob([await samplePdfBytes("uploaded duplicate root file")], {
        type: "application/pdf",
      }),
      "uploaded.pdf",
    );
    const duplicate = await requestJson<{
      filename: string;
      storage_path: string;
    }>(`${base}/projects/${projectId}/documents`, {
      method: "POST",
      headers: auth,
      body: collisionForm,
    });

    assert.equal(duplicate.filename, "uploaded (1).pdf");
    assert.match(duplicate.storage_path, /^linked-source:/);
    assert.equal(
      fs.existsSync(path.join(sourceRoot, "uploaded (1).pdf")),
      true,
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("document version uploads for project documents use the project database and storage root", async () => {
  const { signLocalJwt } = await import("../auth/local");
  const { documentsRouter } = await import("../routes/documents");
  const {
    documentDbRequestContext,
    ensureProjectRowInProjectDb,
    registerProjectFolder,
  } = await import("./projectRegistry");
  const { createServerSupabase } = await import("./supabase");
  const {
    appDataPath,
    appDbPath,
    enterDatabaseContext,
    projectDataDir,
    runWithDatabaseContext,
  } = await import("../db/sqlite");
  const { uploadFile } = await import("./storage");

  const userId = "project-version-user";
  const userEmail = "project-version@example.com";
  const projectRoot = fs.mkdtempSync(path.join(testRoot, "version-root-"));
  const project = registerProjectFolder({
    folderPath: projectRoot,
    userId,
    projectId: "project-version-root",
    name: "Version Root",
  });
  const ctx = ensureProjectRowInProjectDb(project);
  const documentId = "project-version-document";
  const versionOneId = "project-version-one";
  const originalKey =
    "documents/project-version-user/project-version-document/source.pdf";
  await runWithDatabaseContext(ctx, async () => {
    await uploadFile(
      originalKey,
      await samplePdfBytes("project version original"),
      "application/pdf",
    );
    const projectDb = createServerSupabase();
    await projectDb.from("documents").insert({
      id: documentId,
      project_id: project.id,
      user_id: userId,
      filename: "matter.pdf",
      file_type: "pdf",
      size_bytes: 100,
      status: "ready",
      current_version_id: versionOneId,
    });
    await projectDb.from("document_versions").insert({
      id: versionOneId,
      document_id: documentId,
      storage_path: originalKey,
      pdf_storage_path: originalKey,
      source: "upload",
      version_number: 1,
      display_name: "matter.pdf",
    });
  });

  const app = express();
  app.use((_req, _res, next) => {
    enterDatabaseContext({
      kind: "app",
      dbPath: appDbPath(),
      dataRoot: appDataPath(),
    });
    next();
  });
  app.use("/single-documents/:documentId", documentDbRequestContext);
  app.use("/single-documents", documentsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const form = new FormData();
    form.append(
      "file",
      new Blob([await samplePdfBytes("project version replacement")], {
        type: "application/pdf",
      }),
      "matter-v2.pdf",
    );

    const uploaded = await requestJson<{
      id: string;
      version_number: number;
      display_name: string;
    }>(`${base}/single-documents/${documentId}/versions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signLocalJwt(userId, userEmail)}`,
      },
      body: form,
    });

    assert.equal(uploaded.version_number, 2);
    assert.equal(uploaded.display_name, "matter-v2.pdf");
    await runWithDatabaseContext(ctx, async () => {
      const projectDb = createServerSupabase();
      const { data: version } = await projectDb
        .from("document_versions")
        .select("storage_path, pdf_storage_path, source, version_number")
        .eq("id", uploaded.id)
        .single();
      assert.equal(version?.source, "user_upload");
      assert.equal(version?.version_number, 2);
      assert.equal(version?.pdf_storage_path, version?.storage_path);
      assert.equal(
        fs.existsSync(
          path.join(
            projectDataDir(projectRoot),
            "files",
            version?.storage_path as string,
          ),
        ),
        true,
      );
    });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("project download tokens restore the project database and storage context", async () => {
  const { signLocalJwt } = await import("../auth/local");
  const { downloadsRouter } = await import("../routes/downloads");
  const { ensureProjectRowInProjectDb, registerProjectFolder } =
    await import("./projectRegistry");
  const { createServerSupabase } = await import("./supabase");
  const {
    appDataPath,
    appDbPath,
    enterDatabaseContext,
    runWithDatabaseContext,
  } = await import("../db/sqlite");
  const { signDownload } = await import("./downloadTokens");
  const { uploadFile } = await import("./storage");

  const userId = "project-download-user";
  const userEmail = "project-download@example.com";
  const projectRoot = fs.mkdtempSync(path.join(testRoot, "download-root-"));
  const project = registerProjectFolder({
    folderPath: projectRoot,
    userId,
    projectId: "project-download-root",
    name: "Download Root",
  });
  const ctx = ensureProjectRowInProjectDb(project);
  const documentId = "project-download-document";
  const versionId = "project-download-version";
  const storagePath =
    "documents/project-download-user/project-download-document/source.pdf";
  const expectedBytes = Buffer.from("project scoped download bytes", "utf8");
  const token = await runWithDatabaseContext(ctx, async () => {
    await uploadFile(
      storagePath,
      expectedBytes.buffer.slice(
        expectedBytes.byteOffset,
        expectedBytes.byteOffset + expectedBytes.byteLength,
      ) as ArrayBuffer,
      "application/pdf",
    );
    const projectDb = createServerSupabase();
    await projectDb.from("documents").insert({
      id: documentId,
      project_id: project.id,
      user_id: userId,
      filename: "download.pdf",
      file_type: "pdf",
      size_bytes: expectedBytes.byteLength,
      status: "ready",
      current_version_id: versionId,
    });
    await projectDb.from("document_versions").insert({
      id: versionId,
      document_id: documentId,
      storage_path: storagePath,
      pdf_storage_path: storagePath,
      source: "upload",
      version_number: 1,
      display_name: "download.pdf",
    });
    return signDownload(storagePath, "download.pdf");
  });

  const app = express();
  app.use((_req, _res, next) => {
    enterDatabaseContext({
      kind: "app",
      dbPath: appDbPath(),
      dataRoot: appDataPath(),
    });
    next();
  });
  app.use("/download", downloadsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/download/${token}`,
      {
        headers: {
          Authorization: `Bearer ${signLocalJwt(userId, userEmail)}`,
        },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(
      Buffer.from(await response.arrayBuffer()).toString("utf8"),
      expectedBytes.toString("utf8"),
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("user settings helpers read app profiles while running in a project context", async () => {
  const { ensureProjectRowInProjectDb, registerProjectFolder } =
    await import("./projectRegistry");
  const { getAppDb, runWithDatabaseContext } = await import("../db/sqlite");
  const { getUserApiKeys, getUserModelSettings, getUserRetrievalSettings } =
    await import("./userSettings");
  const { readUserEmbeddingSettings } = await import("./indexing/embeddings");

  const userId = "settings-project-user";
  const projectRoot = fs.mkdtempSync(path.join(testRoot, "settings-root-"));
  const project = registerProjectFolder({
    folderPath: projectRoot,
    userId,
    projectId: "settings-project-root",
    name: "Settings Root",
  });
  const ctx = ensureProjectRowInProjectDb(project);

  getAppDb()
    .prepare(
      `
      INSERT INTO user_profiles (
        id, user_id, tabular_model, claude_api_key, gemini_api_key,
        openai_api_key, openrouter_api_key, nvidia_api_key,
        openai_compatible_api_key, openai_compatible_base_url,
        chat_full_read_max_docs, chat_full_read_max_text_bytes,
        chat_fetch_max_docs, chat_fetch_max_text_bytes,
        embedding_provider, embedding_model, embedding_base_url,
        embedding_api_key, embedding_dimensions_policy, embedding_enabled,
        embedding_memory_profile
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      "settings-project-profile",
      userId,
      "claude-sonnet-4-5",
      "claude-profile-key",
      "gemini-profile-key",
      "openai-profile-key",
      "openrouter-profile-key",
      "nvidia-profile-key",
      "compatible-profile-key",
      "http://compatible.local/v1",
      7,
      12345,
      5,
      67890,
      "openai-compatible",
      "profile-embedding-model",
      "http://embeddings.local/v1",
      "embedding-profile-key",
      "truncate-to-512",
      1,
      "performance",
    );

  await runWithDatabaseContext(ctx, async () => {
    const apiKeys = await getUserApiKeys(userId);
    assert.equal(apiKeys.claude, "claude-profile-key");
    assert.equal(apiKeys.openaiCompatibleBaseUrl, "http://compatible.local/v1");

    const modelSettings = await getUserModelSettings(userId);
    assert.equal(modelSettings.tabular_model, "claude-sonnet-4-5");
    assert.equal(modelSettings.api_keys.gemini, "gemini-profile-key");

    const retrievalSettings = await getUserRetrievalSettings(userId);
    assert.equal(retrievalSettings.chat_full_read_max_docs, 7);
    assert.equal(retrievalSettings.chat_fetch_max_text_bytes, 67890);

    const embeddingSettings = readUserEmbeddingSettings(userId);
    assert.equal(embeddingSettings.provider, "openai-compatible");
    assert.equal(embeddingSettings.model, "profile-embedding-model");
    assert.equal(embeddingSettings.baseUrl, "http://embeddings.local/v1");
    assert.equal(embeddingSettings.apiKey, "embedding-profile-key");
    assert.equal(embeddingSettings.dimensionsPolicy, "truncate-to-512");
    assert.equal(embeddingSettings.memoryProfile, "performance");
  });
});

test("tabular review routes keep project reviews in the project database", async () => {
  const { createServerSupabase } = await import("./supabase");
  const { signLocalJwt } = await import("../auth/local");
  const { tabularRouter } = await import("../routes/tabular");
  const {
    ensureProjectRowInProjectDb,
    projectContextFor,
    projectDbRequestContext,
    registerProjectFolder,
  } = await import("./projectRegistry");
  const { getAppDb, runWithDatabaseContext } = await import("../db/sqlite");

  const userId = "tabular-project-user";
  const userEmail = "tabular-project@example.com";
  const projectRoot = fs.mkdtempSync(path.join(testRoot, "tabular-root-"));
  const project = registerProjectFolder({
    folderPath: projectRoot,
    userId,
    name: "Tabular Root",
  });
  ensureProjectRowInProjectDb(project);
  const sourceDocumentId = "tabular-source-document";
  await runWithDatabaseContext(projectContextFor(project), async () => {
    const projectDb = createServerSupabase();
    await projectDb.from("source_folders").insert({
      id: "tabular-root-source-folder",
      project_id: project.id,
      user_id: userId,
      root_path: "project:.",
      display_name: "Tabular Root",
    });
    await projectDb.from("documents").insert({
      id: sourceDocumentId,
      project_id: project.id,
      user_id: userId,
      filename: "review-source.pdf",
      file_type: "pdf",
      status: "ready",
    });
    await projectDb.from("linked_source_files").insert({
      id: "tabular-source-link",
      source_folder_id: "tabular-root-source-folder",
      document_id: sourceDocumentId,
      relative_path: "review-source.pdf",
      size_bytes: 1,
      mtime_ms: 1,
    });
  });

  const app = express();
  app.use(express.json());
  app.use(
    "/projects/:projectId/tabular-reviews",
    projectDbRequestContext,
    tabularRouter,
  );
  app.use("/tabular-review", (_req, res) => {
    res.status(410).json({ code: "global_tabular_review_removed" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const auth = {
      Authorization: `Bearer ${signLocalJwt(userId, userEmail)}`,
      "Content-Type": "application/json",
    };

    const invalidDocumentResponse = await fetch(
      `${base}/projects/${project.id}/tabular-reviews`,
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          title: "Invalid Table",
          document_ids: ["not-source-backed"],
          columns_config: [
            { index: 0, name: "Issue", prompt: "Extract issue" },
          ],
        }),
      },
    );
    assert.equal(invalidDocumentResponse.status, 400);

    const created = await requestJson<{
      id: string;
      project_id: string;
      title: string;
    }>(`${base}/projects/${project.id}/tabular-reviews`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        title: "Project Table",
        document_ids: [sourceDocumentId],
        columns_config: [{ index: 0, name: "Issue", prompt: "Extract issue" }],
      }),
    });

    assert.equal(created.project_id, project.id);
    assert.equal(
      (
        getAppDb()
          .prepare("SELECT COUNT(*) AS count FROM tabular_reviews WHERE id = ?")
          .get(created.id) as { count: number } | undefined
      )?.count,
      0,
      "project tabular reviews should not be copied into the app DB",
    );

    await runWithDatabaseContext(projectContextFor(project), async () => {
      const projectDb = createServerSupabase();
      const { data: reviews } = await projectDb
        .from("tabular_reviews")
        .select("id, title")
        .eq("id", created.id);
      assert.deepEqual(reviews, [{ id: created.id, title: "Project Table" }]);
      const { data: attachments } = await projectDb
        .from("tabular_review_documents")
        .select("document_id")
        .eq("review_id", created.id);
      assert.deepEqual(attachments, [{ document_id: sourceDocumentId }]);
    });

    const projectList = await requestJson<{ id: string }[]>(
      `${base}/projects/${project.id}/tabular-reviews`,
      { headers: { Authorization: auth.Authorization } },
    );
    assert.deepEqual(
      projectList.map((review) => review.id),
      [created.id],
    );

    const globalResponse = await fetch(`${base}/tabular-review`, {
      headers: { Authorization: auth.Authorization },
    });
    assert.equal(globalResponse.status, 410);

    const detail = await requestJson<{
      review: { id: string; project_id: string };
    }>(`${base}/projects/${project.id}/tabular-reviews/${created.id}`, {
      headers: { Authorization: auth.Authorization },
    });
    assert.equal(detail.review.id, created.id);
    assert.equal(detail.review.project_id, project.id);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

test("scanSourceFolder reconciles new, unchanged, changed, and missing linked files", async () => {
  const { createServerSupabase } = await import("./supabase");
  const { scanSourceFolder } = await import("./sourceFolders");
  const {
    displaySourceFolderPath,
    resolveStoredSourceFolderPath,
    toStoredSourceFolderPath,
  } = await import("./sourceFolderPaths");
  const { downloadFile, linkedSourceKey } = await import("./storage");

  const db = createServerSupabase();
  const userId = "owner-user";
  const projectId = "project-source-scan";
  const sourceFolderId = "source-folder-scan";
  const sourceRoot = fs.mkdtempSync(path.join(testRoot, "source-root-"));
  const sourceFile = path.join(sourceRoot, "contract.pdf");
  fs.writeFileSync(
    sourceFile,
    Buffer.from(await samplePdfBytes("original source")),
  );
  const outsideFile = path.join(testRoot, "outside-source.pdf");
  const escapedLink = path.join(sourceRoot, "escaped.pdf");
  fs.writeFileSync(
    outsideFile,
    Buffer.from(await samplePdfBytes("outside source")),
  );
  fs.symlinkSync(outsideFile, escapedLink);
  const storedSourceRoot = toStoredSourceFolderPath(sourceRoot);
  assert.equal(storedSourceRoot, fs.realpathSync(sourceRoot));
  assert.equal(
    resolveStoredSourceFolderPath(storedSourceRoot),
    fs.realpathSync(sourceRoot),
  );
  assert.equal(displaySourceFolderPath(storedSourceRoot), storedSourceRoot);

  await db.from("projects").insert({
    id: projectId,
    user_id: userId,
    name: "Scan Project",
    shared_with: [],
  });
  await db.from("source_folders").insert({
    id: sourceFolderId,
    project_id: projectId,
    user_id: userId,
    root_path: storedSourceRoot,
    display_name: "source-root",
  });

  const first = await scanSourceFolder({
    db,
    sourceFolderId,
    projectId,
    userId,
    rootPath: sourceRoot,
  });
  assert.equal(first.imported.length, 1);
  assert.equal(first.updated.length, 0);
  assert.deepEqual(first.unchanged, []);
  assert.deepEqual(first.skipped, ["escaped.pdf"]);

  const second = await scanSourceFolder({
    db,
    sourceFolderId,
    projectId,
    userId,
    rootPath: sourceRoot,
  });
  assert.equal(second.imported.length, 0);
  assert.equal(second.updated.length, 0);
  assert.deepEqual(second.unchanged, ["contract.pdf"]);

  fs.writeFileSync(
    sourceFile,
    Buffer.from(await samplePdfBytes("modified source")),
  );
  const third = await scanSourceFolder({
    db,
    sourceFolderId,
    projectId,
    userId,
    rootPath: sourceRoot,
  });
  assert.equal(third.imported.length, 0);
  assert.equal(third.updated.length, 1);

  const { data: linkedRows } = await db
    .from("linked_source_files")
    .select("document_id, relative_path")
    .eq("source_folder_id", sourceFolderId);
  assert.equal(linkedRows?.length, 1);
  const documentId = (linkedRows?.[0] as { document_id: string }).document_id;
  const linkedBytes = await downloadFile(
    linkedSourceKey(sourceFolderId, "contract.pdf"),
  );
  assert.ok(linkedBytes);
  assert.ok(linkedBytes.byteLength > 0);

  const { data: versions } = await db
    .from("document_versions")
    .select("id, document_id, version_number")
    .eq("document_id", documentId)
    .order("version_number", { ascending: true });
  assert.deepEqual(
    (versions ?? []).map(
      (v) => (v as { version_number: number }).version_number,
    ),
    [1, 2],
  );

  fs.unlinkSync(sourceFile);
  const fourth = await scanSourceFolder({
    db,
    sourceFolderId,
    projectId,
    userId,
    rootPath: sourceRoot,
  });
  assert.deepEqual(fourth.missing, ["contract.pdf"]);
});

test("PDF annotation routes keep metadata separate until explicit export", async () => {
  const { createServerSupabase } = await import("./supabase");
  const { uploadFile } = await import("./storage");
  const { signLocalJwt } = await import("../auth/local");
  const { documentsRouter } = await import("../routes/documents");

  const db = createServerSupabase();
  const ownerId = "annotation-owner";
  const ownerEmail = "owner@example.com";
  const collaboratorId = "annotation-collaborator";
  const collaboratorEmail = "collab@example.com";
  const projectId = "annotation-project";
  const documentId = "annotation-document";
  const versionOneId = "annotation-version-one";
  const versionTwoId = "annotation-version-two";
  const fileOneKey = "test-pdfs/annotation-v1.pdf";
  const fileTwoKey = "test-pdfs/annotation-v2.pdf";

  await uploadFile(
    fileOneKey,
    await samplePdfBytes("version one", {
      highlight: {
        contents: "embedded source highlight",
        rect: [250, 690, 410, 710],
      },
    }),
    "application/pdf",
  );
  await uploadFile(
    fileTwoKey,
    await samplePdfBytes("version two"),
    "application/pdf",
  );
  await db.from("projects").insert({
    id: projectId,
    user_id: ownerId,
    name: "Annotation Project",
    shared_with: [collaboratorEmail],
  });
  await db.from("documents").insert({
    id: documentId,
    project_id: projectId,
    user_id: ownerId,
    filename: "annotated.pdf",
    file_type: "pdf",
    size_bytes: 100,
    status: "ready",
    current_version_id: versionOneId,
  });
  await db.from("document_versions").insert([
    {
      id: versionOneId,
      document_id: documentId,
      storage_path: fileOneKey,
      pdf_storage_path: fileOneKey,
      source: "upload",
      version_number: 1,
      display_name: "annotated.pdf",
    },
    {
      id: versionTwoId,
      document_id: documentId,
      storage_path: fileTwoKey,
      pdf_storage_path: fileTwoKey,
      source: "user_upload",
      version_number: 2,
      display_name: "annotated v2.pdf",
    },
  ]);

  const app = express();
  app.use(express.json());
  app.use("/single-documents", documentsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const ownerAuth = {
      Authorization: `Bearer ${signLocalJwt(ownerId, ownerEmail)}`,
    };
    const collaboratorAuth = {
      Authorization: `Bearer ${signLocalJwt(collaboratorId, collaboratorEmail)}`,
    };

    const created = await requestJson<{
      id: string;
      version_id: string;
      user_id: string;
      source: string;
      source_citation: Record<string, unknown>;
      rects: {
        page: number;
        x: number;
        y: number;
        width: number;
        height: number;
      }[];
    }>(`${base}/single-documents/${documentId}/annotations`, {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        version_id: versionOneId,
        page_number: 1,
        annotation_type: "highlight",
        color: "#ffe066",
        quote: "version one",
        rects: [{ page: 1, x: 72, y: 690, width: 160, height: 20 }],
        source: "citation_promotion",
        source_citation: { ref: 1, document_id: documentId, page: 1 },
      }),
    });
    assert.equal(
      created.version_id,
      versionOneId,
      "saving an annotation should keep metadata on the active version until explicit export",
    );
    assert.equal(created.user_id, ownerId);
    assert.equal(created.source, "citation_promotion");
    assert.equal(created.source_citation.ref, 1);
    assert.equal(created.rects[0].x, 72);

    const versionOneRows = await requestJson<
      {
        id: string;
        source: string;
        quote: string | null;
      }[]
    >(
      `${base}/single-documents/${documentId}/annotations?version_id=${versionOneId}`,
      { headers: ownerAuth },
    );
    assert.equal(versionOneRows.length, 2);
    assert.ok(
      versionOneRows.some(
        (row) => row.id === created.id && row.source === "citation_promotion",
      ),
      "importing embedded source PDF annotations must preserve new metadata-only rows",
    );
    assert.ok(
      versionOneRows.some(
        (row) =>
          row.source === "user" && row.quote === "embedded source highlight",
      ),
      "source PDFs should still import embedded PDF annotations as separate metadata",
    );
    const importedEmbedded = versionOneRows.find(
      (row) =>
        row.source === "user" && row.quote === "embedded source highlight",
    );
    assert.ok(importedEmbedded);
    const deleteImported = await fetch(
      `${base}/single-documents/${documentId}/annotations/${importedEmbedded.id}`,
      {
        method: "DELETE",
        headers: ownerAuth,
      },
    );
    assert.equal(deleteImported.status, 204);
    const afterDeleteRows = await requestJson<
      {
        id: string;
        quote: string | null;
      }[]
    >(
      `${base}/single-documents/${documentId}/annotations?version_id=${versionOneId}`,
      { headers: ownerAuth },
    );
    assert.equal(afterDeleteRows.length, 1);
    assert.ok(
      afterDeleteRows.every((row) => row.quote !== "embedded source highlight"),
      "deleted embedded PDF annotations should stay hidden instead of being re-imported",
    );

    const comment = await requestJson<{
      id: string;
      annotation_type: string;
      comment: string;
      rects: {
        page: number;
        x: number;
        y: number;
        width: number;
        height: number;
      }[];
    }>(`${base}/single-documents/${documentId}/annotations`, {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        version_id: versionOneId,
        page_number: 1,
        annotation_type: "comment",
        color: "#74c0fc",
        quote: "version one",
        comment: "Review this clause",
        rects: [{ page: 1, x: 72, y: 650, width: 120, height: 18 }],
        source: "user",
      }),
    });
    assert.equal(comment.annotation_type, "comment");
    assert.equal(comment.comment, "Review this clause");
    assert.equal(comment.rects[0].y, 650);

    const versionTwoRows = await requestJson<unknown[]>(
      `${base}/single-documents/${documentId}/annotations?version_id=${versionTwoId}`,
      { headers: ownerAuth },
    );
    assert.equal(versionTwoRows.length, 0);

    const collaboratorListResponse = await fetch(
      `${base}/single-documents/${documentId}/annotations?version_id=${versionOneId}`,
      { headers: collaboratorAuth },
    );
    assert.equal(collaboratorListResponse.status, 404);

    const patchResponse = await fetch(
      `${base}/single-documents/${documentId}/annotations/${created.id}`,
      {
        method: "PATCH",
        headers: {
          ...collaboratorAuth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: "should not update owner row",
        }),
      },
    );
    assert.equal(patchResponse.status, 404);

    const exported = await requestJson<{
      id: string;
      source: string;
      version_number: number;
    }>(`${base}/single-documents/${documentId}/annotations/export-pdf`, {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: versionOneId }),
    });
    assert.equal(exported.source, "generated");
    assert.equal(exported.version_number, 3);
    const { data: currentDoc } = await db
      .from("documents")
      .select("current_version_id")
      .eq("id", documentId)
      .single();
    assert.equal(
      (currentDoc as { current_version_id: string }).current_version_id,
      versionOneId,
      "exporting annotations should not make the generated PDF the active document version",
    );
    const { data: metadataRows } = await db
      .from("pdf_annotations")
      .select("id, version_id, deleted_at")
      .eq("document_id", documentId)
      .eq("user_id", ownerId);
    const rowsById = new Map(
      (
        metadataRows as {
          id: string;
          version_id: string;
          deleted_at: string | null;
        }[]
      ).map((row) => [row.id, row]),
    );
    assert.equal(rowsById.get(created.id)?.version_id, versionOneId);
    assert.equal(rowsById.get(comment.id)?.version_id, versionOneId);
    assert.ok(
      rowsById.get(importedEmbedded.id)?.deleted_at,
      "deleted imported annotations should remain as tombstones for export filtering",
    );

    const { data: generated } = await db
      .from("document_versions")
      .select("storage_path, pdf_storage_path, source")
      .eq("id", exported.id)
      .single();
    assert.equal((generated as { source: string }).source, "generated");

    const { downloadFile } = await import("./storage");
    const exportedBytes = await downloadFile(
      (generated as { storage_path: string }).storage_path,
    );
    assert.ok(exportedBytes);
    const loaded = await PDFDocument.load(exportedBytes);
    assert.equal(loaded.getPageCount(), 1);
    const annots = loaded.getPage(0).node.Annots();
    assert.ok(annots, "exported PDF should contain annotation objects");
    const exportedAnnots = readPdfAnnotations(annots);
    assert.deepEqual(exportedAnnots.map((a) => a.subtype).sort(), [
      "/Highlight",
      "/Text",
    ]);
    assert.ok(
      exportedAnnots.some(
        (a) => a.subtype === "/Highlight" && a.contents.includes("version one"),
      ),
      "highlight annotation should preserve quote contents",
    );
    assert.ok(
      exportedAnnots.some(
        (a) =>
          a.subtype === "/Text" && a.contents.includes("Review this clause"),
      ),
      "comment annotation should preserve comment contents",
    );
    assert.ok(
      exportedAnnots.every((a) => a.name.startsWith("docket:")),
      "annotations should carry stable Docket ids for round-trip sync",
    );
    assert.ok(
      exportedAnnots.every(
        (a) => (a.flags & 256) === 0 && (a.flags & 512) === 0,
      ),
      "annotations should not be read-only or locked in external PDF readers",
    );
    const generatedRows = await requestJson<unknown[]>(
      `${base}/single-documents/${documentId}/annotations?version_id=${exported.id}`,
      {
        headers: ownerAuth,
      },
    );
    assert.equal(
      generatedRows.length,
      0,
      "generated export PDFs should not sync embedded annotations back into app metadata",
    );
    const refreshResponse = await fetch(
      `${base}/single-documents/${documentId}/annotations/export-pdf`,
      {
        method: "POST",
        headers: { ...ownerAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ version_id: exported.id }),
      },
    );
    assert.equal(
      refreshResponse.status,
      400,
      "export artifacts are immutable downloads, not in-place refreshed annotation state",
    );
    const ownerUpdate = await fetch(
      `${base}/single-documents/${documentId}/annotations/${created.id}`,
      {
        method: "PATCH",
        headers: { ...ownerAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ comment: "Changed after export" }),
      },
    );
    assert.equal(ownerUpdate.status, 200);

    const secondExport = await requestJson<{
      id: string;
      source: string;
      version_number: number;
    }>(`${base}/single-documents/${documentId}/annotations/export-pdf`, {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: versionOneId }),
    });
    assert.notEqual(secondExport.id, exported.id);
    assert.equal(
      secondExport.version_number,
      4,
      "only explicit Export PDF should create the next generated PDF version",
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
});

async function samplePdfBytes(
  text: string,
  options?: {
    highlight?: {
      contents: string;
      rect: [number, number, number, number];
    };
  },
): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawText(text, { x: 72, y: 700, size: 12 });
  if (options?.highlight) {
    const [x1, y1, x2, y2] = options.highlight.rect;
    const annots = PDFArray.withContext(pdf.context);
    const highlight = pdf.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Highlight"),
      Rect: options.highlight.rect,
      C: [1, 0.8, 0],
      Contents: PDFHexString.fromText(options.highlight.contents),
      QuadPoints: [x1, y2, x2, y2, x1, y1, x2, y1],
      F: 4,
    });
    annots.push(pdf.context.register(highlight));
    page.node.set(PDFName.of("Annots"), annots);
  }
  const bytes = await pdf.save();
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function readPdfAnnotations(
  annots: PDFArray,
): { subtype: string; contents: string; name: string; flags: number }[] {
  const rows: {
    subtype: string;
    contents: string;
    name: string;
    flags: number;
  }[] = [];
  for (let i = 0; i < annots.size(); i += 1) {
    const annot = annots.lookup(i, PDFDict);
    const subtype = annot.lookup(PDFName.of("Subtype"), PDFName).asString();
    const contents = annot.lookupMaybe(
      PDFName.of("Contents"),
      PDFString,
      PDFHexString,
    );
    const name = annot.lookupMaybe(PDFName.of("NM"), PDFString, PDFHexString);
    const flags = annot.lookupMaybe(PDFName.of("F"), PDFNumber);
    rows.push({
      subtype,
      contents: contents?.decodeText() ?? "",
      name: name?.decodeText() ?? "",
      flags: flags?.asNumber() ?? 0,
    });
  }
  return rows;
}
