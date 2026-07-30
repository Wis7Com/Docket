import type { DocketCitationAnnotation } from "../shared/types";

export type CitationSummary = Readonly<{
    verified_count: number;
    verified_distinct_sources?: number;
    used_document_tools: boolean;
}>;

export type CitationSummaryChip = Readonly<{
    kind: "verified" | "warning";
    text: string;
}>;

export type CitationButtonPresentation = Readonly<{
    kind: "verified" | "unconfirmed";
    label: string;
    title: string;
}>;

export function citationButtonPresentation(
    annotation: Pick<DocketCitationAnnotation, "ref" | "support">,
    sourceDescription: string,
): CitationButtonPresentation {
    if (annotation.support === "unconfirmed") {
        return {
            kind: "unconfirmed",
            label: "?",
            title: `The model cited this passage, but it was not verified that the passage supports this specific claim. ${sourceDescription}`,
        };
    }
    return {
        kind: "verified",
        label: String(annotation.ref),
        title: sourceDescription,
    };
}

export function citationSummaryChip(
    summary: CitationSummary | null | undefined,
    language = "en",
): CitationSummaryChip | null {
    if (!summary) return null;

    const countForChip =
        summary.verified_distinct_sources ?? summary.verified_count;
    const verifiedCount =
        Number.isSafeInteger(countForChip) && countForChip > 0
            ? countForChip
            : 0;
    const isKorean = language.trim().toLowerCase().startsWith("ko");

    if (verifiedCount > 0) {
        return {
            kind: "verified",
            text: isKorean
                ? `원문 대조 인용 ${verifiedCount}개 ✓`
                : `${verifiedCount} source-verified citation${verifiedCount === 1 ? "" : "s"} ✓`,
        };
    }

    if (summary.used_document_tools) {
        return {
            kind: "warning",
            text: isKorean
                ? "⚠︎ 이 답변의 참조는 원문과 대조되지 않았습니다"
                : "⚠︎ References in this answer were not verified against the source.",
        };
    }

    return null;
}

export function preprocessCitations(
    text: string,
    annotations: DocketCitationAnnotation[],
    citationsList: DocketCitationAnnotation[],
): string {
    // Replace [N] or [N, M, ...] inline markers with internal §idx§ tokens backed by annotations.
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsStr) => {
        const refs = (refsStr as string)
            .split(",")
            .map((s: string) => parseInt(s.trim(), 10));
        const tokens = refs.map((ref: number) => {
            const matches = annotations.filter((a) => a.ref === ref);
            // Never select the first duplicate. Historic or malformed data
            // should remain visible as prose, but must not open a wrong source.
            if (matches.length !== 1) return `\`§unresolved:${ref}§\`\u200B`;
            const ann = matches[0];
            const idx = citationsList.length;
            citationsList.push(ann);
            return `\`§${idx}§\`\u200B`;
        });
        return tokens.join("");
    });
}
