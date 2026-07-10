import crypto from "crypto";
import * as fs from "fs";
import {
  getCurrentDatabaseContext,
  getDb,
  runWithDatabaseContext,
  type DatabaseContext,
} from "../../db/sqlite";
import { createServerSupabase } from "../supabase";
import { extractDocumentForIndex } from "./extractors";
import {
  contentHash,
  embedDocumentText,
  embedDocumentTexts,
  expectedDimensionsForSettings,
  readUserEmbeddingSettings,
  vectorToBlob,
  type EmbeddingSettings,
} from "./embeddings";

type QueueJob = {
  documentId: string;
  versionId: string | null;
  context: DatabaseContext;
};

type EmbeddingQueueJob = {
  vectorId: string;
  context: DatabaseContext;
};

const queue: QueueJob[] = [];
const queuedKeys = new Set<string>();
const activeKeys = new Set<string>();
const rerunKeys = new Set<string>();
let processing = false;
let drainWaiters: (() => void)[] = [];

export const BASELINE_INDEX_SCHEMA_VERSION = 2;

const EMBEDDING_BATCH_SIZE = 16;
const embeddingQueue: EmbeddingQueueJob[] = [];
const queuedEmbeddingIds = new Set<string>();
const pausedSemanticProjectIds = new Set<string>();
let embeddingProcessing = false;
let embeddingPauseCount = 0;

