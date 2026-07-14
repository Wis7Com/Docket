import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { checkProjectAccess, ensureReviewAccess } from "../lib/access";
import {
  buildProjectDocContext,
  validateCitationContract,
  validateCitationEvidence,
} from "../lib/chatTools";
import { searchProjectIndex } from "../lib/indexing/search";
import { completeText } from "../lib/llm";
import { createServerSupabase } from "../lib/supabase";
import { getUserModelSettings } from "../lib/userSettings";
import { validateSourceBackedDocuments } from "./tabular";

export const MAX_ISSUES = 40;
export const IM_GENERATE_CONCURRENCY = 4;

export type IssueMatrixSide = {
  label: string;
  doc_ids: string[];
};

export type IssueMatrixScope = {
  sides: IssueMatrixSide[];
  excluded_doc_ids: string[];
};

export type IssueMatrixIssue = {
  index: number;
  title: string;
  summary: string;
};

export type IssueMatrixCellTask = {
  issue_index: number;
  side_label: string;
};

type IssueMatrixCellRow = IssueMatrixCellTask & {
  id?: string;
  status?: string;
  content?: string | null;
};

type ScopeSelector = {
  label?: unknown;
  doc_ids?: unknown;
  party_roles?: unknown;
  party_sides?: unknown;
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** Validate the normalized, persisted scope (selectors must already be resolved). */
export function validateIssueMatrixScope(value: unknown): IssueMatrixScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scope must be an object");
  }
  const raw = value as { sides?: unknown; excluded_doc_ids?: unknown };
  if (!Array.isArray(raw.sides) || raw.sides.length < 2) {
    throw new Error("scope.sides must contain at least two sides");
  }
  const seenLabels = new Set<string>();
  const seenDocuments = new Set<string>();
  const sides = raw.sides.map((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error(`scope.sides[${index}] must be an object`);
    }
    const side = candidate as { label?: unknown; doc_ids?: unknown };
    const label = typeof side.label === "string" ? side.label.trim() : "";
    if (!label) throw new Error(`scope.sides[${index}].label is required`);
    const labelKey = label.toLocaleLowerCase();
    if (seenLabels.has(labelKey))
      throw new Error(`Duplicate side label: ${label}`);
    seenLabels.add(labelKey);
    if (!Array.isArray(side.doc_ids)) {
      throw new Error(`scope.sides[${index}].doc_ids must be an array`);
    }
    const docIds = stringArray(side.doc_ids);
    if (docIds.length === 0) {
      throw new Error(`scope.sides[${index}].doc_ids must not be empty`);
    }
    for (const documentId of docIds) {
      if (seenDocuments.has(documentId)) {
        throw new Error(
          `Document appears in more than one side: ${documentId}`,
        );
      }
      seenDocuments.add(documentId);
    }
    return { label, doc_ids: docIds };
  });
  return {
    sides,
    excluded_doc_ids: stringArray(raw.excluded_doc_ids),
  };
}

export function clampIssues(value: unknown): IssueMatrixIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: IssueMatrixIssue[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as { title?: unknown; summary?: unknown };
    const title =
      typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (!title) continue;
    issues.push({
      index: issues.length,
      title,
      summary:
        typeof candidate.summary === "string" ? candidate.summary.trim() : "",
    });
    if (issues.length === MAX_ISSUES) break;
  }
  return issues;
}

export function cellsToProcess(
  tasks: IssueMatrixCellTask[],
  cells: IssueMatrixCellRow[],
): IssueMatrixCellTask[] {
  const existing = new Map(
    cells.map((cell) => [`${cell.issue_index}:${cell.side_label}`, cell]),
  );
  return tasks.filter((task) => {
    const cell = existing.get(`${task.issue_index}:${task.side_label}`);
    return !(cell?.status === "done" && cell.content);
  });
}

function sseLine(payload: unknown): string {
  return payload === "[DONE]"
    ? "data: [DONE]\n\n"
    : `data: ${JSON.stringify(payload)}\n\n`;
}

export function buildIssueMatrixSseEvents(
  issues: IssueMatrixIssue[],
  cells: Array<
    IssueMatrixCellTask & { content?: string | null; status: string }
  >,
): string[] {
  return [
    sseLine({ type: "issue_update", issues }),
    ...cells.map((cell) => sseLine({ type: "cell_update", ...cell })),
    sseLine("[DONE]"),
  ];
}

