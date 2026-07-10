import { getDb } from "../../db/sqlite";
import {
  NEIGHBOR_CHUNK_RADIUS,
  RETRIEVAL_TOP_K,
  SNIPPET_TOKEN_WINDOW,
  type SearchResult,
} from "./types";
import {
  dotProductFromBlob,
  embedQueryText,
  expectedDimensionsForSettings,
  readUserEmbeddingSettings,
} from "./embeddings";

function normalizeQuery(query: string): string {
  return query.normalize("NFC").trim().replace(/\s+/g, " ");
}

function toFtsQuery(query: string): string {
  return queryTerms(query)
    .map((term) => `${term}*`)
    .join(" AND ");
}

function queryTerms(query: string): string[] {
  const terms = normalizeQuery(query)
    .replace(/([\p{L}\p{N}_])['’]s\b/giu, "$1")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .filter((term) => !/^[A-Za-z]$/.test(term));
  return Array.from(new Set(terms));
}

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`).replace(/\s+/g, "%");
}

function likePatternFromTerms(terms: string[]): string {
  return `%${terms.map(escapeLikeTerm).join("%")}%`;
}

function firstTermMatchIndex(content: string, terms: string[]): number {
  const lowerContent = content.toLocaleLowerCase();
  for (const term of terms) {
    const index = lowerContent.indexOf(term.toLocaleLowerCase());
    if (index >= 0) return index;
  }
  return 0;
}

function normalizeSnippet(snippet: string | null, content: string): string {
  const value = (snippet || content).replace(/\s+/g, " ").trim();
  return value.length <= 800 ? value : `${value.slice(0, 797)}...`;
}

function normalizeBasicSnippet(content: string, terms: string[]): string {
  const value = content.replace(/\s+/g, " ").trim();
  if (value.length <= 800) return value;
  const matchIndex = firstTermMatchIndex(value, terms);
  const start = Math.max(0, matchIndex - 220);
  const end = Math.min(value.length, start + 800);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < value.length ? "..." : "";
  return `${prefix}${value.slice(start, end)}${suffix}`;
}

const PROJECT_SEARCH_MAX_RESULTS = 200;
const RRF_K = 60;

type MatchReason = NonNullable<SearchResult["match_reasons"]>[number];

type Candidate = {
  row: SearchResult;
  rank: number;
  reason: MatchReason;
  lexicalScore?: number | null;
  semanticScore?: number | null;
};

type TitleCandidateRow = SearchResult & {
  display_name: string | null;
};

const GENERIC_TITLE_TERMS = new Set([
  "agreement",
  "agreements",
  "contract",
  "contracts",
  "copy",
  "doc",
  "docs",
  "document",
  "documents",
  "draft",
  "file",
  "files",
  "final",
  "paper",
  "papers",
  "report",
  "reports",
  "text",
  "version",
  "계약서",
  "문건",
  "문서",
  "보고서",
  "사본",
  "자료",
  "초안",
  "최종",
  "파일",
]);

function candidateLimitForResultLimit(limit: number): number {
  return Math.max(40, Math.min(PROJECT_SEARCH_MAX_RESULTS, limit * 8));
}

function hasCjkOrLongSubstring(query: string): boolean {
  return (
    /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
      query,
    ) || normalizeQuery(query).replace(/\s+/g, "").length >= 3
  );
}

function toTrigramQuery(query: string): string {
  return `"${normalizeQuery(query).replace(/"/g, '""')}"`;
}