export function deterministicChunkId(args: {
  documentId: string;
  versionId: string;
  chunkIndex: number;
  content: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(args.documentId)
    .update("\0")
    .update(args.versionId)
    .update("\0")
    .update(String(args.chunkIndex))
    .update("\0")
    .update(args.content)
    .digest("hex");
}

function jobKey(documentId: string, versionId: string | null): string {
  const ctx = getCurrentDatabaseContext();
  return `${ctx.dbPath}:${documentId}:${versionId ?? "current"}`;
}

function scheduleQueue(): void {
  setImmediate(() => {
    void processQueue();
  });
}

function notifyDrainIfIdle(): void {
  if (processing || queue.length > 0) return;
  const waiters = drainWaiters;
  drainWaiters = [];
  for (const resolve of waiters) resolve();
}

function ensureIndexFileRow(documentId: string, versionId: string): void {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO document_index_files (
      id, document_id, version_id, status, error_message, updated_at
    )
    VALUES (?, ?, ?, 'pending', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(document_id, version_id) DO UPDATE SET
      status = CASE
        WHEN document_index_files.status = 'ready' THEN 'ready'
        ELSE 'pending'
      END,
      error_message = NULL,
      updated_at = CURRENT_TIMESTAMP
  `,
  ).run(crypto.randomUUID(), documentId, versionId);
}

function markIndexStatus(args: {
  documentId: string;
  versionId: string;
  status: "indexing" | "ready" | "error" | "cancelled";
  errorMessage?: string | null;
  chunkCount?: number;
  textBytes?: number;
  indexedContentRevision?: number;
  indexSchemaVersion?: number;
}): void {
  getDb()
    .prepare(
      `
      UPDATE document_index_files
      SET status = ?,
          error_message = ?,
          chunk_count = COALESCE(?, chunk_count),
          text_bytes = COALESCE(?, text_bytes),
          indexed_content_revision = COALESCE(?, indexed_content_revision),
          index_schema_version = COALESCE(?, index_schema_version),
          indexed_at = CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP ELSE indexed_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE document_id = ? AND version_id = ?
    `,
    )
    .run(
      args.status,
      args.errorMessage ?? null,
      args.chunkCount ?? null,
      args.textBytes ?? null,
      args.indexedContentRevision ?? null,
      args.indexSchemaVersion ?? null,
      args.status,
      args.documentId,
      args.versionId,
    );
}

function documentVersionContentRevision(
  documentId: string,
  versionId: string,
): number {
  const row = getDb()
    .prepare(
      `
      SELECT content_revision
      FROM document_versions
      WHERE id = ? AND document_id = ?
    `,
    )
    .get(versionId, documentId) as { content_revision: number } | undefined;
  return row?.content_revision ?? 1;
}

function markIndexFailure(args: {
  documentId: string;
  versionId: string;
  errorMessage: string;
}): void {
  const db = getDb();
  const prior = db
    .prepare(
      `
      SELECT EXISTS(
               SELECT 1 FROM document_index_chunks c
               WHERE c.document_id = f.document_id
                 AND c.version_id = f.version_id
             ) AS has_chunks
      FROM document_index_files f
      WHERE f.document_id = ? AND f.version_id = ?
    `,
    )
    .get(args.documentId, args.versionId) as { has_chunks: number } | undefined;
  const preserveReady = Boolean(prior?.has_chunks);
  db.prepare(
    `
    UPDATE document_index_files
    SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
    WHERE document_id = ? AND version_id = ?
  `,
  ).run(
    preserveReady ? "ready" : "error",
    args.errorMessage,
    args.documentId,
    args.versionId,
  );
}

function documentVersionExists(documentId: string, versionId: string): boolean {
  const row = getDb()
    .prepare(
      `
      SELECT v.id
      FROM document_versions v
      JOIN documents d ON d.id = v.document_id
      WHERE d.id = ? AND v.id = ?
    `,
    )
    .get(documentId, versionId);
  return !!row;
}

export async function indexDocumentVersion(args: {
  documentId: string;
  versionId?: string | null;
}): Promise<void> {
  const dbShim = createServerSupabase();
  const requestedRevision = args.versionId
    ? documentVersionContentRevision(args.documentId, args.versionId)
    : null;
  const extracted = await extractDocumentForIndex({
    db: dbShim,
    documentId: args.documentId,
    versionId: args.versionId,
  });
  const extractedRevision =
    requestedRevision ??
    documentVersionContentRevision(extracted.document_id, extracted.version_id);
  if (
    documentVersionContentRevision(
      extracted.document_id,
      extracted.version_id,
    ) !== extractedRevision
  ) {
    throw new Error("Document content changed during indexing");
  }

  ensureIndexFileRow(extracted.document_id, extracted.version_id);
  markIndexStatus({
    documentId: extracted.document_id,
    versionId: extracted.version_id,
    status: "indexing",
  });

  const db = getDb();
  let insertedChunkIds: string[] = [];
  const replaceChunks = db.transaction(() => {
    if (!documentVersionExists(extracted.document_id, extracted.version_id)) {
      return;
    }
    db.prepare(
      "DELETE FROM document_index_chunks_fts WHERE document_id = ? AND version_id = ?",
    ).run(extracted.document_id, extracted.version_id);
    db.prepare(
      "DELETE FROM document_index_chunks_fts_trigram WHERE document_id = ? AND version_id = ?",
    ).run(extracted.document_id, extracted.version_id);
    db.prepare(
      "DELETE FROM document_index_chunks WHERE document_id = ? AND version_id = ?",
    ).run(extracted.document_id, extracted.version_id);

    const insertChunk = db.prepare(
      `
      INSERT INTO document_index_chunks (
        id, document_id, version_id, chunk_index, page_number, section_path,
        content, start_char, end_char, token_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    const insertFts = db.prepare(
      `
      INSERT INTO document_index_chunks_fts (
        chunk_id, document_id, version_id, content
      )
      VALUES (?, ?, ?, ?)
    `,
    );
    const insertTrigramFts = db.prepare(
      `
      INSERT INTO document_index_chunks_fts_trigram (
        chunk_id, document_id, version_id, content
      )
      VALUES (?, ?, ?, ?)
    `,
    );

    insertedChunkIds = [];
    for (const chunk of extracted.chunks) {
      // Citation references need to survive a no-op re-index of the same
      // document version. A random UUID made an otherwise identical chunk
      // impossible to resolve after re-indexing.
      const chunkId = deterministicChunkId({
        documentId: extracted.document_id,
        versionId: extracted.version_id,
        chunkIndex: chunk.chunk_index,
        content: chunk.content,
      });
      insertedChunkIds.push(chunkId);
      insertChunk.run(
        chunkId,
        extracted.document_id,
        extracted.version_id,
        chunk.chunk_index,
        chunk.page_number,
        chunk.section_path,
        chunk.content,
        chunk.start_char,
        chunk.end_char,
        chunk.token_count,
      );
      insertFts.run(
        chunkId,
        extracted.document_id,
        extracted.version_id,
        chunk.search_text,
      );
      insertTrigramFts.run(
        chunkId,
        extracted.document_id,
        extracted.version_id,
        chunk.search_text,
      );
    }

    markIndexStatus({
      documentId: extracted.document_id,
      versionId: extracted.version_id,
      status: "ready",
      chunkCount: extracted.chunks.length,
      textBytes: Buffer.byteLength(extracted.text, "utf8"),
      indexedContentRevision: extractedRevision,
      indexSchemaVersion: BASELINE_INDEX_SCHEMA_VERSION,
    });
  });
  replaceChunks();
}

export function enqueueDocumentIndex(
  documentId: string,
  versionId?: string | null,
  options?: { rerunIfActive?: boolean },
): boolean {
  const key = jobKey(documentId, versionId ?? null);
  if (queuedKeys.has(key)) {
    if (options?.rerunIfActive && activeKeys.has(key)) rerunKeys.add(key);
    return false;
  }

  if (versionId) ensureIndexFileRow(documentId, versionId);

  queue.push({
    documentId,
    versionId: versionId ?? null,
    context: getCurrentDatabaseContext(),
  });
  queuedKeys.add(key);
  scheduleQueue();
  return true;
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) continue;
      const key = `${job.context.dbPath}:${job.documentId}:${job.versionId ?? "current"}`;
      activeKeys.add(key);

      try {
        await runWithDatabaseContext(job.context, () =>
          indexDocumentVersion(job),
        );
      } catch (err) {
        await runWithDatabaseContext(job.context, async () => {
          const dbShim = createServerSupabase();
          const { data: doc } = await dbShim
            .from("documents")
            .select("current_version_id")
            .eq("id", job.documentId)
            .single();
          const versionId =
            job.versionId ||
            ((doc as { current_version_id?: string | null } | null)
              ?.current_version_id ??
              null);
          if (versionId && documentVersionExists(job.documentId, versionId)) {
            ensureIndexFileRow(job.documentId, versionId);
            markIndexFailure({
              documentId: job.documentId,
              versionId,
              errorMessage: (err as Error).message || "Indexing failed",
            });
          }
        });
      } finally {
        activeKeys.delete(key);
        queuedKeys.delete(key);
        if (rerunKeys.delete(key)) {
          queue.push(job);
          queuedKeys.add(key);
        }
      }
    }
  } finally {
    processing = false;
    notifyDrainIfIdle();
  }
}

