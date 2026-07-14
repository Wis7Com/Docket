import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db/sqlite";
import type {
  DocumentSummaryBatchCache,
  ValidatedBatchSummary,
} from "./documentSummary";

const chunkSchema = z.object({
  chunk_id: z.string(),
  chunk_index: z.number().int(),
  page_number: z.number().int().nullable(),
  page_end: z.number().int().nullable().optional(),
  content: z.string(),
  start_char: z.number().int(),
  end_char: z.number().int(),
});

const validatedBatchSummarySchema = z.object({
  batchId: z.string(),
  points: z.array(
    z.object({
      text: z.string(),
      evidenceIds: z.array(z.string()),
    }),
  ),
  evidence: z.array(
    z.object({
      id: z.string(),
      sourceBatchId: z.string(),
      claim: z.string(),
      chunk: chunkSchema,
      quote: z.string(),
      quoteStart: z.number().int(),
      quoteEnd: z.number().int(),
    }),
  ),
});

export type SqliteDocumentSummaryBatchCacheArgs = {
  documentId: string;
  versionId: string;
  model: string;
  /** Test seam; production uses the request-scoped project database. */
  db?: Database.Database;
};

export function createSqliteDocumentSummaryBatchCache(
  args: SqliteDocumentSummaryBatchCacheArgs,
): DocumentSummaryBatchCache {
  const db = args.db ?? getDb();
  const contentRevision = (): number | null => {
    const row = db
      .prepare(
        `SELECT content_revision
         FROM document_versions
         WHERE id = ? AND document_id = ?`,
      )
      .get(args.versionId, args.documentId) as
      | { content_revision: number }
      | undefined;
    return row?.content_revision ?? null;
  };

  return {
    get(key) {
      const revision = contentRevision();
      if (revision === null) return null;
      const row = db
        .prepare(
          `SELECT summary_json
           FROM document_summary_batches
           WHERE document_id = ? AND version_id = ? AND batch_key = ?
             AND content_revision = ?`,
        )
        .get(args.documentId, args.versionId, key, revision) as
        | { summary_json: string }
        | undefined;
      if (!row) return null;
      const parsed = validatedBatchSummarySchema.safeParse(
        JSON.parse(row.summary_json),
      );
      if (!parsed.success) {
        console.warn("[document-summary/cache] ignored invalid row", {
          documentId: args.documentId,
          versionId: args.versionId,
          batchKey: key,
          error: z.prettifyError(parsed.error),
        });
        return null;
      }
      return parsed.data as ValidatedBatchSummary;
    },

    set(key, value) {
      const revision = contentRevision();
      if (revision === null) return;
      db.prepare(
        `INSERT INTO document_summary_batches (
           document_id, version_id, batch_key, summary_json, model,
           content_revision
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(document_id, version_id, batch_key) DO UPDATE SET
           summary_json = excluded.summary_json,
           model = excluded.model,
           content_revision = excluded.content_revision,
           created_at = CURRENT_TIMESTAMP`,
      ).run(
        args.documentId,
        args.versionId,
        key,
        JSON.stringify(value),
        args.model,
        revision,
      );
    },
  };
}