function parseJsonResponse(raw: string): unknown {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await worker(values[index]);
      }
    }),
  );
}

async function resolveScope(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  value: unknown,
): Promise<IssueMatrixScope> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scope must be an object");
  }
  const raw = value as { sides?: unknown; excluded_doc_ids?: unknown };
  if (!Array.isArray(raw.sides) || raw.sides.length < 2) {
    throw new Error("scope.sides must contain at least two sides");
  }
  const excludedDocIds = stringArray(raw.excluded_doc_ids);
  const excluded = new Set(excludedDocIds);
  const { data: candidates, error } = await db
    .from("documents")
    .select("id, status, doc_role, party_role, party_side")
    .eq("project_id", projectId)
    .eq("status", "ready");
  if (error) throw new Error(error.message);

  const resolvedSides: IssueMatrixSide[] = [];
  for (const [index, candidate] of raw.sides.entries()) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error(`scope.sides[${index}] must be an object`);
    }
    const selector = candidate as ScopeSelector;
    const label =
      typeof selector.label === "string" ? selector.label.trim() : "";
    const explicitIds = stringArray(selector.doc_ids);
    const partyRoles = new Set(stringArray(selector.party_roles));
    const partySides = new Set(
      stringArray(selector.party_sides).map((side) => side.toUpperCase()),
    );
    let documentIds = explicitIds;
    if (documentIds.length === 0 && (partyRoles.size || partySides.size)) {
      documentIds = (candidates ?? [])
        .filter((document) => document.doc_role === "brief")
        .filter(
          (document) =>
            (!partyRoles.size || partyRoles.has(document.party_role)) &&
            (!partySides.size || partySides.has(document.party_side)),
        )
        .map((document) => document.id);
    }
    documentIds = documentIds.filter((id) => !excluded.has(id));
    resolvedSides.push({ label, doc_ids: documentIds });
  }
  const normalized = validateIssueMatrixScope({
    sides: resolvedSides,
    excluded_doc_ids: excludedDocIds,
  });
  await Promise.all(
    normalized.sides.map((side) =>
      validateSourceBackedDocuments(db, projectId, side.doc_ids),
    ),
  );
  return normalized;
}

function routeProjectId(req: { params: Record<string, string> }): string {
  return req.params.projectId;
}

async function loadMatrix(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  matrixId: string,
) {
  const { data } = await db
    .from("issue_matrices")
    .select("*")
    .eq("id", matrixId)
    .eq("project_id", projectId)
    .single();
  return data;
}

export const issueMatrixRouter = Router({ mergeParams: true });

issueMatrixRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const projectId = routeProjectId(req);
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    const { data: matrices, error } = await db
      .from("issue_matrices")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const ids = (matrices ?? []).map((matrix) => matrix.id);
    const { data: cells } = ids.length
      ? await db
          .from("issue_matrix_cells")
          .select("matrix_id")
          .in("matrix_id", ids)
      : { data: [] as { matrix_id: string }[] };
    const counts = new Map<string, number>();
    for (const cell of cells ?? []) {
      counts.set(cell.matrix_id, (counts.get(cell.matrix_id) ?? 0) + 1);
    }
    res.json(
      (matrices ?? []).map((matrix) => ({
        ...matrix,
        cell_count: counts.get(matrix.id) ?? 0,
      })),
    );
  } catch (error) {
    res.status(500).json({
      detail:
        error instanceof Error
          ? error.message
          : "Failed to list issue matrices",
    });
  }
});

issueMatrixRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const projectId = routeProjectId(req);
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  let scope: IssueMatrixScope;
  try {
    scope = await resolveScope(db, projectId, req.body?.scope);
  } catch (error) {
    return void res.status(400).json({ detail: (error as Error).message });
  }
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : null;
  const { data: matrix, error } = await db
    .from("issue_matrices")
    .insert({
      project_id: projectId,
      user_id: userId,
      title: title || null,
      scope,
      issues: [],
      status: "pending",
    })
    .select("*")
    .single();
  if (error || !matrix) {
    return void res
      .status(500)
      .json({ detail: error?.message ?? "Failed to create issue matrix" });
  }
  res.status(201).json(matrix);
});

