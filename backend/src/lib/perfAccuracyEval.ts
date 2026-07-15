import { z } from "zod";

const nonEmptyStringSchema = z.string().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeDurationSchema = z.number().finite().nonnegative();

export const qaEvaluationItemSchema = z
  .object({
    id: nonEmptyStringSchema.optional(),
    question: nonEmptyStringSchema,
    expected_answer_gist: nonEmptyStringSchema,
    gold_doc: nonEmptyStringSchema,
    gold_page: positiveIntegerSchema,
  })
  .strict();

export const scenarioEvaluationItemSchema = z
  .object({
    id: nonEmptyStringSchema,
    title: nonEmptyStringSchema.optional(),
    prompt: nonEmptyStringSchema,
    checklist: z.array(nonEmptyStringSchema).min(1),
  })
  .strict();

export const evaluationSetSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    name: nonEmptyStringSchema.optional(),
    qa: z.array(qaEvaluationItemSchema).min(1),
    scenarios: z.array(scenarioEvaluationItemSchema).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIdIssues(
      value.qa.flatMap((item, index) =>
        item.id === undefined ? [] : [{ id: item.id, index }],
      ),
      "qa",
      context,
    );
    addDuplicateIdIssues(
      value.scenarios.map((item, index) => ({ id: item.id, index })),
      "scenarios",
      context,
    );
  });

export const humanReviewStatusSchema = z.enum(["pending", "pass", "fail"]);

export const humanReviewSchema = z
  .object({
    status: humanReviewStatusSchema,
    reviewer: nonEmptyStringSchema.optional(),
    reviewed_at: z.iso.datetime({ offset: true }).optional(),
    notes: nonEmptyStringSchema.optional(),
  })
  .strict();