function lower(value: string): string {
  return value.toLocaleLowerCase();
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\.[\p{L}\p{N}]{1,10}$/u, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleTerms(value: string): string[] {
  return Array.from(
    new Set(
      normalizeTitle(value)
        .split(" ")
        .filter(Boolean)
        .filter((term) => !GENERIC_TITLE_TERMS.has(term))
        .filter((term) => !/^[a-z]$/i.test(term)),
    ),
  );
}

function titleMatchScore(title: string, query: string): number | null {
  const normalizedTitle = normalizeTitle(title);
  const normalizedSearch = normalizeTitle(query);
  if (!normalizedTitle || !normalizedSearch) return null;

  const distinctiveTerms = titleTerms(title);
  if (distinctiveTerms.length === 0) return null;
  const normalizedTitleTerms = normalizedTitle.split(" ").filter(Boolean);
  if (
    distinctiveTerms.length === 1 &&
    normalizedTitleTerms.length === 1 &&
    normalizedSearch !== normalizedTitle
  ) {
    return null;
  }

  const searchTerms = new Set(normalizedSearch.split(" ").filter(Boolean));
  const matchedTerms = distinctiveTerms.filter((term) => searchTerms.has(term));
  const minimumCoverage =
    distinctiveTerms.length === 1
      ? 1
      : Math.max(2, Math.ceil(distinctiveTerms.length * 0.6));
  if (matchedTerms.length < minimumCoverage) return null;

  if (normalizedSearch === normalizedTitle) return 500;
  const paddedSearch = ` ${normalizedSearch} `;
  const paddedTitle = ` ${normalizedTitle} `;
  if (paddedSearch.includes(paddedTitle)) return 450;
  if (
    normalizedSearch.startsWith(`${normalizedTitle} `) ||
    normalizedTitle.startsWith(`${normalizedSearch} `)
  ) {
    return 400;
  }

  const coverage = matchedTerms.length / distinctiveTerms.length;
  return 200 + coverage * 100 + matchedTerms.length;
}

function hasExactPhrase(row: SearchResult, query: string): boolean {
  return lower(row.content).includes(lower(normalizeQuery(query)));
}

function allTermsPresent(row: SearchResult, terms: string[]): boolean {
  const text = lower(row.content);
  return terms.length > 0 && terms.every((term) => text.includes(lower(term)));
}

function filenameMatches(
  row: SearchResult,
  query: string,
  terms: string[],
): boolean {
  const filename = lower(row.filename);
  return (
    filename.includes(lower(normalizeQuery(query))) ||
    terms.some((term) => filename.includes(lower(term)))
  );
}

function mapSearchRow(row: SearchResult, terms: string[]): SearchResult {
  return {
    ...row,
    page_number: row.page_number ?? null,
    page_end: row.page_end ?? row.page_number ?? null,
    location_hint: row.location_hint ?? null,
    quote: row.quote || row.content,
    snippet: row.basic_match
      ? normalizeBasicSnippet(row.content, terms)
      : normalizeSnippet(row.snippet, row.content),
    basic_match: Boolean(row.basic_match),
  };
}

function rowSelect(snippetExpr: string, scoreExpr: string): string {
  return `
    SELECT
      c.document_id,
      c.version_id,
      c.id AS chunk_id,
      d.filename,
      d.file_type,
      c.chunk_index,
      c.page_number,
      c.page_number AS page_end,
      c.section_path AS location_hint,
      c.content AS quote,
      ${snippetExpr} AS snippet,
      c.content,
      ${scoreExpr} AS score,
      0 AS basic_match
    FROM `;
}

export async function searchProjectIndex(args: {
  projectId: string;
  userId?: string | null;
  query: string;
  limit?: number;
  includeNeighbors?: boolean;
  fileTypes?: string[];
  folderId?: string | null;
  documentIds?: string[];
  group?: "chunks" | "documents";
}): Promise<SearchResult[]> {
  const query = normalizeQuery(args.query);
  if (!query) return [];

  const limit = Math.max(
    1,
    Math.min(args.limit ?? RETRIEVAL_TOP_K, PROJECT_SEARCH_MAX_RESULTS),
  );
  const db = getDb();
  const ftsQuery = toFtsQuery(query);
  const terms = queryTerms(query);
  const candidateLimit = candidateLimitForResultLimit(limit);
  const fileTypes = (args.fileTypes ?? [])
    .map((type) => type.trim().toLowerCase())
    .filter((type) => /^[a-z0-9]+$/.test(type));
  const filterSql: string[] = [];
  const filterValues: unknown[] = [];
  if (fileTypes.length > 0) {
    filterSql.push(
      `AND d.file_type IN (${fileTypes.map(() => "?").join(", ")})`,
    );
    filterValues.push(...fileTypes);
  }
  if (args.folderId) {
    filterSql.push("AND d.folder_id = ?");
    filterValues.push(args.folderId);
  }
  const documentIds = (args.documentIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  if (documentIds.length > 0) {
    filterSql.push(`AND d.id IN (${documentIds.map(() => "?").join(", ")})`);
    filterValues.push(...documentIds);
  }
  const filters = filterSql.length
    ? `\n          ${filterSql.join("\n          ")}`
    : "";

  const candidates: Candidate[] = [];

  if (ftsQuery) {
    const rows = db
      .prepare(
        `
        ${rowSelect(
          "snippet(document_index_chunks_fts, 3, '[[HL]]', '[[/HL]]', '...', ?)",
          "bm25(document_index_chunks_fts)",
        )}
        document_index_chunks_fts
        JOIN document_index_chunks c ON c.id = document_index_chunks_fts.chunk_id
        JOIN documents d ON d.id = c.document_id
        JOIN document_index_files f
          ON f.document_id = c.document_id
         AND f.version_id = c.version_id
         AND f.status IN ('ready', 'indexing')
        WHERE d.project_id = ?
          AND d.current_version_id = c.version_id
          AND document_index_chunks_fts MATCH ?
          ${filters}
        ORDER BY score ASC
        LIMIT ?
      `,
      )
      .all(
        SNIPPET_TOKEN_WINDOW,
        args.projectId,
        ftsQuery,
        ...filterValues,
        candidateLimit,
      ) as SearchResult[];
    rows.forEach((row, index) =>
      candidates.push({
        row: mapSearchRow(row, terms),
        rank: index + 1,
        reason: "keyword",
        lexicalScore: row.score,
      }),
    );
  }

  if (hasCjkOrLongSubstring(query)) {
    try {
      let rows = db
        .prepare(
          `
          ${rowSelect(
            "snippet(document_index_chunks_fts_trigram, 3, '[[HL]]', '[[/HL]]', '...', ?)",
            "bm25(document_index_chunks_fts_trigram)",
          )}
          document_index_chunks_fts_trigram
        JOIN document_index_chunks c ON c.id = document_index_chunks_fts_trigram.chunk_id
        JOIN documents d ON d.id = c.document_id
        JOIN document_index_files f
          ON f.document_id = c.document_id
         AND f.version_id = c.version_id
         AND f.status IN ('ready', 'indexing')
        WHERE d.project_id = ?
          AND d.current_version_id = c.version_id
          AND document_index_chunks_fts_trigram MATCH ?
          ${filters}
        ORDER BY score ASC
        LIMIT ?
      `,
        )
        .all(
          SNIPPET_TOKEN_WINDOW,
          args.projectId,
          toTrigramQuery(query),
          ...filterValues,
          candidateLimit,
        ) as SearchResult[];
      if (rows.length === 0) {
        rows = db
          .prepare(
            `
            ${rowSelect("c.content", "0")}
            document_index_chunks_fts_trigram
          JOIN document_index_chunks c ON c.id = document_index_chunks_fts_trigram.chunk_id
          JOIN documents d ON d.id = c.document_id
          JOIN document_index_files f
            ON f.document_id = c.document_id
           AND f.version_id = c.version_id
           AND f.status IN ('ready', 'indexing')
          WHERE d.project_id = ?
            AND d.current_version_id = c.version_id
            AND document_index_chunks_fts_trigram.content LIKE ? ESCAPE '\\'
            ${filters}
          ORDER BY c.document_id, c.chunk_index
          LIMIT ?
        `,
          )
          .all(
            args.projectId,
            `%${escapeLikeTerm(query)}%`,
            ...filterValues,
            candidateLimit,
          ) as SearchResult[];
      }
      rows.forEach((row, index) =>
        candidates.push({
          row: mapSearchRow(row, terms),
          rank: index + 1,
          reason: "substring",
          lexicalScore: row.score,
        }),
      );
    } catch {
      // Malformed trigram MATCH syntax should not block unicode FTS results.
    }
  }

  candidates.push(
    ...titleSearchCandidates({
      projectId: args.projectId,
      query,
      limit: candidateLimit,
      filters,
      filterValues,
      terms,
    }),
  );

  const semanticCandidates = await semanticSearchCandidates({
    projectId: args.projectId,
    userId: args.userId,
    query,
    limit: candidateLimit,
    filters,
    filterValues,
  });
  candidates.push(...semanticCandidates);

  let rows = mergeCandidates(candidates, query, terms);
  if (args.group === "documents") {
    rows = aggregateDocumentResults(rows).slice(0, limit);
  } else {
    rows = rows.slice(0, limit);
  }

  if (rows.length === 0 && terms.length > 0) {
    const fallbackLimit = args.group === "documents" ? candidateLimit : limit;
    rows = (
      db
        .prepare(
          `
        SELECT
          c.document_id,
          c.version_id,
          c.id AS chunk_id,
          d.filename,
          d.file_type,
          c.chunk_index,
          c.page_number,
          c.page_number AS page_end,
          c.section_path AS location_hint,
          c.content AS quote,
          c.content AS snippet,
          c.content,
          0 AS score,
          1 AS basic_match
        FROM document_index_chunks c
        JOIN documents d ON d.id = c.document_id
        JOIN document_index_files f
          ON f.document_id = c.document_id
         AND f.version_id = c.version_id
         AND f.status IN ('ready', 'indexing')
        WHERE d.project_id = ?
          AND d.current_version_id = c.version_id
          AND c.content LIKE ? ESCAPE '\\'
          ${filters}
        ORDER BY c.document_id, c.chunk_index
        LIMIT ?
      `,
        )
        .all(
          args.projectId,
          likePatternFromTerms(terms),
          ...filterValues,
          fallbackLimit,
        ) as SearchResult[]
    ).map((row) => ({
      ...mapSearchRow(row, terms),
      rank_score: 0,
      lexical_score: null,
      semantic_score: null,
      match_reasons: ["basic"],
    }));
    if (args.group === "documents") {
      rows = aggregateDocumentResults(rows).slice(0, limit);
    }
  }

  if (
    !args.includeNeighbors ||
    rows.length === 0 ||
    args.group === "documents"
  ) {
    return rows;
  }
  return withNeighborChunks(args.projectId, rows, limit);
}

function titleSearchCandidates(args: {
  projectId: string;
  query: string;
  limit: number;
  filters: string;
  filterValues: unknown[];
  terms: string[];
}): Candidate[] {
  const rows = getDb()
    .prepare(
      `
      SELECT
        c.document_id,
        c.version_id,
        c.id AS chunk_id,
        d.filename,
        d.file_type,
        v.display_name,
        c.chunk_index,
        c.page_number,
        c.page_number AS page_end,
        c.section_path AS location_hint,
        c.content AS quote,
        c.content AS snippet,
        c.content,
        0 AS score,
        0 AS basic_match
      FROM documents d
      JOIN document_versions v
        ON v.id = d.current_version_id
       AND v.document_id = d.id
      JOIN document_index_files f
        ON f.document_id = d.id
       AND f.version_id = v.id
       AND f.status IN ('ready', 'indexing')
      JOIN document_index_chunks c
        ON c.id = (
          SELECT representative.id
          FROM document_index_chunks representative
          WHERE representative.document_id = d.id
            AND representative.version_id = v.id
          ORDER BY representative.chunk_index
          LIMIT 1
        )
      WHERE d.project_id = ?
        ${args.filters}
    `,
    )
    .all(args.projectId, ...args.filterValues) as TitleCandidateRow[];

  return rows
    .map((row) => {
      const scores = [
        titleMatchScore(row.filename, args.query),
        row.display_name ? titleMatchScore(row.display_name, args.query) : null,
      ].filter((score): score is number => score != null);
      return {
        row,
        titleScore: scores.length > 0 ? Math.max(...scores) : null,
      };
    })
    .filter(
      (entry): entry is { row: TitleCandidateRow; titleScore: number } =>
        entry.titleScore != null,
    )
    .sort(
      (a, b) =>
        b.titleScore - a.titleScore ||
        a.row.filename.localeCompare(b.row.filename),
    )
    .slice(0, args.limit)
    .map((entry, index) => ({
      row: mapSearchRow(entry.row, args.terms),
      rank: index + 1,
      reason: "filename" as const,
    }));
}

function mergeCandidates(
  candidates: Candidate[],
  query: string,
  terms: string[],
): SearchResult[] {
  const byChunk = new Map<
    string,
    {
      row: SearchResult;
      rankScore: number;
      reasons: Set<MatchReason>;
      lexicalScore: number | null;
      semanticScore: number | null;
    }
  >();

  for (const candidate of candidates) {
    const current = byChunk.get(candidate.row.chunk_id) ?? {
      row: candidate.row,
      rankScore: 0,
      reasons: new Set<MatchReason>(),
      lexicalScore: null,
      semanticScore: null,
    };
    current.rankScore += 1 / (RRF_K + candidate.rank);
    current.reasons.add(candidate.reason);
    if (
      candidate.lexicalScore != null &&
      (current.lexicalScore == null ||
        candidate.lexicalScore < current.lexicalScore)
    ) {
      current.lexicalScore = candidate.lexicalScore;
    }
    if (
      candidate.semanticScore != null &&
      (current.semanticScore == null ||
        candidate.semanticScore > current.semanticScore)
    ) {
      current.semanticScore = candidate.semanticScore;
    }
    byChunk.set(candidate.row.chunk_id, current);
  }

  return Array.from(byChunk.values())
    .map((entry) => {
      let rankScore = entry.rankScore;
      if (hasExactPhrase(entry.row, query)) {
        entry.reasons.add("exact");
        rankScore += 0.03;
      }
      if (allTermsPresent(entry.row, terms)) rankScore += 0.01;
      if (filenameMatches(entry.row, query, terms)) {
        entry.reasons.add("filename");
        rankScore += 0.005;
      }
      return {
        ...entry.row,
        rank_score: rankScore,
        lexical_score: entry.lexicalScore,
        semantic_score: entry.semanticScore,
        match_reasons: Array.from(entry.reasons),
        basic_match: false,
      };
    })
    .sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0));
}