export type BaselineIndexWorkReason =
  | "missing"
  | "interrupted"
  | "stale-content"
  | "stale-schema";

export type BaselineIndexWorkItem = {
  documentId: string;
  versionId: string;
  reason: BaselineIndexWorkReason;
};

export function listProjectBaselineIndexWork(
  projectId: string,
): BaselineIndexWorkItem[] {
  const rows = getDb()
    .prepare(
      `
      SELECT d.id AS document_id,
             d.current_version_id AS version_id,
             v.content_revision,
             f.status,
             f.indexed_content_revision,
             f.index_schema_version
      FROM documents d
      JOIN document_versions v ON v.id = d.current_version_id
      LEFT JOIN document_index_files f
        ON f.document_id = d.id AND f.version_id = d.current_version_id
      WHERE d.project_id = ?
        AND d.status = 'ready'
        AND d.current_version_id IS NOT NULL
      ORDER BY d.created_at ASC
    `,
    )
    .all(projectId) as {
    document_id: string;
    version_id: string;
    content_revision: number;
    status: string | null;
    indexed_content_revision: number | null;
    index_schema_version: number | null;
  }[];

  const work: BaselineIndexWorkItem[] = [];
  for (const row of rows) {
    let reason: BaselineIndexWorkReason | null = null;
    if (!row.status) reason = "missing";
    else if (row.status === "pending" || row.status === "indexing") {
      reason = "interrupted";
    } else if (row.status === "ready") {
      if ((row.indexed_content_revision ?? 0) !== row.content_revision) {
        reason = "stale-content";
      } else if (
        (row.index_schema_version ?? 0) !== BASELINE_INDEX_SCHEMA_VERSION
      ) {
        reason = "stale-schema";
      }
    }
    if (reason) {
      work.push({
        documentId: row.document_id,
        versionId: row.version_id,
        reason,
      });
    }
  }
  return work;
}

