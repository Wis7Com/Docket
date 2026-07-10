"use client";

import type { TRCitationAnnotation } from "../../lib/docketApi";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";

export interface PreprocessedTabularCellMarkdown {
    processed: string;
    citations: ParsedCitation[];
    pills: string[];
}

// Replace citations and pills with inline-code tokens so ReactMarkdown passes
// them through its `code` component, where the tabular UI renders buttons/pills.
export function preprocessCellMarkdown(
    text: string,
): PreprocessedTabularCellMarkdown {
    const { processed: withCits, citations } = preprocessCitations(text);
    const pills: string[] = [];
    let out = withCits.replace(/\[\[([^\]]+)\]\]/g, (_, content) => {
        const idx = pills.length;
        pills.push(content);
        return `\`§p${idx}§\`\u200B`;
    });
    out = out.replace(/§(\d+)§/g, (_, idx) => `\`§c${idx}§\`\u200B`);
    return { processed: out, citations, pills };
}

export function preprocessTRCitations(
    text: string,
    annotations: TRCitationAnnotation[],
    citationsList: TRCitationAnnotation[],
): string {
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsStr) => {
        const refs = (refsStr as string)
            .split(",")
            .map((s: string) => parseInt(s.trim(), 10));
        const tokens = refs.flatMap((ref: number) => {
            const ann = annotations.find((a) => a.ref === ref);
            if (!ann) return [];
            const idx = citationsList.length;
            citationsList.push(ann);
            return [`\`§${idx}§\`\u200B`];
        });
        return tokens.length > 0 ? tokens.join("") : full;
    });
}
