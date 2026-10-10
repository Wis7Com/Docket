import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { enqueueEmptyPdfIndexes } from "../lib/indexing/indexer";
import {
  listRegisteredProjects,
  projectContextFor,
} from "../lib/projectRegistry";
import { runWithDatabaseContext } from "../db/sqlite";
import { RERANK_DEPTH_CHOICES, getRerankStatus } from "../lib/indexing/rerank";

export const userRouter = Router();

// POST /user/profile — ensures a profile row exists; returns nothing.
userRouter.post("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// GET /user/profile — returns the calling user's profile row, creating one
// if it doesn't yet exist (single-user local app — there's only one).
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();

  await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );

  const { data, error } = await db
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data);
});

// PATCH /user/profile — partial update. Accepts the same column names as the
// `user_profiles` row; ignores anything not in the allowed list.
const ALLOWED_FIELDS = new Set([
  "display_name",
  "organisation",
  "tabular_model",
  "claude_api_key",
  "gemini_api_key",
  "openai_api_key",
  "openrouter_api_key",
  "nvidia_api_key",
  "openai_compatible_api_key",
  "openai_compatible_base_url",
  "embedding_provider",
  "embedding_model",
  "embedding_base_url",
  "embedding_api_key",
  "embedding_dimensions_policy",
  "embedding_enabled",
  "embedding_memory_profile",
  "chat_full_read_max_docs",
  "chat_full_read_max_text_bytes",
  "chat_fetch_max_docs",
  "chat_fetch_max_text_bytes",
  "ocr_enabled",
  "ocr_mode",
  "ocr_engine",
  "ocr_languages",
  "ocr_max_pages_per_doc",
  "ocr_gpu_endpoint",
  "ocr_external_provider",
  "reranker_enabled",
  "reranker_depth",
  "reranker_base_url",
  "reranker_model_path",
  "message_credits_used",
]);

// NULL means "use the default", so every reranker field accepts null. Checked
// here rather than in SQL so a bad value never reaches the profile row.
const RERANKER_SCHEMAS: Record<string, z.ZodType<unknown>> = {
  reranker_enabled: z
    .union(
      [z.boolean().transform((v) => (v ? 1 : 0)), z.literal(0), z.literal(1)],
      {
        error: "must be true, false, 0, 1 or null",
      },
    )
    .nullable(),
  reranker_depth: z
    .union(
      [
        z.literal(RERANK_DEPTH_CHOICES[0]),
        z.literal(RERANK_DEPTH_CHOICES[1]),
        z.literal(RERANK_DEPTH_CHOICES[2]),
      ],
      { error: `must be one of ${RERANK_DEPTH_CHOICES.join(", ")} or null` },
    )
    .nullable(),
  reranker_base_url: z
    .string({ error: "must be a string or null" })
    .trim()
    .regex(/^https?:\/\/\S+$/i, "must be an http:// or https:// URL")
    .nullable(),
  reranker_model_path: z
    .string({ error: "must be a string or null" })
    .trim()
    .refine(
      (v) => v.startsWith("/") || v === "~" || v.startsWith("~/"),
      "must be an absolute path or start with ~/",
    )
    .nullable(),
};

// Whitespace-only text means "clear", same as the empty string the generic
// handler already maps to null.
function blankToNull(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? null : value;
}

userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_FIELDS.has(k)) update[k] = v === "" ? null : v;
  }
  if (Object.keys(update).length === 0) {
    return void res.status(400).json({ detail: "No allowed fields in body" });
  }
  for (const [field, schema] of Object.entries(RERANKER_SCHEMAS)) {
    if (!Object.hasOwn(update, field)) continue;
    const parsed = schema.safeParse(blankToNull(update[field]));
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? "invalid value";
      return void res.status(400).json({ detail: `${field}: ${reason}` });
    }
    update[field] = parsed.data;
  }
  update.updated_at = new Date().toISOString();

  const db = createServerSupabase();
  const { data: before } = await db
    .from("user_profiles")
    .select("ocr_enabled, ocr_engine")
    .eq("user_id", userId)
    .single();
  const { error } = await db
    .from("user_profiles")
    .update(update)
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });

  const { data } = await db
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();

  const previous = before as
    | { ocr_enabled?: number | boolean | null; ocr_engine?: string | null }
    | null;
  const current = data as
    | { ocr_enabled?: number | boolean | null; ocr_engine?: string | null }
    | null;
  const ocrBecameEnabled =
    Object.hasOwn(update, "ocr_enabled") &&
    !Boolean(previous?.ocr_enabled) &&
    Boolean(current?.ocr_enabled);
  const ocrEngineChanged =
    Object.hasOwn(update, "ocr_engine") &&
    previous?.ocr_engine !== current?.ocr_engine;
  if (Boolean(current?.ocr_enabled) && (ocrBecameEnabled || ocrEngineChanged)) {
    for (const project of listRegisteredProjects(userId)) {
      try {
        await runWithDatabaseContext(projectContextFor(project), async () => {
          enqueueEmptyPdfIndexes(project.id);
        });
      } catch (err) {
        console.warn(
          `[ocr] unable to enqueue empty PDFs for project ${project.id}`,
          err,
        );
      }
    }
  }
  res.json(data);
});

// GET /user/reranker/status — what the Models page shows: whether the reranker
// would run right now and, if not, which piece is missing.
userRouter.get("/reranker/status", requireAuth, (_req, res) => {
  const userId = res.locals.userId as string;
  res.json(getRerankStatus(userId));
});

// DELETE /user/account — local "delete account" reduces to clearing the
// SQLite tables. Project files and generated state are kept; the user can
// delete a project's `.docket` folder if they want a clean slate. We surface a
// no-op success here so the UI works the same as the cloud version.
userRouter.delete("/account", requireAuth, async (_req, res) => {
  res.status(204).send();
});
