import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

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
  "message_credits_used",
]);

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
  update.updated_at = new Date().toISOString();

  const db = createServerSupabase();
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
  res.json(data);
});

// DELETE /user/account — local "delete account" reduces to clearing the
// SQLite tables. Project files and generated state are kept; the user can
// delete a project's `.docket` folder if they want a clean slate. We surface a
// no-op success here so the UI works the same as the cloud version.
userRouter.delete("/account", requireAuth, async (_req, res) => {
  res.status(204).send();
});