async function semanticSearchCandidates(args: {
  projectId: string;
  userId?: string | null;
  query: string;
  limit: number;
  filters: string;
  filterValues: unknown[];
}): Promise<Candidate[]> {
  const settings = readUserEmbeddingSettings(args.userId);
  if (!settings.enabled) return [];
  const db = getDb();
  const preferredDimensions = expectedDimensionsForSettings(settings);
  const dimRow = db
    .prepare(
      `
      SELECT v.dimensions, COUNT(*) AS count
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      JOIN document_index_files f
        ON f.document_id = c.document_id
       AND f.version_id = c.version_id
       AND f.status IN ('ready', 'indexing')
      WHERE d.project_id = ?
        AND d.current_version_id = c.version_id
        AND v.provider = ?
        AND v.model_id = ?
        AND v.status = 'ready'
        AND v.embedding_blob IS NOT NULL
        AND (? = 0 OR v.dimensions = ?)
        ${args.filters}
      GROUP BY v.dimensions
      ORDER BY count DESC
      LIMIT 1
    `,
    )
    .get(
      args.projectId,
      settings.provider,
      settings.model,
      preferredDimensions,
      preferredDimensions,
      ...args.filterValues,
    ) as { dimensions: number; count: number } | undefined;
  if (!dimRow) return [];

  let queryVector: number[];
  try {
    const embedded = await embedQueryText(args.query, {
      ...settings,
      dimensionsPolicy:
        dimRow.dimensions === 256
          ? "truncate-to-256"
          : dimRow.dimensions === 512
            ? "truncate-to-512"
            : settings.dimensionsPolicy,
    });
    queryVector = embedded.vector;
  } catch {
    return [];
  }

  // Score pass streams only chunk ids + vectors and keeps a bounded top-k,
  // so chunk text never loads for non-candidates. Display columns are then
  // hydrated for the winning chunks only. Ranking is identical to scoring
  // every row in memory (exact dot products, no approximation).
  const queryF32 = Float32Array.from(queryVector);
  const cap = Math.max(1, args.limit);
  const topScores: { chunk_id: string; score: number }[] = [];
  let threshold = -Infinity;
  const scoredRows = db
    .prepare(
      `
      SELECT c.id AS chunk_id, v.embedding_blob
      FROM document_index_vectors v
      JOIN document_index_chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
      JOIN document_index_files f
        ON f.document_id = c.document_id
       AND f.version_id = c.version_id
       AND f.status IN ('ready', 'indexing')
      WHERE d.project_id = ?
        AND d.current_version_id = c.version_id
        AND v.provider = ?
        AND v.model_id = ?
        AND v.dimensions = ?
        AND v.status = 'ready'
        AND v.embedding_blob IS NOT NULL
        ${args.filters}
    `,
    )
    .iterate(
      args.projectId,
      settings.provider,
      settings.model,
      dimRow.dimensions,
      ...args.filterValues,
    ) as IterableIterator<{ chunk_id: string; embedding_blob: Buffer }>;
  for (const scored of scoredRows) {
    const score = dotProductFromBlob(queryF32, scored.embedding_blob);
    if (topScores.length >= cap && score <= threshold) continue;
    topScores.push({ chunk_id: scored.chunk_id, score });
    if (topScores.length >= cap * 2) {
      topScores.sort((a, b) => b.score - a.score);
      topScores.length = cap;
      threshold = topScores[cap - 1].score;
    }
  }
  topScores.sort((a, b) => b.score - a.score);
  const top = topScores.slice(0, cap);
  if (top.length === 0) return [];

  const scoreByChunkId = new Map(
    top.map((entry) => [entry.chunk_id, entry.score]),
  );
  const rows = db
    .prepare(
      `
      SELECT
        c.document_id,
        c.version_id,
        c.id AS chunk_id,
        d.filename,
        d.file_type,
        c.chunk_index,
        c.page_number,
        c.page_number AS page_end,
        c.section_path AS location_hint,
        c.content AS quote,
        c.content AS snippet,
        c.content,
        0 AS score,
        0 AS basic_match
      FROM document_index_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.id IN (${top.map(() => "?").join(", ")})
    `,
    )
    .all(...top.map((entry) => entry.chunk_id)) as SearchResult[];

  const terms = queryTerms(args.query);
  return rows
    .map((row) => ({
      row: mapSearchRow(row, terms),
      score: scoreByChunkId.get(row.chunk_id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry, index) => ({
      row: entry.row,
      rank: index + 1,
      reason: "semantic" as const,
      semanticScore: entry.score,
    }));
}

function aggregateDocumentResults(rows: SearchResult[]): SearchResult[] {
  const byDoc = new Map<string, SearchResult>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.document_id, (counts.get(row.document_id) ?? 0) + 1);
    const current = byDoc.get(row.document_id);
    if (!current || (row.rank_score ?? 0) > (current.rank_score ?? 0)) {
      byDoc.set(row.document_id, row);
    }
  }
  return Array.from(byDoc.values())
    .map((row) => {
      const count = counts.get(row.document_id) ?? 1;
      return {
        ...row,
        grouped_chunk_count: count,
        rank_score: (row.rank_score ?? 0) + Math.min(0.05, (count - 1) * 0.01),
      };
    })
    .sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0));
}

