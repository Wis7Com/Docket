import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "../db/sqlite";
import { runMigrations } from "../db/migrate";
import { createServerSupabase } from "./supabase";
import { runLLMStream } from "./chatTools";

const documentId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
let testRoot = "";
let previousAppDataPath: string | undefined;
let previousWorkspacePath: string | undefined;

before(() => {
    previousAppDataPath = process.env.APP_DATA_PATH;
    previousWorkspacePath = process.env.WORKSPACE_PATH;
    testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "docket-chat-abort-test-"),
    );
    closeDb();
    process.env.APP_DATA_PATH = path.join(testRoot, "app-data");
    delete process.env.WORKSPACE_PATH;
    runMigrations();

    const db = getDb();
    db.prepare(
        "INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)",
    ).run("project-1", "user-1", "Abort test");
    db.prepare(
        `INSERT INTO documents
         (id, project_id, user_id, filename, file_type, page_count, status, current_version_id)
         VALUES (?, ?, ?, ?, 'pdf', 1, 'ready', ?)`,
    ).run(documentId, "project-1", "user-1", "contract.pdf", versionId);
    db.prepare(
        `INSERT INTO document_versions
         (id, document_id, storage_path, source, version_number)
         VALUES (?, ?, ?, 'upload', 1)`,
    ).run(versionId, documentId, "documents/contract.pdf");
    db.prepare(
        `INSERT INTO document_index_files
         (id, document_id, version_id, status, chunk_count, text_bytes)
         VALUES (?, ?, ?, 'ready', 1, 25)`,
    ).run("index-1", documentId, versionId);
    db.prepare(
        `INSERT INTO document_index_chunks
         (id, document_id, version_id, chunk_index, page_number, content, start_char, end_char, token_count)
         VALUES (?, ?, ?, 0, 1, ?, 0, 25, 5)`,
    ).run("chunk-1", documentId, versionId, "Material contract language.");
});

after(() => {
    closeDb();
    if (previousAppDataPath === undefined) delete process.env.APP_DATA_PATH;
    else process.env.APP_DATA_PATH = previousAppDataPath;
    if (previousWorkspacePath === undefined) delete process.env.WORKSPACE_PATH;
    else process.env.WORKSPACE_PATH = previousWorkspacePath;
    fs.rmSync(testRoot, { recursive: true, force: true });
});

test("runLLMStream forwards an aborted signal through whole-document summarization", async () => {
    const reason = new Error("client disconnected");
    const signal = AbortSignal.abort(reason);
    const writes: string[] = [];

    await assert.rejects(
        runLLMStream({
            apiMessages: [
                {
                    role: "user",
                    content: `Summarize this document\n\ndisplayed_doc: contract.pdf, displayed_doc_id: ${documentId}`,
                },
            ],
            docStore: new Map(),
            docIndex: {
                "doc-0": {
                    document_id: documentId,
                    version_id: versionId,
                    filename: "contract.pdf",
                },
            },
            userId: "user-1",
            db: createServerSupabase(),
            write: (event) => writes.push(event),
            model: "ollama:test-model",
            signal,
        }),
        reason,
    );

    assert.match(writes.join(""), /"name":"summarize_document"/);
    assert.match(writes.join(""), /"type":"doc_summary_start"/);
});

test("runLLMStream forwards an aborted signal through main-chat streaming", async () => {
    const oldFetch = globalThis.fetch;
    const controller = new AbortController();
    let fetchCalls = 0;
    controller.abort();

    try {
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            throw new Error("fetch should not run");
        }) as typeof fetch;

        await assert.rejects(
            runLLMStream({
                apiMessages: [{ role: "user", content: "Hello" }],
                docStore: new Map(),
                docIndex: {},
                userId: "user-1",
                db: createServerSupabase(),
                write: () => undefined,
                model: "ollama:test-model",
                signal: controller.signal,
            }),
            (error: unknown) =>
                error instanceof DOMException && error.name === "AbortError",
        );
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = oldFetch;
    }
});
