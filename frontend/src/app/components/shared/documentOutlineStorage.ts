import type { DocumentNavigationItem } from "./DocumentNavigationPane";

type OutlineStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_PREFIX = "docket-document-outline:";
const MAX_STORED_ITEMS = 240;

export function documentOutlineStorageKey(
    kind: "pdf" | "docx",
    documentId: string,
    versionId?: string | null,
): string {
    return `${kind}:${documentId}:${versionId ?? "current"}`;
}

function validItem(value: unknown): value is DocumentNavigationItem {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<DocumentNavigationItem>;
    return (
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.title === "string" &&
        item.title.trim().length > 0 &&
        typeof item.level === "number" &&
        Number.isInteger(item.level) &&
        item.level >= 1 &&
        item.level <= 6 &&
        (item.page === undefined ||
            (typeof item.page === "number" &&
                Number.isInteger(item.page) &&
                item.page >= 1))
    );
}

export function loadGeneratedDocumentOutline(
    storage: Pick<OutlineStorage, "getItem">,
    key: string,
): DocumentNavigationItem[] {
    try {
        const raw = storage.getItem(`${STORAGE_PREFIX}${key}`);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as { version?: unknown; items?: unknown };
        if (parsed.version !== 1 || !Array.isArray(parsed.items)) return [];
        return parsed.items.filter(validItem).slice(0, MAX_STORED_ITEMS);
    } catch {
        return [];
    }
}

export function saveGeneratedDocumentOutline(
    storage: Pick<OutlineStorage, "setItem">,
    key: string,
    items: DocumentNavigationItem[],
): void {
    try {
        storage.setItem(
            `${STORAGE_PREFIX}${key}`,
            JSON.stringify({
                version: 1,
                items: items.filter(validItem).slice(0, MAX_STORED_ITEMS),
            }),
        );
    } catch {
        // Outline persistence is a convenience. A blocked/full localStorage
        // must never prevent the document viewer itself from working.
    }
}
