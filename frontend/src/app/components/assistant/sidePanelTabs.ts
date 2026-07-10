import type {
    AssistantSidePanelTab,
    CitationTab,
    DocumentTab,
    EditTab,
} from "./AssistantSidePanel";
import type {
    DocketCitationAnnotation,
    DocketEditAnnotation,
} from "../shared/types";

export function buildCitationTab(
    citation: DocketCitationAnnotation,
): CitationTab {
    return {
        kind: "citation",
        id: citation.document_id,
        documentId: citation.document_id,
        filename: citation.filename,
        versionId: citation.version_id ?? null,
        versionNumber: citation.version_number ?? null,
        citation,
    };
}

export function buildEditTab(
    ann: DocketEditAnnotation,
    filename: string,
): EditTab {
    return {
        kind: "edit",
        id: ann.document_id,
        documentId: ann.document_id,
        filename,
        versionId: ann.version_id ?? null,
        versionNumber: ann.version_number ?? null,
        edit: ann,
    };
}

export function buildDocumentTab(args: {
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
}): DocumentTab {
    return {
        kind: "document",
        id: args.documentId,
        documentId: args.documentId,
        filename: args.filename,
        versionId: args.versionId,
        versionNumber: args.versionNumber,
    };
}

export function upsertAssistantSidePanelTab(
    tabs: AssistantSidePanelTab[],
    tab: AssistantSidePanelTab,
): AssistantSidePanelTab[] {
    const idx = tabs.findIndex((t) => t.documentId === tab.documentId);
    if (idx < 0) return [...tabs, tab];

    const existing = tabs[idx];
    const copy = tabs.slice();
    copy[idx] = {
        ...tab,
        id: existing.id,
        warning: existing.warning,
        initialScrollTop: existing.initialScrollTop,
    } as AssistantSidePanelTab;
    return copy;
}