export function ensureProjectBaselineCurrent(projectId: string): number {
  let enqueued = 0;
  for (const item of listProjectBaselineIndexWork(projectId)) {
    if (enqueueDocumentIndex(item.documentId, item.versionId)) enqueued += 1;
  }
  return enqueued;
}

export function bumpDocumentVersionContentRevision(
  documentId: string,
  versionId: string,
): number {
  const result = getDb()
    .prepare(
      `
      UPDATE document_versions
      SET content_revision = content_revision + 1
      WHERE id = ? AND document_id = ?
      RETURNING content_revision
    `,
    )
    .get(versionId, documentId) as { content_revision: number } | undefined;
  if (!result) throw new Error("Document version not found");
  return result.content_revision;
}

export async function enqueueProjectIndexRebuild(
  projectId: string,
): Promise<number> {
  const db = createServerSupabase();
  const { data: docs } = await db
    .from("documents")
    .select("id, current_version_id")
    .eq("project_id", projectId)
    .eq("status", "ready");

  clearProjectEmbeddings(projectId);

  let count = 0;
  for (const doc of (docs ?? []) as {
    id: string;
    current_version_id?: string | null;
  }[]) {
    if (!doc.current_version_id) continue;
    ensureIndexFileRow(doc.id, doc.current_version_id);
    enqueueDocumentIndex(doc.id, doc.current_version_id);
    count += 1;
  }
  return count;
}

export function clearProjectEmbeddings(projectId: string): {
  deleted_embeddings: number;
  cancelled_jobs: number;
} {
  const db = getDb();
  const context = getCurrentDatabaseContext();
  const vectorRows = db
    .prepare(
      `
      SELECT v.id
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE d.project_id = ?
    `,
    )
    .all(projectId) as { id: string }[];
  const vectorIds = new Set(vectorRows.map((row) => row.id));

  let cancelledJobs = 0;
  for (let i = embeddingQueue.length - 1; i >= 0; i -= 1) {
    const job = embeddingQueue[i];
    if (job.context.dbPath !== context.dbPath || !vectorIds.has(job.vectorId)) {
      continue;
    }
    queuedEmbeddingIds.delete(`${job.context.dbPath}:${job.vectorId}`);
    embeddingQueue.splice(i, 1);
    cancelledJobs += 1;
  }

  const result = db
    .prepare(
      `
      DELETE FROM document_index_vectors
      WHERE chunk_id IN (
        SELECT c.id
        FROM document_index_chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.project_id = ?
      )
    `,
    )
    .run(projectId);
  pausedSemanticProjectIds.add(projectId);

  return {
    deleted_embeddings: result.changes,
    cancelled_jobs: cancelledJobs,
  };
}

function projectHasIndexingWork(projectId: string): boolean {
  const context = getCurrentDatabaseContext();
  const projectDocIds = docIdsForProject(projectId);
  if (
    queue.some(
      (job) =>
        job.context.dbPath === context.dbPath &&
        projectDocIds.has(job.documentId),
    )
  ) {
    return true;
  }
  for (const documentId of projectDocIds) {
    const prefix = `${context.dbPath}:${documentId}:`;
    if ([...activeKeys].some((key) => key.startsWith(prefix))) return true;
  }
  return false;
}

export function compactProjectDatabase(projectId: string): {
  before_bytes: number;
  after_bytes: number;
  reclaimed_bytes: number;
  free_pages_before: number;
} {
  const db = getDb();
  const context = getCurrentDatabaseContext();
  const activeEmbedding = db
    .prepare(
      `
      SELECT 1
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE d.project_id = ? AND v.status = 'embedding'
      LIMIT 1
    `,
    )
    .get(projectId);

  if (
    projectHasIndexingWork(projectId) ||
    queuedEmbeddingCountForProject(projectId) > 0 ||
    activeEmbedding
  ) {
    throw new Error(
      "Wait for indexing and embedding work to finish before compacting the database",
    );
  }
  if (db.inTransaction) {
    throw new Error("Cannot compact the database during an active transaction");
  }

  const beforeBytes = fs.existsSync(context.dbPath)
    ? fs.statSync(context.dbPath).size
    : 0;
  const freePagesBefore = db.pragma("freelist_count", {
    simple: true,
  }) as number;
  db.exec("VACUUM");
  const afterBytes = fs.existsSync(context.dbPath)
    ? fs.statSync(context.dbPath).size
    : 0;

  return {
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
    reclaimed_bytes: Math.max(0, beforeBytes - afterBytes),
    free_pages_before: freePagesBefore,
  };
}

