import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    buildProjectDocContext,
    filterDocContext,
    buildMessages,
    buildWorkflowStore,
    documentToolResultMaxCharsForModel,
    enrichWithPriorEvents,
    extractAnnotations,
    runLLMStream,
    PROJECT_EXTRA_TOOLS,
    type ChatMessage,
    type DocIndex,
} from "../lib/chatTools";
import { getUserApiKeys, getUserRetrievalSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { getProjectIndexCorpusStats } from "../lib/indexing/search";
import { presentChatStreamError } from "../lib/chatStreamErrors";
import {
    classifyAnnotationColor,
    type AnnotationColorFamily,
} from "../lib/annotationColors";

export const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. For broad or unnamed-source project questions, call search_project_documents with group_by_document=true first so distinct candidate documents are represented; then run doc_ids-scoped chunk searches and use read_index_chunk for evidence and surrounding context. Escalate to read_document / fetch_documents only for selected documents that fit the full-read budget.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

DOCUMENT COMPARISON REQUESTS:
When the user asks to compare two or more documents, or two sides' briefs, issue-by-issue: (1) identify the documents or sides from AVAILABLE DOCUMENTS, using list_documents if needed; (2) discover the issue list with one or two broad search_project_documents calls or a scoped skim of opening sections with read_index_chunk; (3) for EACH issue, run search_project_documents once per document or side with doc_ids scoping and the same issue query; (4) verify quotes with read_index_chunk before citing; and (5) output a comparison table with one row per issue and one column per document or side, citing page numbers. Use an inline Markdown table by default, or generate_docx with landscape: true when the user asks for a file.

REPLICATING A DOCUMENT:
When the user wants to use an existing project document as a starting point for a new file (e.g. "use this NDA as a template", "make me a copy of the SOW so I can edit it", "duplicate this and adapt it for company X"), call the replicate_document tool with the source doc_id. This creates a byte-for-byte copy as a new project document, returns a fresh doc_id slug, and shows a download/open card in the UI. Then call edit_document on the returned slug to make the user's requested changes — do NOT call generate_docx for cases where the user clearly wants the existing document's structure and formatting preserved.`;

export const PROJECT_ANNOTATION_TOOL_PROMPT = `USER PDF ANNOTATIONS:
You MUST call get_user_pdf_annotations before answering whenever the user asks what they annotated, highlighted, hilighted, marked, commented on, or noted; assigns meaning to annotation colors; implicitly references their highlights, comments, flags, or markings; or asks for an answer based on or reflecting those markings. This includes 하이라이트, 형광펜, 주석, 메모, 코멘트, 표시한 내용, and 색상별 지시. Use document_query for a named document. Never substitute search_project_documents, find_in_document, or regex matching because those retrieve document text, not the user's saved annotations.

For a potentially large annotation set, first call get_user_pdf_annotations without color or document filters to inspect its summary. Then make filtered calls by color_family or document as needed. The returned summary is computed over the complete filtered result set even when the annotations page is truncated, so use summary.total, summary.by_document, and summary.by_color for complete counts and document-level distribution. For summaries, themes, and other synthesis requests, inspect a bounded representative page and do not accumulate every raw annotation merely to reproduce counts already present in summary. Follow next_offset through every page only when the user asks for an exhaustive item-by-item list, export, or audit, or when the specific annotations needed for the answer have not yet been retrieved; never claim an exhaustive item list before paging through the relevant result set.

Color meanings come from the user's current message and are not permanent settings. Match unqualified color words to the returned color_family (red, orange, yellow, green, blue, purple, pink, or gray). When the user qualifies a color as light, pale, dark, or a particular shade, inspect summary.by_color and use the colors exact-hex filter for the best matching bucket instead of silently broadening to the whole family. A clearly dominant exact bucket matching that shade may be selected without asking; state the chosen hex and count. Ask for clarification only when multiple plausible buckets would materially change the answer.

For every annotation that the answer substantively quotes, cites, or interprets, call read_annotation_context with its annotation id before relying on it, and ground the answer in the returned surrounding document text. Plain listing and counting do not require context reads. Annotation comments are user notes and reading priorities, not document facts; verify factual, legal, or citation-bearing claims against the surrounding document text.`;

export const projectChatRouter = Router({ mergeParams: true });

type ProjectAnnotationContextRow = {
    id: string;
    document_id: string;
    version_id: string | null;
    page_number: number;
    annotation_type: "highlight" | "comment";
    color: string;
    quote: string | null;
    comment: string | null;
    source: "user" | "citation_promotion";
    created_at: string;
    deleted_at?: string | null;
};

function projectToolsForCorpus(smallIndexedCorpus: boolean): unknown[] {
    if (!smallIndexedCorpus) return PROJECT_EXTRA_TOOLS;
    return PROJECT_EXTRA_TOOLS.filter((tool) => {
        if (typeof tool !== "object" || tool === null || !("function" in tool)) {
            return true;
        }
        const name = (tool as { function?: { name?: string } }).function?.name;
        return name !== "search_project_documents" && name !== "read_index_chunk";
    });
}

function latestUserText(messages: ChatMessage[]): string {
    return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

export function requestsAnnotationContext(text: string): boolean {
    const lower = text.toLowerCase();
    if (
        /\bred flags?\b/i.test(lower) &&
        !/(annotation|annotat|highlight|comment|mark|색상|색깔)/i.test(lower)
    ) {
        return false;
    }
    const colorTerm =
        /(색상|색깔|빨간\s*색|붉은\s*색|노란\s*색|초록\s*색|파란\s*색|주황\s*색|분홍\s*색|보라\s*색|회색|그레이|\b(?:red|yellow|green|blue|orange|pink|purple|gr[ae]y)\b)/i;
    const annotationTerm =
        /(annotation|annotat|annotition|highlight|comment|하이라이트|형광펜|주석|메모|코멘트|표시한|강조한|밑줄|마크|flag|색상|색깔|빨간\s*색|붉은\s*색|노란\s*색|초록\s*색|파란\s*색|주황\s*색|분홍\s*색|보라\s*색|회색|그레이|red|yellow|green|blue|orange|pink|purple|gr[ae]y)/i;
    const explicitAnnotationTerm =
        /(annotation|annotat|annotition|highlight|comment|하이라이트|형광펜|주석|메모|코멘트|표시한|강조한|밑줄|마크|flag)/i;
    const instructionTerm =
        /(근거|기반|고려|반영|참조|중심|중점|초점|위주|강조|강조점|토대|바탕|주의|유의|caveat|based on|basis|consider|reflect|refer|according to|take into account|focus|emphasis|prioritize|priority)/i;
    const annotationActionTerm =
        /(가져|찾아|보여|목록|요약|만들|정리|비교|대비|표|fetch|find|list|retrieve|show|summari[sz]e|make|organize|compare|table)/i;
    const firstPersonTerm =
        /(내|내가|사용자|user|\bmy\b|\bmine\b|\bi\s+(?:made|added|created|highlighted|annotated)\b)/i;
    return (
        annotationTerm.test(lower) &&
        (instructionTerm.test(lower) ||
            firstPersonTerm.test(lower) ||
            ((explicitAnnotationTerm.test(lower) || colorTerm.test(lower)) &&
                annotationActionTerm.test(lower)))
    );
}

function clipAnnotationText(value: string | null | undefined, max = 360): string {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 1)}…`;
}

