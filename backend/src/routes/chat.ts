import { Router } from "express";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { requireAuth } from "../middleware/auth";
import { projectDataDir } from "../db/sqlite";
import { createServerSupabase } from "../lib/supabase";
import {
    buildDocContext,
    buildMessages,
    enrichWithPriorEvents,
    buildWorkflowStore,
    extractAnnotations,
    runLLMStream,
    PROJECT_EXTRA_TOOLS,
    type ChatMessage,
} from "../lib/chatTools";
import { completeText } from "../lib/llm";
import { sanitizeGeneratedChatTitle } from "../lib/chatTitle";
import { getUserApiKeys, getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { listRegisteredProjects } from "../lib/projectRegistry";
import { presentChatStreamError } from "../lib/chatStreamErrors";
import { clientDisconnectSignal } from "../lib/clientDisconnect";

export const chatRouter = Router();

export const DOCUMENT_ANNOTATION_TOOL_PROMPT = `USER PDF ANNOTATIONS (ATTACHED DOCUMENTS ONLY):
The annotation tools are restricted to the documents attached to this chat. Call get_user_pdf_annotations whenever the user assigns meaning to annotation colors, refers to their highlights, comments, notes, flags, or markings (including implicit phrases such as "based on what I marked"), or asks for an answer that reflects those markings. Do not substitute find_in_document or ordinary document search: those read document text, not the user's saved annotations.

For a large annotation set, first inspect the returned summary, then use filters and stable pagination until all relevant pages have been retrieved. Never claim completeness while a result is truncated. The user's current message defines what each color means; match color words to color_family and ask only when the meaning is genuinely ambiguous.

Before quoting, citing, or interpreting an annotation substantively, call read_annotation_context for that annotation and ground the answer in its surrounding document text. When citing an annotation, build the <CITATIONS> entry from read_annotation_context's indexed_quote and chunk_id, never from the annotation's own quote text, which may not match the indexed source and would be discarded. Plain listing and counting do not require a context read. Treat annotation comments as the user's notes, not as independently verified facts from the document.`;

const DOCUMENT_ANNOTATION_TOOL_NAMES = new Set([
    "get_user_pdf_annotations",
    "read_annotation_context",
]);

export function documentAnnotationTools(): unknown[] {
    return PROJECT_EXTRA_TOOLS.filter((tool) => {
        if (typeof tool !== "object" || tool === null || !("function" in tool)) {
            return false;
        }
        const name = (tool as { function?: { name?: string } }).function?.name;
        return typeof name === "string" && DOCUMENT_ANNOTATION_TOOL_NAMES.has(name);
    });
}

type ChatRow = {
    id: string;
    project_id: string | null;
    user_id: string;
    title: string | null;
    created_at: string;
};

function createdAtMs(chat: Partial<ChatRow>): number {
    const value = typeof chat.created_at === "string" ? chat.created_at : "";
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
}

function mergeRecentChats(chats: ChatRow[]): ChatRow[] {
    const byId = new Map<string, ChatRow>();
    for (const chat of chats) {
        if (!chat?.id || byId.has(chat.id)) continue;
        byId.set(chat.id, chat);
    }
    return [...byId.values()].sort((a, b) => createdAtMs(b) - createdAtMs(a));
}

// Recent-chat listing is a hot read path: resolve each owned project's DB
// from the registry path without opening-side writes, migrations, or
// realpath probing, and skip projects whose folder/DB is not reachable.
const OWNED_PROJECT_CHATS_LIMIT = 100;

function readProjectChatsOnce(dbPath: string, projectId: string): ChatRow[] {
    const db = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 100,
    });
    try {
        return db
            .prepare(
                `SELECT id, project_id, user_id, title, created_at
                 FROM chats
                 WHERE project_id = ?
                 ORDER BY created_at DESC
                 LIMIT ?`,
            )
            .all(projectId, OWNED_PROJECT_CHATS_LIMIT) as ChatRow[];
    } finally {
        db.close();
    }
}