export function cancelProjectIndexing(projectId: string): number {
  const db = getDb();
  const projectDocs = db
    .prepare("SELECT id FROM documents WHERE project_id = ?")
    .all(projectId) as { id: string }[];
  const docIds = new Set(projectDocs.map((row) => row.id));

  let removed = 0;
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (!docIds.has(queue[i].documentId)) continue;
    queuedKeys.delete(
      `${queue[i].context.dbPath}:${queue[i].documentId}:${queue[i].versionId ?? "current"}`,
    );
    queue.splice(i, 1);
    removed += 1;
  }

  db.prepare(
    `
    UPDATE document_index_files
    SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE document_id IN (SELECT id FROM documents WHERE project_id = ?)
      AND status IN ('pending', 'indexing')
  `,
  ).run(projectId);

  notifyDrainIfIdle();
  return removed;
}

export function getProjectIndexStatus(projectId: string): {
  project_id: string;
  total_documents: number;
  queued_jobs: number;
  status_counts: Record<string, number>;
  text_bytes: number;
  chunk_count: number;
  last_indexed_at: string | null;
} {
  const db = getDb();
  const totalRow = db
    .prepare("SELECT COUNT(*) AS count FROM documents WHERE project_id = ?")
    .get(projectId) as { count: number };
  const rows = db
    .prepare(
      `
      SELECT f.status, COUNT(*) AS count, SUM(f.text_bytes) AS text_bytes,
             SUM(f.chunk_count) AS chunk_count, MAX(f.indexed_at) AS last_indexed_at
      FROM document_index_files f
      JOIN documents d ON d.id = f.document_id
      WHERE d.project_id = ?
        AND d.current_version_id = f.version_id
      GROUP BY f.status
    `,
    )
    .all(projectId) as {
    status: string;
    count: number;
    text_bytes: number | null;
    chunk_count: number | null;
    last_indexed_at: string | null;
  }[];

  const statusCounts: Record<string, number> = {};
  let textBytes = 0;
  let chunkCount = 0;
  let lastIndexedAt: string | null = null;
  for (const row of rows) {
    statusCounts[row.status] = row.count;
    textBytes += row.text_bytes ?? 0;
    chunkCount += row.chunk_count ?? 0;
    if (
      row.last_indexed_at &&
      (!lastIndexedAt || row.last_indexed_at > lastIndexedAt)
    ) {
      lastIndexedAt = row.last_indexed_at;
    }
  }

  const projectDocIds = docIdsForProject(projectId);

  return {
    project_id: projectId,
    total_documents: totalRow.count,
    queued_jobs: queue.filter((job) => projectDocIds.has(job.documentId))
      .length,
    status_counts: statusCounts,
    text_bytes: textBytes,
    chunk_count: chunkCount,
    last_indexed_at: lastIndexedAt,
  };
}

function enqueueEmbeddingVector(vectorId: string): void {
  const context = getCurrentDatabaseContext();
  const key = `${context.dbPath}:${vectorId}`;
  if (queuedEmbeddingIds.has(key)) return;
  embeddingQueue.push({ vectorId, context });
  queuedEmbeddingIds.add(key);
  setImmediate(() => {
    void processEmbeddingQueue();
  });
}