export function describeAnnotationColor(color: string | null | undefined): string | null {
    return classifyAnnotationColor(color)?.label ?? null;
}

export function requestedAnnotationColorFamilies(text: string): Set<AnnotationColorFamily> {
    const lower = text.toLowerCase();
    const families = new Set<AnnotationColorFamily>();
    if (/(빨간\s*색?|붉은\s*색?|red)/i.test(lower)) families.add("red");
    if (/(노란\s*색?|노랑|yellow)/i.test(lower)) families.add("yellow");
    if (/(초록\s*색?|녹색|green)/i.test(lower)) families.add("green");
    if (/(파란\s*색?|파랑|청색|blue)/i.test(lower)) families.add("blue");
    if (/(주황\s*색?|orange)/i.test(lower)) families.add("orange");
    if (/(분홍\s*색?|핑크|pink)/i.test(lower)) families.add("pink");
    if (/(보라\s*색?|자주\s*색?|purple)/i.test(lower)) families.add("purple");
    if (/(회색|그레이|gr[ae]y)/i.test(lower)) families.add("gray");
    return families;
}

export function resolveSelectedDocumentScope(
    rawSelectedDocumentIds: unknown,
    docIndex: DocIndex,
): { documentIds?: string[]; warning?: string } {
    if (rawSelectedDocumentIds === undefined) return {};
    if (!Array.isArray(rawSelectedDocumentIds)) {
        return { warning: "selected_document_ids was not an array; ignoring scope" };
    }
    const requested = new Set(
        rawSelectedDocumentIds
            .filter(
                (value): value is string =>
                    typeof value === "string" && value.trim().length > 0,
            )
            .map((value) => value.trim()),
    );
    if (requested.size === 0) {
        return { warning: "selected_document_ids was empty; ignoring scope" };
    }
    const available = new Set(
        Object.values(docIndex).map((info) => info.document_id),
    );
    const documentIds = [...requested].filter((id) => available.has(id));
    if (documentIds.length === 0) {
        return {
            warning:
                "selected_document_ids did not contain any available project documents; ignoring scope",
        };
    }
    return { documentIds };
}