export const humanReviewSummarySchema = z
  .object({
    total: nonNegativeIntegerSchema,
    reviewed: nonNegativeIntegerSchema,
    passed: nonNegativeIntegerSchema,
    failed: nonNegativeIntegerSchema,
    pending: nonNegativeIntegerSchema,
    pass_rate: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();

export const checklistItemStatusSchema = z.enum([
  "pending",
  "pass",
  "fail",
  "not_applicable",
]);

export const checklistResultItemSchema = z
  .object({
    id: nonEmptyStringSchema,
    criterion: nonEmptyStringSchema,
    status: checklistItemStatusSchema,
    evidence: nonEmptyStringSchema.optional(),
    notes: nonEmptyStringSchema.optional(),
  })
  .strict();

export const checklistSummarySchema = z
  .object({
    total: nonNegativeIntegerSchema,
    applicable: nonNegativeIntegerSchema,
    passed: nonNegativeIntegerSchema,
    failed: nonNegativeIntegerSchema,
    pending: nonNegativeIntegerSchema,
    not_applicable: nonNegativeIntegerSchema,
    pass_rate: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();

export const retrievalCandidateSchema = z
  .object({
    document_id: nonEmptyStringSchema,
    filename: nonEmptyStringSchema,
    page_number: positiveIntegerSchema.nullable(),
  })
  .strip();

export const retrievalHitSchema = z
  .object({
    k: positiveIntegerSchema,
    candidate_count: nonNegativeIntegerSchema,
    hit: z.boolean(),
    rank: positiveIntegerSchema.nullable(),
    document_hit: z.boolean(),
    document_rank: positiveIntegerSchema.nullable(),
    matched_document_id: nonEmptyStringSchema.nullable(),
    matched_filename: nonEmptyStringSchema.nullable(),
    matched_page: positiveIntegerSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hit !== (value.rank !== null)) {
      context.addIssue({
        code: "custom",
        path: ["rank"],
        message: "rank must be present exactly when hit is true",
      });
    }
    if (value.document_hit !== (value.document_rank !== null)) {
      context.addIssue({
        code: "custom",
        path: ["document_rank"],
        message:
          "document_rank must be present exactly when document_hit is true",
      });
    }
    if (value.hit && !value.document_hit) {
      context.addIssue({
        code: "custom",
        path: ["document_hit"],
        message: "an exact hit must also be a document hit",
      });
    }
    for (const [field, rank] of [
      ["rank", value.rank],
      ["document_rank", value.document_rank],
    ] as const) {
      if (rank !== null && (rank > value.k || rank > value.candidate_count)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} cannot exceed k or candidate_count`,
        });
      }
    }
    const hasAllMatchedDocumentFields =
      value.matched_document_id !== null && value.matched_filename !== null;
    const hasAnyMatchedDocumentField =
      value.matched_document_id !== null || value.matched_filename !== null;
    if (
      (value.document_hit && !hasAllMatchedDocumentFields) ||
      (!value.document_hit && hasAnyMatchedDocumentField)
    ) {
      context.addIssue({
        code: "custom",
        path: ["matched_document_id"],
        message:
          "matched document fields must be present exactly when document_hit is true",
      });
    }
    if (!value.document_hit && value.matched_page !== null) {
      context.addIssue({
        code: "custom",
        path: ["matched_page"],
        message: "matched_page requires a document hit",
      });
    }
    if (value.hit && value.matched_page === null) {
      context.addIssue({
        code: "custom",
        path: ["matched_page"],
        message: "an exact hit requires a matched page",
      });
    }
    if (
      value.rank !== null &&
      value.document_rank !== null &&
      value.document_rank > value.rank
    ) {
      context.addIssue({
        code: "custom",
        path: ["document_rank"],
        message: "document_rank cannot follow the exact hit rank",
      });
    }
  });

export const qaEvaluationResultSchema = z
  .object({
    id: nonEmptyStringSchema,
    question: nonEmptyStringSchema,
    expected_answer_gist: nonEmptyStringSchema,
    gold_doc: nonEmptyStringSchema,
    gold_page: positiveIntegerSchema,
    retrieval: retrievalHitSchema,
    answer: nonEmptyStringSchema.optional(),
    answer_review: humanReviewSchema,
    wall_time_ms: nonNegativeDurationSchema.nullable(),
    emitted_citations: nonNegativeIntegerSchema,
    valid_citations: nonNegativeIntegerSchema,
    error: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.valid_citations > value.emitted_citations) {
      context.addIssue({
        code: "custom",
        path: ["valid_citations"],
        message: "valid_citations cannot exceed emitted_citations",
      });
    }
  });

export const toolChainStatusSchema = z.enum([
  "not_observed",
  "completed",
  "incomplete",
]);

export const evaluationFailureModeSchema = z.enum([
  "retrieval_miss",
  "tool_chain_exit",
  "tool_budget_exceeded",
  "capability_gap",
  "runtime_error",
  "other",
]);

export const scenarioEvaluationResultSchema = z
  .object({
    id: nonEmptyStringSchema,
    title: nonEmptyStringSchema.optional(),
    prompt: nonEmptyStringSchema,
    tool_chain_status: toolChainStatusSchema,
    tool_iterations: nonNegativeIntegerSchema.nullable(),
    tool_calls: nonNegativeIntegerSchema.nullable(),
    checklist: z.array(checklistResultItemSchema).min(1),
    human_review: humanReviewSchema,
    wall_time_ms: nonNegativeDurationSchema.nullable(),
    emitted_citations: nonNegativeIntegerSchema,
    valid_citations: nonNegativeIntegerSchema,
    failure_mode: evaluationFailureModeSchema.nullable(),
    error: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.valid_citations > value.emitted_citations) {
      context.addIssue({
        code: "custom",
        path: ["valid_citations"],
        message: "valid_citations cannot exceed emitted_citations",
      });
    }
    addDuplicateIdIssues(
      value.checklist.map((item, index) => ({ id: item.id, index })),
      "checklist",
      context,
    );
  });

export const evaluationRunResultSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: nonEmptyStringSchema,
    evalset_name: nonEmptyStringSchema.optional(),
    model: nonEmptyStringSchema,
    started_at: z.iso.datetime({ offset: true }),
    finished_at: z.iso.datetime({ offset: true }),
    top_k: positiveIntegerSchema,
    qa_results: z.array(qaEvaluationResultSchema),
    scenario_results: z.array(scenarioEvaluationResultSchema),
    notes: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.finished_at) < Date.parse(value.started_at)) {
      context.addIssue({
        code: "custom",
        path: ["finished_at"],
        message: "finished_at cannot be earlier than started_at",
      });
    }
    value.qa_results.forEach((result, index) => {
      if (result.retrieval.k !== value.top_k) {
        context.addIssue({
          code: "custom",
          path: ["qa_results", index, "retrieval", "k"],
          message: "retrieval k must match run top_k",
        });
      }
    });
    addDuplicateIdIssues(
      value.qa_results.map((item, index) => ({ id: item.id, index })),
      "qa_results",
      context,
    );
    addDuplicateIdIssues(
      value.scenario_results.map((item, index) => ({ id: item.id, index })),
      "scenario_results",
      context,
    );
  });

export type EvaluationSet = z.infer<typeof evaluationSetSchema>;
export type HumanReview = z.infer<typeof humanReviewSchema>;
export type HumanReviewSummary = z.infer<typeof humanReviewSummarySchema>;
export type ChecklistResultItem = z.infer<typeof checklistResultItemSchema>;
export type ChecklistSummary = z.infer<typeof checklistSummarySchema>;
export type RetrievalCandidate = z.infer<typeof retrievalCandidateSchema>;
export type RetrievalHit = z.infer<typeof retrievalHitSchema>;
export type QaEvaluationResult = z.infer<typeof qaEvaluationResultSchema>;
export type ScenarioEvaluationResult = z.infer<
  typeof scenarioEvaluationResultSchema
>;
export type EvaluationRunResult = z.infer<typeof evaluationRunResultSchema>;

type DuplicateIdCandidate = { id: string; index: number };

function addDuplicateIdIssues(
  candidates: DuplicateIdCandidate[],
  path: string,
  context: z.RefinementCtx,
): void {
  const firstIndexById = new Map<string, number>();
  for (const candidate of candidates) {
    const firstIndex = firstIndexById.get(candidate.id);
    if (firstIndex === undefined) {
      firstIndexById.set(candidate.id, candidate.index);
      continue;
    }
    context.addIssue({
      code: "custom",
      path: [path, candidate.index, "id"],
      message: `duplicate id (first used at index ${firstIndex})`,
    });
  }
}

export function scoreRetrievalHit(input: {
  goldDoc: string;
  goldPage: number;
  candidates: readonly RetrievalCandidate[];
  k?: number;
}): RetrievalHit {
  const goldDoc = nonEmptyStringSchema.parse(input.goldDoc);
  const goldPage = positiveIntegerSchema.parse(input.goldPage);
  const k = positiveIntegerSchema.parse(input.k ?? 8);
  const candidates = retrievalCandidateSchema.array().parse(input.candidates);
  const topCandidates = candidates.slice(0, k);
  const matchesDocument = (candidate: RetrievalCandidate): boolean =>
    candidate.document_id === goldDoc || candidate.filename === goldDoc;
  const documentIndex = topCandidates.findIndex(matchesDocument);
  const hitIndex = topCandidates.findIndex(
    (candidate) =>
      matchesDocument(candidate) && candidate.page_number === goldPage,
  );
  const matchedCandidate =
    topCandidates[hitIndex >= 0 ? hitIndex : documentIndex] ?? null;

  return retrievalHitSchema.parse({
    k,
    candidate_count: candidates.length,
    hit: hitIndex >= 0,
    rank: hitIndex >= 0 ? hitIndex + 1 : null,
    document_hit: documentIndex >= 0,
    document_rank: documentIndex >= 0 ? documentIndex + 1 : null,
    matched_document_id: matchedCandidate?.document_id ?? null,
    matched_filename: matchedCandidate?.filename ?? null,
    matched_page: matchedCandidate?.page_number ?? null,
  });
}

export function summarizeChecklist(
  items: readonly ChecklistResultItem[],
): ChecklistSummary {
  const parsedItems = checklistResultItemSchema.array().parse(items);
  const counts = {
    pass: 0,
    fail: 0,
    pending: 0,
    not_applicable: 0,
  };
  for (const item of parsedItems) counts[item.status] += 1;
  const applicable = counts.pass + counts.fail + counts.pending;

  return checklistSummarySchema.parse({
    total: parsedItems.length,
    applicable,
    passed: counts.pass,
    failed: counts.fail,
    pending: counts.pending,
    not_applicable: counts.not_applicable,
    pass_rate: applicable === 0 ? null : counts.pass / applicable,
  });
}

export function summarizeHumanReviews(
  reviews: readonly HumanReview[],
): HumanReviewSummary {
  const parsedReviews = humanReviewSchema.array().parse(reviews);
  const passed = parsedReviews.filter(
    (review) => review.status === "pass",
  ).length;
  const failed = parsedReviews.filter(
    (review) => review.status === "fail",
  ).length;
  const pending = parsedReviews.length - passed - failed;
  const reviewed = passed + failed;

  return humanReviewSummarySchema.parse({
    total: parsedReviews.length,
    reviewed,
    passed,
    failed,
    pending,
    pass_rate: reviewed === 0 ? null : passed / reviewed,
  });
}

export function summarizeRetrieval(results: readonly QaEvaluationResult[]): {
  total: number;
  hits: number;
  hit_rate: number | null;
} {
  const parsedResults = qaEvaluationResultSchema.array().parse(results);
  const hits = parsedResults.filter((result) => result.retrieval.hit).length;
  return {
    total: parsedResults.length,
    hits,
    hit_rate: parsedResults.length === 0 ? null : hits / parsedResults.length,
  };
}

export function renderEvaluationResultJson(input: unknown): string {
  const result = evaluationRunResultSchema.parse(input);
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function renderEvaluationResultMarkdown(input: unknown): string {
  const result = evaluationRunResultSchema.parse(input);
  const retrieval = summarizeRetrieval(result.qa_results);
  const answerReviews = summarizeHumanReviews(
    result.qa_results.map((qa) => qa.answer_review),
  );
  const lines = [
    "# Performance and Accuracy Evaluation",
    "",
    `- Run: ${escapeInline(result.run_id)}`,
    `- Model: ${escapeInline(result.model)}`,
    `- Started: ${escapeInline(result.started_at)}`,
    `- Finished: ${escapeInline(result.finished_at)}`,
    `- Retrieval: ${formatFraction(retrieval.hits, retrieval.total, retrieval.hit_rate)} hit@${result.top_k}`,
    `- Answer accuracy: ${formatFraction(answerReviews.passed, answerReviews.reviewed, answerReviews.pass_rate)}; ${answerReviews.pending} pending review`,
  ];

  if (result.evalset_name) {
    lines.splice(
      3,
      0,
      `- Evaluation set: ${escapeInline(result.evalset_name)}`,
    );
  }
  if (result.notes) lines.push(`- Notes: ${escapeInline(result.notes)}`);

  lines.push("", "## QA results", "");
  if (result.qa_results.length === 0) {
    lines.push("_No QA results._");
  } else {
    lines.push(
      "| ID | Retrieval | Rank | Gold document | Gold page | Answer review | Valid citations | Wall time |",
      "| --- | ---: | ---: | --- | ---: | --- | ---: | ---: |",
    );
    for (const qa of result.qa_results) {
      lines.push(
        `| ${escapeTableCell(qa.id)} | ${qa.retrieval.hit ? "hit" : "miss"} | ${qa.retrieval.rank ?? "—"} | ${escapeTableCell(qa.gold_doc)} | ${qa.gold_page} | ${qa.answer_review.status} | ${qa.valid_citations}/${qa.emitted_citations} | ${formatDuration(qa.wall_time_ms)} |`,
      );
    }
  }

  lines.push("", "## Scenario results", "");
  if (result.scenario_results.length === 0) {
    lines.push("_No scenario results._");
  } else {
    lines.push(
      "| Scenario | Tool chain | Checklist | Human review | Valid citations | Wall time | Failure mode |",
      "| --- | --- | ---: | --- | ---: | ---: | --- |",
    );
    for (const scenario of result.scenario_results) {
      const summary = summarizeChecklist(scenario.checklist);
      lines.push(
        `| ${escapeTableCell(scenario.id)} | ${scenario.tool_chain_status} | ${formatFraction(summary.passed, summary.applicable, summary.pass_rate)} | ${scenario.human_review.status} | ${scenario.valid_citations}/${scenario.emitted_citations} | ${formatDuration(scenario.wall_time_ms)} | ${scenario.failure_mode ?? "—"} |`,
      );
    }

    for (const scenario of result.scenario_results) {
      const summary = summarizeChecklist(scenario.checklist);
      lines.push(
        "",
        `### ${escapeHeading(scenario.title ?? scenario.id)}`,
        "",
        `- Checklist: ${formatFraction(summary.passed, summary.applicable, summary.pass_rate)}`,
        `- Human review: ${scenario.human_review.status}`,
        `- Tool chain: ${scenario.tool_chain_status}`,
        "",
      );
      for (const item of scenario.checklist) {
        const detail = item.evidence ?? item.notes;
        lines.push(
          `- [${item.status}] ${escapeListText(item.criterion)}${detail ? ` — ${escapeListText(detail)}` : ""}`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatFraction(
  numerator: number,
  denominator: number,
  rate: number | null,
): string {
  const percent = rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
  return `${numerator}/${denominator} (${percent})`;
}

function formatDuration(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function escapeInline(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

function escapeTableCell(value: string): string {
  return escapeInline(value).replace(/\|/g, "\\|");
}

function escapeHeading(value: string): string {
  return escapeInline(value).replace(/^#+\s*/, "");
}

function escapeListText(value: string): string {
  return escapeInline(value).replace(/^([-+*]|\d+\.)\s+/, "\\$&");
}