function vectorProjectId(vectorId: string): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT d.project_id
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE v.id = ?
    `,
    )
    .get(vectorId) as { project_id: string | null } | undefined;
  return row?.project_id ?? null;
}

function queuedEmbeddingCountForProject(projectId: string): number {
  const vectorIds = embeddingQueue.map((job) => job.vectorId);
  if (vectorIds.length === 0) return 0;
  const marks = vectorIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `
      SELECT v.id
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE d.project_id = ? AND v.id IN (${marks})
    `,
    )
    .all(projectId, ...vectorIds) as { id: string }[];
  const queuedProjectVectorIds = new Set(rows.map((row) => row.id));
  return embeddingQueue.filter((job) =>
    queuedProjectVectorIds.has(job.vectorId),
  ).length;
}

export function enqueueChunkEmbeddings(args: {
  userId?: string | null;
  chunkIds: string[];
}): number {
  const settings = readUserEmbeddingSettings(args.userId);
  if (!settings.enabled || args.chunkIds.length === 0) return 0;

  const db = getDb();
  const dimensions = expectedDimensionsForSettings(settings);
  const rows = db.prepare(
    `
      SELECT id, content
      FROM document_index_chunks
      WHERE id = ?
    `,
  );
  const existing = db.prepare(
    `
    SELECT id, chunk_content_hash, status
    FROM document_index_vectors
    WHERE chunk_id = ?
      AND provider = ?
      AND model_id = ?
      AND (? = 0 OR dimensions = ?)
    ORDER BY status = 'ready' DESC, updated_at DESC
    LIMIT 1
  `,
  );
  const insert = db.prepare(
    `
    INSERT INTO document_index_vectors (
      id, chunk_id, chunk_content_hash, provider, model_id, model, dimensions,
      normalized, embedding_blob, embedding_json, status, error_message,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]', 'pending', NULL, CURRENT_TIMESTAMP)
  `,
  );
  const update = db.prepare(
    `
    UPDATE document_index_vectors
    SET chunk_content_hash = ?,
        normalized = 0,
        embedding_blob = NULL,
        status = 'pending',
        error_message = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  );

  let enqueued = 0;
  for (const chunkId of args.chunkIds) {
    const chunk = rows.get(chunkId) as
      | { id: string; content: string }
      | undefined;
    if (!chunk) continue;
    const hash = contentHash(chunk.content);
    const row = existing.get(
      chunkId,
      settings.provider,
      settings.model,
      dimensions,
      dimensions,
    ) as
      | { id: string; chunk_content_hash: string | null; status: string }
      | undefined;
    const vectorId = row?.id ?? crypto.randomUUID();
    if (row?.chunk_content_hash === hash) {
      if (row.status === "ready") continue;
      if (row.status === "pending" || row.status === "embedding") {
        enqueueEmbeddingVector(vectorId);
        enqueued += 1;
        continue;
      }
    }
    if (row) {
      update.run(hash, vectorId);
    } else {
      insert.run(
        vectorId,
        chunkId,
        hash,
        settings.provider,
        settings.model,
        settings.model,
        dimensions,
      );
    }
    enqueueEmbeddingVector(vectorId);
    enqueued += 1;
  }
  return enqueued;
}

export function ensureProjectSemanticIndexQueued(
  projectId: string,
  userId?: string | null,
): number {
  const settings = readUserEmbeddingSettings(userId);
  if (!settings.enabled) return 0;
  const rows = getDb()
    .prepare(
      `
      SELECT c.id
      FROM document_index_chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN document_index_files f
        ON f.document_id = c.document_id
       AND f.version_id = c.version_id
       AND f.status = 'ready'
      WHERE d.project_id = ?
        AND d.current_version_id = c.version_id
      ORDER BY d.updated_at DESC, c.chunk_index ASC
    `,
    )
    .all(projectId) as { id: string }[];
  return enqueueChunkEmbeddings({
    userId,
    chunkIds: rows.map((row) => row.id),
  });
}