function withNeighborChunks(
  projectId: string,
  matches: SearchResult[],
  limit: number,
): SearchResult[] {
  const db = getDb();
  const out: SearchResult[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const rows = db
      .prepare(
        `
        SELECT
          c.document_id,
          c.version_id,
          c.id AS chunk_id,
          d.filename,
          d.file_type,
          c.chunk_index,
          c.page_number,
          c.page_number AS page_end,
          c.section_path AS location_hint,
          c.content AS quote,
          c.content AS snippet,
          c.content,
          ? AS score,
          1 AS basic_match
        FROM document_index_chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.project_id = ?
          AND c.document_id = ?
          AND c.version_id = ?
          AND c.chunk_index BETWEEN ? AND ?
        ORDER BY c.chunk_index
      `,
      )
      .all(
        match.score,
        projectId,
        match.document_id,
        match.version_id,
        match.chunk_index - NEIGHBOR_CHUNK_RADIUS,
        match.chunk_index + NEIGHBOR_CHUNK_RADIUS,
      ) as SearchResult[];

    for (const row of rows) {
      if (seen.has(row.chunk_id)) continue;
      seen.add(row.chunk_id);
      out.push({
        ...row,
        page_number: row.page_number ?? null,
        page_end: row.page_end ?? row.page_number ?? null,
        location_hint: row.location_hint ?? null,
        quote: row.quote || row.content,
        snippet: normalizeSnippet(row.snippet, row.content),
        basic_match:
          row.chunk_id !== match.chunk_id || Boolean(row.basic_match),
      });
    }
    if (out.length >= limit * (NEIGHBOR_CHUNK_RADIUS * 2 + 1)) break;
  }

  return out;
}

