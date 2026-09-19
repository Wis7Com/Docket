export const IMAGE_DOCUMENT_TYPES = [
  "png",
  "jpg",
  "jpeg",
  "tiff",
  "bmp",
  "webp",
] as const;

/**
 * Office formats the viewer can't draw itself. They are converted to a PDF
 * rendition at import time, and that PDF is what gets displayed and indexed.
 */
export const PDF_RENDITION_TYPES = ["docx", "doc", "hwpx"] as const;

const DOCUMENT_TYPES = [
  "pdf",
  ...PDF_RENDITION_TYPES,
  "txt",
  "md",
  ...IMAGE_DOCUMENT_TYPES,
];

export function isImageDocumentType(value: string): boolean {
  return (IMAGE_DOCUMENT_TYPES as readonly string[]).includes(
    value.toLowerCase(),
  );
}

export function usesPdfRendition(value: string): boolean {
  return (PDF_RENDITION_TYPES as readonly string[]).includes(
    value.toLowerCase(),
  );
}

export function isAllowedDocumentType(value: string): boolean {
  return DOCUMENT_TYPES.includes(
    value.toLowerCase() as (typeof DOCUMENT_TYPES)[number],
  );
}

export function mimeTypeForDocumentType(value: string): string {
  switch (value.toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "doc":
      return "application/msword";
    case "hwpx":
      return "application/hwp+zip";
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "tiff":
      return "image/tiff";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