export function buildSourceScopePrompt(documentCount: number): string {
    return `SOURCE SCOPE:\nThe user has restricted this chat to ${documentCount} selected document${documentCount === 1 ? "" : "s"} listed under AVAILABLE DOCUMENTS. Do not reference or claim to search other project documents. If the question clearly requires an unselected document, say so and ask the user to include it. If displayed_doc points outside this source scope, this SOURCE SCOPE rule takes precedence.`;
}

export async function buildRequestedAnnotationContext(args: {
    userId: string;
    db: ReturnType<typeof createServerSupabase>;
    docIndex: Record<
        string,
        {
            document_id: string;
            filename: string;
            version_id?: string | null;
        }
    >;
    displayedDoc?: { filename: string; document_id: string };
    attachedDocuments?: { filename: string; document_id: string }[];
    latestUserText?: string;
}): Promise<string | null> {
    const labelByDocumentId = new Map<string, string>();
    const currentVersionByDocumentId = new Map<string, string | null>();
    const filenameByDocumentId = new Map<string, string>();
    for (const [label, info] of Object.entries(args.docIndex)) {
        labelByDocumentId.set(info.document_id, label);
        currentVersionByDocumentId.set(info.document_id, info.version_id ?? null);
        filenameByDocumentId.set(info.document_id, info.filename);
    }
    const documentIds = [...labelByDocumentId.keys()];
    if (documentIds.length === 0) return null;

    const focusedDocumentIds = new Set<string>();
    if (
        args.displayedDoc?.document_id &&
        labelByDocumentId.has(args.displayedDoc.document_id)
    ) {
        focusedDocumentIds.add(args.displayedDoc.document_id);
    }
    for (const doc of args.attachedDocuments ?? []) {
        if (doc.document_id && labelByDocumentId.has(doc.document_id)) {
            focusedDocumentIds.add(doc.document_id);
        }
    }

    const selectFields =
        "id, document_id, version_id, page_number, annotation_type, color, quote, comment, source, created_at, deleted_at";
    const batches: ProjectAnnotationContextRow[][] = [];
    const focusedIds = [...focusedDocumentIds];
    if (focusedIds.length > 0) {
        const { data: focusedData } = await args.db
            .from("pdf_annotations")
            .select(selectFields)
            .eq("user_id", args.userId)
            .in("document_id", focusedIds)
            .order("created_at", { ascending: false })
            .limit(120);
        batches.push((focusedData ?? []) as ProjectAnnotationContextRow[]);
    }

    const { data: recentData } = await args.db
        .from("pdf_annotations")
        .select(selectFields)
        .eq("user_id", args.userId)
        .in("document_id", documentIds)
        .order("created_at", { ascending: false })
        .limit(120);
    batches.push((recentData ?? []) as ProjectAnnotationContextRow[]);

    const uniqueRows = new Map<string, ProjectAnnotationContextRow>();
    for (const row of batches.flat()) {
        uniqueRows.set(row.id, row);
    }

    const requestedColors = requestedAnnotationColorFamilies(args.latestUserText ?? "");
    const sortedRows = [...uniqueRows.values()]
        .filter((row) => {
            if (row.deleted_at) return false;
            if (!labelByDocumentId.has(row.document_id)) return false;
            const currentVersion = currentVersionByDocumentId.get(row.document_id);
            return !row.version_id || !currentVersion || row.version_id === currentVersion;
        })
        .sort((a, b) => {
            const aFocus = focusedDocumentIds.has(a.document_id) ? 0 : 1;
            const bFocus = focusedDocumentIds.has(b.document_id) ? 0 : 1;
            if (aFocus !== bFocus) return aFocus - bFocus;
            const aHasText = clipAnnotationText(a.quote) || clipAnnotationText(a.comment);
            const bHasText = clipAnnotationText(b.quote) || clipAnnotationText(b.comment);
            if (!!aHasText !== !!bHasText) return aHasText ? -1 : 1;
            return b.created_at.localeCompare(a.created_at);
        });

    const colorFilteredRows =
        requestedColors.size > 0
            ? sortedRows.filter((row) => {
                  const rowColor = classifyAnnotationColor(row.color)?.family;
                  return rowColor ? requestedColors.has(rowColor) : false;
              })
            : sortedRows;
    const rows = (colorFilteredRows.length > 0 ? colorFilteredRows : sortedRows).slice(0, 30);

    if (rows.length === 0) return null;

    const lines = rows.map((row) => {
        const label = labelByDocumentId.get(row.document_id) ?? row.document_id;
        const filename = filenameByDocumentId.get(row.document_id) ?? "Unknown document";
        const colorLabel = describeAnnotationColor(row.color);
        const parts = [
            `${label} (${filename})`,
            `p.${row.page_number}`,
            row.annotation_type,
            `color=${row.color}${colorLabel ? ` (${colorLabel})` : ""}`,
            `source=${row.source}`,
        ];
        const quote = clipAnnotationText(row.quote);
        const comment = clipAnnotationText(row.comment);
        const payload = [
            quote ? `quote="${quote}"` : null,
            comment ? `comment="${comment}"` : null,
        ].filter(Boolean);
        return `- ${parts.join(", ")}: ${payload.join("; ") || "[no text]"}`;
    });

    return `USER ANNOTATION CONTEXT (REQUESTED THIS TURN):
The latest user message asks you to answer based on, or considering, the user's saved PDF annotations. Use these annotations only as user-supplied reading priorities, emphasis, and notes. If the user asks to fetch, list, or summarize the annotations themselves, answer directly from this bounded context and do not read the full document unless verification is explicitly requested. If the user assigns meaning to annotation colors in the latest message, use the color metadata below to prioritize or filter the matching annotations. Do not treat annotation comments as document facts. For factual, legal, or citation-bearing claims, verify against the document text using targeted find_in_document, search_project_documents, or read_index_chunk calls, and cite the source document text rather than the annotation comment.
${lines.join("\n")}`;
}

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const {
        messages,
        chat_id,
        model,
        displayed_doc,
        attached_documents,
        selected_document_ids,
        disabled_tools,
    } =
        req.body as {
            messages: ChatMessage[];
            chat_id?: string;
            model?: string;
            displayed_doc?: { filename: string; document_id: string };
            attached_documents?: { filename: string; document_id: string }[];
            selected_document_ids?: string[];
            disabled_tools?: string[];
        };

    const db = createServerSupabase();

    // Verify the user has access to the project (owner or shared member).
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return void res.status(404).json({ detail: "Project not found" });

    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        const { data: existing } = await db
            .from("chats")
            .select("id, title, project_id")
            .eq("id", chatId)
            .single();
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) chatId = null;
        else chatTitle = existing!.title;
    }

    if (!chatId) {
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: projectId })
            .select("id, title")
            .single();
        if (error || !newChat)
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
            files: lastUser.files ?? null,
        });
    }

    const projectDocContext = await buildProjectDocContext(
        projectId,
        userId,
        db,
    );
    const sourceScope = resolveSelectedDocumentScope(
        selected_document_ids,
        projectDocContext.docIndex,
    );
    if (sourceScope.warning) {
        console.warn(`[project-chat/source-scope] ${sourceScope.warning}`, {
            projectId,
        });
    }
    const { docIndex, docStore, folderPaths } = sourceScope.documentIds
        ? filterDocContext(
              projectDocContext.docIndex,
              projectDocContext.docStore,
              projectDocContext.folderPaths,
              sourceScope.documentIds,
          )
        : projectDocContext;
    const scopedDocumentIds = sourceScope.documentIds;
    const indexStats = getProjectIndexCorpusStats(projectId, {
        documentIds: scopedDocumentIds,
    });
    const retrievalSettings = await getUserRetrievalSettings(userId, db);
    const documentResultMaxChars = documentToolResultMaxCharsForModel(
        model,
        retrievalSettings.chat_fetch_max_text_bytes,
    );
    const fullReadMaxTextBytes = documentToolResultMaxCharsForModel(
        model,
        retrievalSettings.chat_full_read_max_text_bytes,
    );
    const smallIndexedCorpus =
        indexStats.total_documents > 0 &&
        indexStats.ready_documents === indexStats.total_documents &&
        indexStats.total_documents <= retrievalSettings.chat_full_read_max_docs &&
        indexStats.text_bytes <=
            (fullReadMaxTextBytes ?? retrievalSettings.chat_full_read_max_text_bytes);
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        folder_path: folderPaths.get(doc_id),
    }));

    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
    );
    const messagesForLLM: ChatMessage[] = displayed_doc
        ? enrichedMessages.map((m, i) => {
              if (i !== enrichedMessages.length - 1 || m.role !== "user")
                  return m;
              return {
                  ...m,
                  content: `${m.content}\n\ndisplayed_doc: ${displayed_doc.filename}, displayed_doc_id: ${displayed_doc.document_id}`,
              };
          })
        : enrichedMessages;

    // The user-attached docs for this turn (dragged into / picked from
    // the chat input) come in as a request-level field. Surface them in
    // the system prompt with the current-turn doc_id slugs so the model
    // knows which docs the user is highlighting *now*, distinct from
    // the broader project doc list.
    let systemPromptExtra = PROJECT_SYSTEM_PROMPT_EXTRA;
    if (smallIndexedCorpus) {
        systemPromptExtra += `\n\nSMALL PROJECT CORPUS:\nThis project is small enough to preserve full-context behavior (${indexStats.total_documents} documents, ${indexStats.text_bytes} indexed bytes; current budget ${retrievalSettings.chat_full_read_max_docs} documents / ${fullReadMaxTextBytes ?? retrievalSettings.chat_full_read_max_text_bytes} bytes). Prefer list_documents plus read_document/fetch_documents directly instead of search_project_documents. For comparison requests, read each document fully and build the issue table from the full text.`;
    } else {
        systemPromptExtra += `\n\nPROJECT RETRIEVAL BUDGETS:\nUse search_project_documents for broad questions, read_index_chunk with neighbors for context, and only full-read selected documents when there are at most ${retrievalSettings.chat_fetch_max_docs} selected documents and about ${documentResultMaxChars ?? retrievalSettings.chat_fetch_max_text_bytes} bytes of text. If search reports unindexed documents, use find_in_document for a targeted cold fallback; read_document results above the current budget are rejected.`;
    }
    if (scopedDocumentIds) {
        systemPromptExtra += `\n\n${buildSourceScopePrompt(scopedDocumentIds.length)}`;
    }
    const normalizedDisabledTools = Array.isArray(disabled_tools)
        ? disabled_tools.filter(
              (name): name is string => typeof name === "string",
          )
        : [];
    const annotationToolEnabled = !normalizedDisabledTools.includes(
        "get_user_pdf_annotations",
    );
    const latestText = latestUserText(messages);
    if (annotationToolEnabled) {
        systemPromptExtra += `\n\n${PROJECT_ANNOTATION_TOOL_PROMPT}`;
    } else if (requestsAnnotationContext(latestText)) {
        const annotationContext = await buildRequestedAnnotationContext({
            userId,
            db,
            docIndex,
            displayedDoc: displayed_doc,
            attachedDocuments: attached_documents,
            latestUserText: latestText,
        });
        if (annotationContext) {
            systemPromptExtra += `\n\n${annotationContext}`;
        } else {
            systemPromptExtra +=
                "\n\nUSER ANNOTATION CONTEXT (REQUESTED THIS TURN):\nThe latest user message asks you to answer based on, or considering, saved PDF annotations, but no saved annotations are available for the current project documents. State this briefly if it matters, then answer from the documents normally.";
        }
    }
    if (attached_documents?.length) {
        const slugByDocumentId = new Map<string, string>();
        for (const [slug, info] of Object.entries(docIndex)) {
            if (info.document_id)
                slugByDocumentId.set(info.document_id, slug);
        }
        const scopedAttachments = attached_documents.filter((d) =>
            slugByDocumentId.has(d.document_id),
        );
        const lines = scopedAttachments.map((d) => {
            const slug = slugByDocumentId.get(d.document_id);
            return slug ? `- ${slug}: ${d.filename}` : `- ${d.filename}`;
        });
        if (lines.length > 0) {
            systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
        }
    }

    const apiMessages = buildMessages(
        messagesForLLM,
        docAvailability,
        systemPromptExtra,
        docIndex,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

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
            extraTools: projectToolsForCorpus(smallIndexedCorpus),
            workflowStore,
            model,
            apiKeys,
            projectId,
            scopedDocumentIds,
            documentResultMaxChars,
            disabledTools: normalizedDisabledTools,
        });

        const annotations = extractAnnotations(fullText, docIndex, events, citations);
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
    } catch (err) {
        console.error("[project-chat/stream] error:", err);
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
    console.error("[project-chat/stream] prologue threw:", err);
    if (!res.headersSent) {
      res.status(500).json({ detail: "Internal error" });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  }
});