export function readProjectIndexChunk(args: {
  projectId: string;
  documentId: string;
  versionId: string;
  chunkIndex: number;
  neighbors?: number;
}): SearchResult[] {
  const radius = Math.max(
    0,
    Math.min(args.neighbors ?? NEIGHBOR_CHUNK_RADIUS, 5),
  );
  const rows = getDb()
    .prepare(
      `
      SELECT
        c.document_id,
        c.version_id,
        c.id AS chunk_id,
        d.filename,
        d.file_type,
        c.chunk_index,
        c.page_number,
        c.page_number AS page_end,
        c.section_path AS location_hint,
        c.content AS quote,
        c.content AS snippet,
        c.content,
        0 AS score,
        0 AS basic_match
      FROM document_index_chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN document_index_files f
        ON f.document_id = c.document_id
       AND f.version_id = c.version_id
       AND f.status IN ('ready', 'indexing')
      WHERE d.project_id = ?
        AND d.current_version_id = c.version_id
        AND c.document_id = ?
        AND c.version_id = ?
        AND c.chunk_index BETWEEN ? AND ?
      ORDER BY c.chunk_index
    `,
    )
    .all(
      args.projectId,
      args.documentId,
      args.versionId,
      args.chunkIndex - radius,
      args.chunkIndex + radius,
    ) as SearchResult[];

  return rows.map((row) => ({
    ...row,
    page_number: row.page_number ?? null,
    page_end: row.page_end ?? row.page_number ?? null,
    location_hint: row.location_hint ?? null,
    quote: row.quote || row.content,
    snippet: normalizeSnippet(row.snippet, row.content),
    basic_match: Boolean(row.basic_match),
  }));
}