async function processEmbeddingQueue(): Promise<void> {
  if (embeddingProcessing) return;
  if (embeddingPauseCount > 0) return;
  embeddingProcessing = true;
  const deferred: EmbeddingQueueJob[] = [];

  try {
    while (embeddingQueue.length > 0) {
      if (embeddingPauseCount > 0) break;
      // Batch consecutive jobs that target the same project DB so provider
      // round-trips amortize across chunks instead of one request per chunk.
      const batch: EmbeddingQueueJob[] = [];
      while (embeddingQueue.length > 0 && batch.length < EMBEDDING_BATCH_SIZE) {
        if (
          batch.length > 0 &&
          embeddingQueue[0].context.dbPath !== batch[0].context.dbPath
        ) {
          break;
        }
        const job = embeddingQueue.shift();
        if (!job) continue;
        const projectId = runWithDatabaseContext(job.context, () =>
          vectorProjectId(job.vectorId),
        );
        if (projectId && pausedSemanticProjectIds.has(projectId)) {
          deferred.push(job);
          continue;
        }
        queuedEmbeddingIds.delete(`${job.context.dbPath}:${job.vectorId}`);
        batch.push(job);
      }
      if (batch.length === 0) continue;
      await runWithDatabaseContext(batch[0].context, () =>
        embedVectorRows(batch.map((job) => job.vectorId)),
      );
    }
  } finally {
    if (deferred.length > 0) {
      embeddingQueue.unshift(...deferred);
    }
    embeddingProcessing = false;
  }
}

export async function withSemanticIndexingPaused<T>(
  fn: () => Promise<T>,
): Promise<T> {
  embeddingPauseCount += 1;
  try {
    return await fn();
  } finally {
    embeddingPauseCount = Math.max(0, embeddingPauseCount - 1);
    if (embeddingPauseCount === 0 && embeddingQueue.length > 0) {
      setImmediate(() => {
        void processEmbeddingQueue();
      });
    }
  }
}

type PendingVectorRow = {
  id: string;
  provider: EmbeddingSettings["provider"];
  model_id: string;
  dimensions: number;
  content: string;
  user_id: string | null;
};

function settingsForVectorRow(row: PendingVectorRow): EmbeddingSettings {
  const baseSettings = readUserEmbeddingSettings(row.user_id);
  return {
    ...baseSettings,
    provider: row.provider,
    model: row.model_id,
    dimensionsPolicy:
      row.dimensions === 256
        ? "truncate-to-256"
        : row.dimensions === 512
          ? "truncate-to-512"
          : baseSettings.dimensionsPolicy,
  };
}

