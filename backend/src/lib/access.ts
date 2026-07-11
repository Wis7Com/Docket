/**
 * Project / document access helpers.
 *
 * Local projects are private folder-backed boundaries. Project access is
 * therefore identical to project ownership.
 */

import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type ProjectAccess =
    | {
          ok: true;
          isOwner: boolean;
          project: {
              id: string;
              user_id: string;
          };
      }
    | { ok: false };

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectAccess> {
    const { data: project } = await db
        .from("projects")
        .select("id, user_id")
        .eq("id", projectId)
        .single();
    if (!project) return { ok: false };
    const proj = project as {
        id: string;
        user_id: string;
    };
    void userEmail;
    if (proj.user_id === userId) {
        return { ok: true, isOwner: true, project: proj };
    }
    return { ok: false };
}

/**
 * Check whether the current user can access a document the caller has
 * already loaded (saves a round-trip vs. having the helper re-fetch).
 * Owner-of-doc passes immediately; otherwise we fall through to a
 * project ownership check.
 */
export async function ensureDocAccess(
    doc: { user_id: string; project_id: string | null },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (doc.user_id === userId) return { ok: true, isOwner: true };
    if (!doc.project_id) return { ok: false };
    const access = await checkProjectAccess(
        doc.project_id,
        userId,
        userEmail,
        db,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Tabular reviews are project-owned and are not independently shareable.
 */
export async function ensureReviewAccess(
    review: {
        user_id: string;
        project_id: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (review.user_id === userId) return { ok: true, isOwner: true };
    if (!review.project_id) return { ok: false };
    const access = await checkProjectAccess(
        review.project_id,
        userId,
        userEmail,
        db,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Returns the user's project IDs.
 */
export async function listAccessibleProjectIds(
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    void userEmail;
    const { data: own } = await db
        .from("projects")
        .select("id")
        .eq("user_id", userId);
    const ids = new Set<string>();
    for (const p of (own ?? []) as { id: string }[]) ids.add(p.id);
    return [...ids];
}