export function listProjectIndexGaps(
  projectId: string,
  options?: { documentIds?: string[] },
): {
  document_id: string;
  version_id: string | null;
  filename: string;
  file_type: string | null;
}[] {
  const documentIds = (options?.documentIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const documentFilter = documentIds.length
    ? `AND d.id IN (${documentIds.map(() => "?").join(", ")})`
    : "";
  return getDb()
    .prepare(
      `
      SELECT d.id AS document_id,
             d.current_version_id AS version_id,
             d.filename,
             d.file_type
      FROM documents d
      LEFT JOIN document_index_files f
        ON f.document_id = d.id
       AND f.version_id = d.current_version_id
       AND f.status = 'ready'
      WHERE d.project_id = ?
        AND d.status = 'ready'
        AND d.current_version_id IS NOT NULL
        AND f.id IS NULL
        ${documentFilter}
      ORDER BY d.created_at ASC
    `,
    )
    .all(projectId, ...documentIds) as {
    document_id: string;
    version_id: string | null;
    filename: string;
    file_type: string | null;
  }[];
}

export function getProjectIndexCorpusStats(
  projectId: string,
  options?: { documentIds?: string[] },
): {
  ready_documents: number;
  text_bytes: number;
  total_documents: number;
} {
  const documentIds = (options?.documentIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const documentFilter = documentIds.length
    ? `AND d.id IN (${documentIds.map(() => "?").join(", ")})`
    : "";
  const row = getDb()
    .prepare(
      `
      SELECT
        COUNT(d.id) AS total_documents,
        COALESCE(SUM(CASE WHEN f.status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_documents,
        COALESCE(SUM(CASE WHEN f.status = 'ready' THEN f.text_bytes ELSE 0 END), 0) AS text_bytes
      FROM documents d
      LEFT JOIN document_index_files f
        ON f.document_id = d.id
       AND f.version_id = d.current_version_id
      WHERE d.project_id = ?
        AND d.status = 'ready'
        ${documentFilter}
    `,
    )
    .get(projectId, ...documentIds) as {
    ready_documents: number;
    text_bytes: number;
    total_documents: number;
  };
  return row;
}
