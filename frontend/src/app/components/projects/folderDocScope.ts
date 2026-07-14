export function collectDescendantDocIds(
  folders: readonly { id: string; parent_folder_id: string | null }[],
  documents: readonly { id: string; folder_id?: string | null }[],
  rootFolderId: string,
): string[] {
  const childrenOf = new Map<string | null, string[]>();
  for (const folder of folders) {
    const key = folder.parent_folder_id;
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), folder.id]);
  }

  const folderIds = new Set<string>([rootFolderId]);
  const pending = [rootFolderId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const child of childrenOf.get(current) ?? []) {
      if (folderIds.has(child)) continue;
      folderIds.add(child);
      pending.push(child);
    }
  }

  return documents
    .filter(
      (document) =>
        document.folder_id != null && folderIds.has(document.folder_id),
    )
    .map((document) => document.id);
}

export function evidenceDocumentIds(
  documents: readonly { id: string; doc_role?: string }[],
): string[] {
  return documents
    .filter((document) => document.doc_role === "evidence")
    .map((document) => document.id);
}