async function embedVectorRows(vectorIds: string[]): Promise<void> {
  if (vectorIds.length === 0) return;
  if (vectorIds.length === 1) return embedVectorRow(vectorIds[0]);

  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT v.id, v.provider, v.model_id, v.dimensions, c.content, d.user_id
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE v.id IN (${vectorIds.map(() => "?").join(", ")})
    `,
    )
    .all(...vectorIds) as PendingVectorRow[];
  if (rows.length === 0) return;

  const groups = new Map<string, PendingVectorRow[]>();
  for (const row of rows) {
    const key = `${row.provider}|${row.model_id}|${row.dimensions}|${row.user_id ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const markEmbedding = db.prepare(
    `
    UPDATE document_index_vectors
    SET status = 'embedding', error_message = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  );
  const markReady = db.prepare(
    `
    UPDATE document_index_vectors
    SET dimensions = ?,
        normalized = ?,
        embedding_blob = ?,
        status = 'ready',
        error_message = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  );

  for (const group of groups.values()) {
    const settings = settingsForVectorRow(group[0]);
    if (!settings.enabled) continue;
    for (const row of group) markEmbedding.run(row.id);
    try {
      const results = await embedDocumentTexts(
        group.map((row) => row.content),
        settings,
      );
      for (let i = 0; i < group.length; i += 1) {
        const result = results[i];
        markReady.run(
          result.dimensions,
          result.normalized ? 1 : 0,
          vectorToBlob(result.vector),
          group[i].id,
        );
      }
    } catch {
      // A failed batch falls back to per-row embedding so one bad chunk (or a
      // provider that rejects batch input) keeps per-row error isolation.
      for (const row of group) {
        await embedVectorRow(row.id);
      }
    }
  }
}

async function embedVectorRow(vectorId: string): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT v.id, v.provider, v.model_id, v.dimensions, c.content, d.user_id
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE v.id = ?
    `,
    )
    .get(vectorId) as
    | {
        id: string;
        provider: EmbeddingSettings["provider"];
        model_id: string;
        dimensions: number;
        content: string;
        user_id: string | null;
      }
    | undefined;
  if (!row) return;

  const baseSettings = readUserEmbeddingSettings(row.user_id);
  const settings: EmbeddingSettings = {
    ...baseSettings,
    provider: row.provider,
    model: row.model_id,
    dimensionsPolicy:
      row.dimensions === 256
        ? "truncate-to-256"
        : row.dimensions === 512
          ? "truncate-to-512"
          : baseSettings.dimensionsPolicy,
  };
  if (!settings.enabled) return;

  db.prepare(
    `
    UPDATE document_index_vectors
    SET status = 'embedding', error_message = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(vectorId);

  try {
    const result = await embedDocumentText(row.content, settings);
    db.prepare(
      `
      UPDATE document_index_vectors
      SET dimensions = ?,
          normalized = ?,
          embedding_blob = ?,
          status = 'ready',
          error_message = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(
      result.dimensions,
      result.normalized ? 1 : 0,
      vectorToBlob(result.vector),
      vectorId,
    );
  } catch (err) {
    db.prepare(
      `
      UPDATE document_index_vectors
      SET status = 'error',
          error_message = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run((err as Error).message || "Embedding failed", vectorId);
  }
}

export function startProjectSemanticIndexing(
  projectId: string,
  userId?: string | null,
): number {
  if (projectHasIndexingWork(projectId)) {
    throw new Error(
      "Wait for lexical indexing to finish before starting embedding",
    );
  }
  pausedSemanticProjectIds.delete(projectId);
  const enqueued = ensureProjectSemanticIndexQueued(projectId, userId);
  if (embeddingQueue.length > 0) {
    setImmediate(() => {
      void processEmbeddingQueue();
    });
  }
  return enqueued;
}

export function pauseProjectSemanticIndexing(projectId: string): number {
  pausedSemanticProjectIds.add(projectId);
  return queuedEmbeddingCountForProject(projectId);
}

export function getProjectSemanticIndexStatus(
  projectId: string,
  userId?: string | null,
): {
  enabled: boolean;
  provider: string;
  model_id: string;
  dimensions_policy: string;
  memory_profile: string;
  paused: boolean;
  queued_vectors: number;
  status_counts: Record<string, number>;
  ready_vectors: number;
  total_vectors: number;
  last_error: string | null;
} {
  const settings = readUserEmbeddingSettings(userId);
  const eligibleRow = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM document_index_chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN document_index_files f
        ON f.document_id = c.document_id
       AND f.version_id = c.version_id
       AND f.status = 'ready'
      WHERE d.project_id = ?
        AND d.current_version_id = c.version_id
    `,
    )
    .get(projectId) as { count: number };
  const rows = getDb()
    .prepare(
      `
      SELECT v.status, COUNT(*) AS count, MAX(v.error_message) AS last_error
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      JOIN document_index_files f
        ON f.document_id = c.document_id
       AND f.version_id = c.version_id
       AND f.status = 'ready'
      WHERE d.project_id = ?
        AND d.current_version_id = c.version_id
        AND v.provider = ?
        AND v.model_id = ?
      GROUP BY v.status
    `,
    )
    .all(projectId, settings.provider, settings.model) as {
    status: string;
    count: number;
    last_error: string | null;
  }[];

  const statusCounts: Record<string, number> = {};
  let lastError: string | null = null;
  for (const row of rows) {
    statusCounts[row.status] = row.count;
    if (row.last_error) lastError = row.last_error;
  }
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    model_id: settings.model,
    dimensions_policy: settings.dimensionsPolicy,
    memory_profile: settings.memoryProfile,
    paused: pausedSemanticProjectIds.has(projectId),
    queued_vectors: queuedEmbeddingCountForProject(projectId),
    status_counts: statusCounts,
    ready_vectors: statusCounts.ready ?? 0,
    total_vectors: Math.max(
      eligibleRow.count,
      rows.reduce((sum, row) => sum + row.count, 0),
    ),
    last_error: lastError,
  };
}

function docIdsForProject(projectId: string): Set<string> {
  const rows = getDb()
    .prepare("SELECT id FROM documents WHERE project_id = ?")
    .all(projectId) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

export async function drainIndexQueueForTests(): Promise<void> {
  if (!processing && queue.length === 0) return;
  await new Promise<void>((resolve) => {
    drainWaiters.push(resolve);
  });
}
