/**
 * Formats offered by the document file pickers. One list so a new format is
 * added in one place, not in every picker. The backend's own allow-list
 * (backend/src/lib/documentTypes.ts) is what actually gates an upload.
 */
export const UPLOAD_EXTENSIONS = [
    "pdf",
    "docx",
    "doc",
    "hwpx",
    "txt",
    "png",
    "jpg",
    "jpeg",
    "tiff",
    "bmp",
    "webp",
] as const;

/** Value for an `<input type="file" accept>` attribute. */
export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(",");

/**
 * Extensions offered when replacing a document with a new version. The
 * backend rejects a version whose type differs from the original's.
 */
export function newVersionAccept(fileType: string | null | undefined): string {
    const type = (fileType ?? "").toLowerCase();
    if (type === "docx" || type === "doc") return ".docx,.doc";
    return type ? `.${type}` : UPLOAD_ACCEPT;
}
