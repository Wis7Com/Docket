import type { EvaluationRunResult } from "./perfAccuracyEval";

export type MetricSeries = {
  values: number[];
  median: number;
};

export type Round3RunAggregate = {
  schema_version: 1;
  policy: "round-3-median";
  model: string;
  run_count: number;
  run_ids: string[];
  qa: {
    verified_citation_answers: MetricSeries;
    empty_answers: MetricSeries;
    wall_time_ms: MetricSeries;
  };
  scenarios: Record<
    string,
    {
      valid_citations: MetricSeries;
      wall_time_ms: MetricSeries;
      checklist_passed: MetricSeries;
      checklist_review_pending: boolean;
    }
  >;
  gate: {
    qa_verified_citation_answers_min: 12;
    qa_empty_answers_max: 0;
    as_3_checklist_median_min: 4;
    as_3b_checklist_median_min: 4;
    as_2_checklist_median_min: 4;
    as_1_observation_only: true;
    citation_checklist_items_may_use_verification_label: true;
  };
};

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median requires at least one value");
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("median values must be finite");
  }
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function series(values: number[]): MetricSeries {
  return { values, median: median(values) };
}

export function aggregateRound3Runs(
  runs: readonly EvaluationRunResult[],
): Round3RunAggregate {
  if (runs.length === 0) throw new Error("at least one evaluation run is required");
  const model = runs[0].model;
  if (runs.some((run) => run.model !== model)) {
    throw new Error("all evaluation runs must use the same model");
  }

  const scenarioIds = [
    ...new Set(runs.flatMap((run) => run.scenario_results.map(({ id }) => id))),
  ].sort();
  const scenarios: Round3RunAggregate["scenarios"] = {};
  for (const id of scenarioIds) {
    const rows = runs.map((run) => {
      const row = run.scenario_results.find((scenario) => scenario.id === id);
      if (!row) throw new Error(`scenario ${id} is missing from one or more runs`);
      return row;
    });
    scenarios[id] = {
      valid_citations: series(rows.map((row) => row.valid_citations)),
      wall_time_ms: series(rows.map((row) => row.wall_time_ms ?? 0)),
      checklist_passed: series(
        rows.map(
          (row) => row.checklist.filter(({ status }) => status === "pass").length,
        ),
      ),
      checklist_review_pending: rows.some((row) =>
        row.checklist.some(({ status }) => status === "pending"),
      ),
    };
  }

  return {
    schema_version: 1,
    policy: "round-3-median",
    model,
    run_count: runs.length,
    run_ids: runs.map(({ run_id }) => run_id),
    qa: {
      verified_citation_answers: series(
        runs.map(
          (run) =>
            run.qa_results.filter(({ valid_citations }) => valid_citations > 0)
              .length,
        ),
      ),
      empty_answers: series(
        runs.map(
          (run) =>
            run.qa_results.filter(({ answer }) => !(answer ?? "").trim()).length,
        ),
      ),
      wall_time_ms: series(
        runs.map((run) =>
          run.qa_results.reduce(
            (total, { wall_time_ms }) => total + (wall_time_ms ?? 0),
            0,
          ),
        ),
      ),
    },
    scenarios,
    gate: {
      qa_verified_citation_answers_min: 12,
      qa_empty_answers_max: 0,
      as_3_checklist_median_min: 4,
      as_3b_checklist_median_min: 4,
      as_2_checklist_median_min: 4,
      as_1_observation_only: true,
      citation_checklist_items_may_use_verification_label: true,
    },
  };
}

export function renderRound3AggregateMarkdown(
  aggregate: Round3RunAggregate,
): string {
  const lines = [
    "# Performance / Accuracy Round 3 Median",
    "",
    `- Model: ${aggregate.model}`,
    `- Runs: ${aggregate.run_count}`,
    `- QA verified-citation answers: ${aggregate.qa.verified_citation_answers.median} median (${aggregate.qa.verified_citation_answers.values.join(", ")})`,
    `- QA empty answers: ${aggregate.qa.empty_answers.median} median (${aggregate.qa.empty_answers.values.join(", ")})`,
    "",
    "| Scenario | Checklist passed median | Valid citations median | Wall median (ms) | Review |",
    "|---|---:|---:|---:|---|",
  ];
  for (const [id, scenario] of Object.entries(aggregate.scenarios)) {
    lines.push(
      `| ${id} | ${scenario.checklist_passed.median} | ${scenario.valid_citations.median} | ${scenario.wall_time_ms.median.toFixed(0)} | ${scenario.checklist_review_pending ? "pending" : "complete"} |`,
    );
  }
  lines.push(
    "",
    "> Checklist medians remain provisional while any raw run contains pending human-review items.",
    "",
  );
  return lines.join("\n");
}