issueMatrixRouter.get("/:matrixId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const projectId = routeProjectId(req);
  const db = createServerSupabase();
  const matrix = await loadMatrix(db, projectId, req.params.matrixId);
  if (!matrix)
    return void res.status(404).json({ detail: "Issue matrix not found" });
  const access = await ensureReviewAccess(matrix, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Issue matrix not found" });
  const { data: cells, error } = await db
    .from("issue_matrix_cells")
    .select("*")
    .eq("matrix_id", matrix.id)
    .order("issue_index", { ascending: true })
    .order("side_label", { ascending: true });
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({
    matrix: { ...matrix, is_owner: access.isOwner },
    cells: cells ?? [],
  });
});

issueMatrixRouter.patch("/:matrixId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const projectId = routeProjectId(req);
  const db = createServerSupabase();
  const matrix = await loadMatrix(db, projectId, req.params.matrixId);
  if (!matrix)
    return void res.status(404).json({ detail: "Issue matrix not found" });
  const access = await ensureReviewAccess(matrix, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Issue matrix not found" });
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (req.body?.title !== undefined) {
    updates.title =
      typeof req.body.title === "string" ? req.body.title.trim() || null : null;
  }
  if (req.body?.scope !== undefined) {
    try {
      updates.scope = await resolveScope(db, projectId, req.body.scope);
    } catch (error) {
      return void res.status(400).json({ detail: (error as Error).message });
    }
  }
  const { data, error } = await db
    .from("issue_matrices")
    .update(updates)
    .eq("id", matrix.id)
    .select("*")
    .single();
  if (error || !data)
    return void res
      .status(500)
      .json({ detail: error?.message ?? "Update failed" });
  res.json(data);
});

issueMatrixRouter.post(
  "/:matrixId/clear-cells",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const projectId = routeProjectId(req);
    const db = createServerSupabase();
    const matrix = await loadMatrix(db, projectId, req.params.matrixId);
    if (!matrix)
      return void res.status(404).json({ detail: "Issue matrix not found" });
    const access = await ensureReviewAccess(matrix, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Issue matrix not found" });
    let query = db
      .from("issue_matrix_cells")
      .update({ content: null, citations: [], status: "pending" })
      .eq("matrix_id", matrix.id);
    const issueIndexes = Array.isArray(req.body?.issue_indices)
      ? req.body.issue_indices.filter((value: unknown) =>
          Number.isInteger(value),
        )
      : [];
    const sideLabels = stringArray(req.body?.side_labels);
    if (issueIndexes.length) query = query.in("issue_index", issueIndexes);
    if (sideLabels.length) query = query.in("side_label", sideLabels);
    const { error } = await query;
    if (error) return void res.status(500).json({ detail: error.message });
    await db
      .from("issue_matrices")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", matrix.id);
    res.status(204).send();
  },
);

