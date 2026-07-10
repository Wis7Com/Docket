import type { DocketCitationAnnotation } from "../shared/types";

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