function ownedProjectChats(userId: string, userEmail?: string): ChatRow[] {
    const rows: ChatRow[] = [];
    for (const project of listRegisteredProjects(userId, userEmail)) {
        if (project.user_id !== userId) continue;
        try {
            const dbPath = path.join(projectDataDir(project.path), "project.db");
            if (!fs.existsSync(dbPath)) continue;
            rows.push(...readProjectChatsOnce(dbPath, project.id));
        } catch (err) {
            console.warn(
                `[chat] unable to include chats for project ${project.id}: ${(err as Error).message}`,
            );
        }
    }
    return rows;
}

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const { data: ownProjects, error: projErr } = await db
        .from("projects")
        .select("id")
        .eq("user_id", userId);
    if (projErr) return void res.status(500).json({ detail: projErr.message });
    const ownProjectIds = ((ownProjects ?? []) as { id: string }[]).map(
        (p) => p.id,
    );

    const { data: ownChats, error } = await db
        .from("chats")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
    if (error) return void res.status(500).json({ detail: error.message });

    let ownedProjectAppChats: ChatRow[] = [];
    if (ownProjectIds.length > 0) {
        const { data: projectChats, error: projectChatErr } = await db
            .from("chats")
            .select("*")
            .in("project_id", ownProjectIds)
            .order("created_at", { ascending: false });
        if (projectChatErr)
            return void res.status(500).json({ detail: projectChatErr.message });
        ownedProjectAppChats = (projectChats ?? []) as ChatRow[];
    }

    res.json(
        mergeRecentChats([
            ...(ownChats ?? []),
            ...ownedProjectAppChats,
            ...ownedProjectChats(userId, userEmail),
        ]),
    );
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const projectId: string | null = req.body.project_id ?? null;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .insert({ user_id: userId, project_id: projectId ?? undefined })
        .select("id")
        .single();

    if (error) {
        console.error(
            `[chat/create] insert failed (project_id=${projectId ?? "null"}):`,
            error.message,
        );
        return void res.status(500).json({ detail: error.message });
    }
    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .single();
    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    // Owner of the chat OR a member of the chat's project can view it.
    let canView = chat.user_id === userId;
    if (!canView && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canView = access.ok;
    }
    if (!canView)
        return void res.status(404).json({ detail: "Chat not found" });

    const { data: messages } = await db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    const hydrated = await hydrateEditStatuses(messages ?? [], db);
    res.json({ chat, messages: hydrated });
});

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts
// or rejects, `document_edits.status` is updated but the stored message
// annotation is not. On chat load we merge the current DB status in so
// EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string")
                versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        collectFromAnnList(m.annotations);
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                }
            }
        }
    }
    if (editIds.size === 0 && versionIds.size === 0) return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const { data: rows } = await db
            .from("document_edits")
            .select("id, status")
            .in("id", Array.from(editIds));
        for (const r of (rows ?? []) as { id: string; status: string }[]) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status);
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const { data: vrows } = await db
            .from("document_versions")
            .select("id, version_number")
            .in("id", Array.from(versionIds));
        for (const r of (vrows ?? []) as {
            id: string;
            version_number: number | null;
        }[]) {
            versionNumberById.set(r.id, r.version_number ?? null);
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        next.annotations = patchAnnList(m.annotations);
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type !== "doc_edited") return ev;
                    let patched: Record<string, unknown> = {
                        ...ev,
                        annotations: patchAnnList(ev.annotations),
                    };
                    if (
                        typeof ev.version_id === "string" &&
                        versionNumberById.has(ev.version_id)
                    ) {
                        patched = {
                            ...patched,
                            version_number:
                                versionNumberById.get(ev.version_id) ?? null,
                        };
                    }
                    return patched;
                },
            );
        }
        return next;
    });
}

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const title = (req.body.title ?? "").trim();
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .update({ title })
        .eq("id", chatId)
        .eq("user_id", userId)
        .select("id, title")
        .single();

    if (error || !data)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const { error } = await db
        .from("chats")
        .delete()
        .eq("id", chatId)
        .eq("user_id", userId);

    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const message: string = (req.body.message ?? "").trim();
    if (!message)
        return void res.status(400).json({ detail: "message is required" });

    const db = createServerSupabase();
    const { data: chat, error } = await db
        .from("chats")
        .select("id, user_id, project_id")
        .eq("id", chatId)
        .single();

    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    let canTitle = chat.user_id === userId;
    if (!canTitle && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canTitle = access.ok;
    }
    if (!canTitle)
        return void res.status(404).json({ detail: "Chat not found" });

    let title: string;
    try {
        const { title_model, api_keys } = await getUserModelSettings(
            userId,
            db,
        );
        const titleText = await completeText({
            model: title_model,
            user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
            maxTokens: 64,
            apiKeys: api_keys,
        });
        title = sanitizeGeneratedChatTitle(titleText, message);
    } catch (err) {
        console.error("[generate-title]", err);
        // Title generation is cosmetic and must not turn a successful chat
        // into a failed request when a provider is offline or rate-limited.
        title = message.slice(0, 60);
    }

    const { error: updateError } = await db
        .from("chats")
        .update({ title })
        .eq("id", chatId)
        .eq("user_id", userId);
    if (updateError)
        return void res.status(500).json({ detail: "Failed to save title" });
    res.json({ title });
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
  const signal = clientDisconnectSignal(req, res);
  try {
    const userId = res.locals.userId as string;
    const { messages, chat_id, project_id, model, disabled_tools } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        project_id?: string;
        model?: string;
        disabled_tools?: string[];
    };

    console.log("[chat/stream] incoming request", {
        userId,
        chat_id,
        project_id,
        model,
        messageCount: messages?.length,
    });

    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        // Either chat owner OR a member of the chat's project can post.
        const { data: existing } = await db
            .from("chats")
            .select("id, title, user_id, project_id")
            .eq("id", chatId)
            .single();
        let canUse = !!existing && existing.user_id === userId;
        if (!canUse && existing?.project_id) {
            const access = await checkProjectAccess(
                existing.project_id,
                userId,
                userEmail,
                db,
            );
            canUse = access.ok;
        }
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        if (project_id) {
            const access = await checkProjectAccess(
                project_id,
                userId,
                userEmail,
                db,
            );
            if (!access.ok)
                return void res
                    .status(404)
                    .json({ detail: "Project not found" });
        }
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: project_id ?? null })
            .select("id, title")
            .single();
        if (error || !newChat) {
            console.error("[chat/stream] failed to create chat", error);
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    console.log("[chat/stream] resolved chatId", chatId);

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
            files: lastUser.files ?? null,
        });
    }

    const { docIndex, docStore } = await buildDocContext(
        messages,
        userId,
        db,
        chatId,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
    );
    const apiMessages = buildMessages(
        enrichedMessages,
        docAvailability,
        DOCUMENT_ANNOTATION_TOOL_PROMPT,
        docIndex,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    console.log("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    const apiKeys = await getUserApiKeys(userId, db);

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

        const { fullText, events, citations } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            extraTools: documentAnnotationTools(),
            workflowStore,
            model,
            apiKeys,
            projectId: project_id ?? null,
            disabledTools: Array.isArray(disabled_tools)
                ? disabled_tools.filter(
                      (name): name is string => typeof name === "string",
                  )
                : [],
            signal,
        });

        console.log("[chat/stream] LLM stream finished", {
            fullTextLen: fullText?.length ?? 0,
            eventCount: events?.length ?? 0,
        });

        const annotations = extractAnnotations(fullText, docIndex, events, citations);
        const debugInsertDelayMs = Number.parseInt(
            process.env.DOCKET_DEBUG_INSERT_DELAY_MS ?? "",
            10,
        );
        if (Number.isFinite(debugInsertDelayMs) && debugInsertDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, debugInsertDelayMs));
        }
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "assistant",
            content: events.length ? events : null,
            annotations: annotations.length ? annotations : null,
        });

        if (!chatTitle && lastUser?.content) {
            await db
                .from("chats")
                .update({ title: lastUser.content.slice(0, 120) })
                .eq("id", chatId);
        }
        // [DONE] triggers client hydration, so persistence must win this race.
        write("data: [DONE]\n\n");
    } catch (err) {
        console.error("[chat/stream] error:", err);
        try {
            const payload = presentChatStreamError(err);
            write(
                `data: ${JSON.stringify(payload)}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
  } catch (err) {
    // Catches throws from the prologue (DB inserts, doc-context build, etc.)
    // that happen BEFORE the inner try block / res.flushHeaders. After
    // headers are sent we already write SSE errors via the inner catch.
    console.error("[chat/stream] prologue threw:", err);
    if (!res.headersSent) {
      res.status(500).json({ detail: "Internal error" });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  }
});