issueMatrixRouter.delete("/:matrixId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const projectId = routeProjectId(req);
  const db = createServerSupabase();
  const matrix = await loadMatrix(db, projectId, req.params.matrixId);
  if (!matrix)
    return void res.status(404).json({ detail: "Issue matrix not found" });
  const access = await ensureReviewAccess(matrix, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Issue matrix not found" });
  const { error } = await db
    .from("issue_matrices")
    .delete()
    .eq("id", matrix.id);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

issueMatrixRouter.post("/:matrixId/generate", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const projectId = routeProjectId(req);
  const db = createServerSupabase();
  const matrix = await loadMatrix(db, projectId, req.params.matrixId);
  if (!matrix)
    return void res.status(404).json({ detail: "Issue matrix not found" });
  const access = await ensureReviewAccess(matrix, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Issue matrix not found" });

  let scope: IssueMatrixScope;
  try {
    scope = validateIssueMatrixScope(matrix.scope);
  } catch (error) {
    return void res.status(400).json({ detail: (error as Error).message });
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const write = (payload: unknown) => res.write(sseLine(payload));

  try {
    const { tabular_model: model, api_keys: apiKeys } =
      await getUserModelSettings(userId, db);
    await db
      .from("issue_matrices")
      .update({
        status: "generating",
        model,
        updated_at: new Date().toISOString(),
      })
      .eq("id", matrix.id);
    const projectContext = await buildProjectDocContext(projectId, userId, db);
    const scopedDocumentIds = new Set(
      scope.sides.flatMap((side) => side.doc_ids),
    );
    const docIndex = Object.fromEntries(
      Object.entries(projectContext.docIndex).filter(([, info]) =>
        scopedDocumentIds.has(info.document_id),
      ),
    );

    let issues = clampIssues(matrix.issues);
    if (issues.length === 0) {
      const { data: chunkRows, error: chunkError } = await db
        .from("document_index_chunks")
        .select(
          "document_id, version_id, chunk_index, page_number, section_path, content",
        )
        .in("document_id", [...scopedDocumentIds])
        .order("chunk_index", { ascending: true })
        .limit(160);
      if (chunkError) throw new Error(chunkError.message);
      const perDocument = new Map<string, number>();
      const currentVersionByDocument = new Map(
        Object.values(docIndex).map((info) => [
          info.document_id,
          info.version_id ?? null,
        ]),
      );
      const introductions = (chunkRows ?? [])
        .filter((chunk) => {
          const currentVersion = currentVersionByDocument.get(
            chunk.document_id,
          );
          return !currentVersion || chunk.version_id === currentVersion;
        })
        .filter((chunk) => {
          const count = perDocument.get(chunk.document_id) ?? 0;
          if (count >= 4) return false;
          perDocument.set(chunk.document_id, count + 1);
          return true;
        });
      if (!introductions.length)
        throw new Error("No indexed brief text is available");
      const discovery = await completeText({
        model,
        systemPrompt: `Identify the disputed legal and factual issues across the parties' briefs. Return only JSON: {"issues":[{"title":string,"summary":string}]}. Merge duplicates, use neutral issue names, and return at most ${MAX_ISSUES} issues.`,
        user: `Judge-defined sides:\n${scope.sides
          .map((side) => `- ${side.label}: ${side.doc_ids.join(", ")}`)
          .join("\n")}\n\nOpening indexed brief excerpts:\n${introductions
          .map(
            (chunk) =>
              `[document_id=${chunk.document_id} page=${chunk.page_number ?? "?"} section=${chunk.section_path ?? ""}]\n${String(chunk.content).slice(0, 2400)}`,
          )
          .join("\n\n")}`,
        maxTokens: 4096,
        apiKeys,
      });
      const parsed = parseJsonResponse(discovery) as { issues?: unknown };
      issues = clampIssues(parsed.issues);
      if (!issues.length)
        throw new Error("Issue discovery returned no valid issues");
      const { error: issueError } = await db
        .from("issue_matrices")
        .update({ issues, updated_at: new Date().toISOString() })
        .eq("id", matrix.id);
      if (issueError) throw new Error(issueError.message);
    }
    write({ type: "issue_update", issues });

    const { data: existingCells, error: cellsError } = await db
      .from("issue_matrix_cells")
      .select("*")
      .eq("matrix_id", matrix.id);
    if (cellsError) throw new Error(cellsError.message);
    const sideByLabel = new Map(scope.sides.map((side) => [side.label, side]));
    const issueByIndex = new Map(issues.map((issue) => [issue.index, issue]));
    const allTasks = issues.flatMap((issue) =>
      scope.sides.map((side) => ({
        issue_index: issue.index,
        side_label: side.label,
      })),
    );
    const pendingTasks = cellsToProcess(allTasks, existingCells ?? []);

    await mapWithConcurrency(
      pendingTasks,
      IM_GENERATE_CONCURRENCY,
      async (task) => {
        const issue = issueByIndex.get(task.issue_index)!;
        const side = sideByLabel.get(task.side_label)!;
        await db.from("issue_matrix_cells").upsert(
          {
            matrix_id: matrix.id,
            issue_index: task.issue_index,
            side_label: task.side_label,
            content: null,
            citations: [],
            status: "generating",
          },
          { onConflict: "matrix_id,issue_index,side_label" },
        );
        write({
          type: "cell_update",
          ...task,
          content: null,
          citations: [],
          status: "generating",
        });
        try {
          const hits = await searchProjectIndex({
            projectId,
            userId,
            query: `${issue.title} ${issue.summary}`.trim(),
            limit: 10,
            documentIds: side.doc_ids,
            docRoles: ["brief"],
          });
          if (!hits.length)
            throw new Error(
              "No indexed evidence found for this issue and side",
            );
          const raw = await completeText({
            model,
            systemPrompt:
              'Analyze only the supplied indexed excerpts. Return only JSON: {"position":string,"citations":[{"chunk_id":string,"page":number,"quote":string}]}. Every material proposition in position must be supported by short verbatim quotes copied from the excerpts. Do not invent chunk IDs or quotes.',
            user: `Issue: ${issue.title}\nIssue summary: ${issue.summary}\nSide: ${side.label}\n\nIndexed excerpts:\n${hits
              .map(
                (hit) =>
                  `[chunk_id=${hit.chunk_id} document_id=${hit.document_id} page=${hit.page_number ?? "?"}]\n${hit.content}`,
              )
              .join("\n\n")}`,
            maxTokens: 3072,
            apiKeys,
          });
          const parsed = parseJsonResponse(raw) as {
            position?: unknown;
            citations?: unknown;
          };
          const position =
            typeof parsed.position === "string" ? parsed.position.trim() : "";
          const rawCitations = Array.isArray(parsed.citations)
            ? parsed.citations.filter(
                (citation): citation is Record<string, unknown> =>
                  !!citation &&
                  typeof citation === "object" &&
                  !Array.isArray(citation),
              )
            : [];
          if (!position || !rawCitations.length) {
            throw new Error(
              "Cell synthesis returned no source-backed position",
            );
          }
          const hitByChunk = new Map(hits.map((hit) => [hit.chunk_id, hit]));
          const labelByDocumentId = new Map(
            Object.entries(docIndex).map(([label, info]) => [
              info.document_id,
              label,
            ]),
          );
          const candidates = rawCitations.map((citation, index) => {
            const chunkId =
              typeof citation.chunk_id === "string" ? citation.chunk_id : "";
            const hit = hitByChunk.get(chunkId);
            const docLabel = hit
              ? labelByDocumentId.get(hit.document_id)
              : undefined;
            return {
              ref: index + 1,
              doc_id: docLabel ?? "",
              page:
                typeof citation.page === "number"
                  ? citation.page
                  : (hit?.page_number ?? 1),
              quote: typeof citation.quote === "string" ? citation.quote : "",
              chunk_id: chunkId,
            };
          });
          const citationText = `${position}\n${candidates
            .map((citation) => `[${citation.ref}]`)
            .join(" ")}`;
          const contract = validateCitationContract(
            citationText,
            candidates,
            docIndex,
          );
          const evidence = validateCitationEvidence(
            contract.citations,
            docIndex,
          );
          if (
            contract.errors.length ||
            evidence.errors.length ||
            evidence.citations.length !== candidates.length
          ) {
            throw new Error("Cell citations failed source verification");
          }
          const citations = evidence.citations.map((citation) => ({
            doc_id: citation.doc_id,
            document_id: docIndex[citation.doc_id].document_id,
            page: citation.page,
            quote: citation.quote,
            chunk_id: citation.chunk_id,
          }));
          const { error: updateError } = await db
            .from("issue_matrix_cells")
            .update({ content: position, citations, status: "done" })
            .eq("matrix_id", matrix.id)
            .eq("issue_index", task.issue_index)
            .eq("side_label", task.side_label);
          if (updateError) throw new Error(updateError.message);
          write({
            type: "cell_update",
            ...task,
            content: position,
            citations,
            status: "done",
          });
        } catch (error) {
          await db
            .from("issue_matrix_cells")
            .update({ content: null, citations: [], status: "error" })
            .eq("matrix_id", matrix.id)
            .eq("issue_index", task.issue_index)
            .eq("side_label", task.side_label);
          write({
            type: "cell_update",
            ...task,
            content: null,
            citations: [],
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    await db
      .from("issue_matrices")
      .update({ status: "ready", updated_at: new Date().toISOString() })
      .eq("id", matrix.id);
    write("[DONE]");
  } catch (error) {
    await db
      .from("issue_matrices")
      .update({ status: "error", updated_at: new Date().toISOString() })
      .eq("id", matrix.id);
    write({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    write("[DONE]");
  } finally {
    res.end();
  }
});
