export function buildDocumentSourceSelection(
    documents: { id: string }[],
    deselectedDocIds: ReadonlySet<string>,
    attachedDocumentIds: Iterable<string> = [],
): { deselectedDocIds: Set<string>; selectedDocumentIds?: string[] } {
    const availableIds = new Set(documents.map((document) => document.id));
    const nextDeselected = new Set(
        [...deselectedDocIds].filter((id) => availableIds.has(id)),
    );
    for (const id of attachedDocumentIds) nextDeselected.delete(id);

    const selectedDocumentIds = documents
        .map((document) => document.id)
        .filter((id) => !nextDeselected.has(id));

    return {
        deselectedDocIds: nextDeselected,
        selectedDocumentIds:
            selectedDocumentIds.length === documents.length
                ? undefined
                : selectedDocumentIds,
    };
}
