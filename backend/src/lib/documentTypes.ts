export const IMAGE_DOCUMENT_TYPES = [
  "png",
  "jpg",
  "jpeg",
  "tiff",
  "bmp",
  "webp",
] as const;

const DOCUMENT_TYPES = [
  "pdf",
  "docx",
  "doc",
  "txt",
  "md",
  ...IMAGE_DOCUMENT_TYPES,
];

export function isImageDocumentType(value: string): boolean {
  return (IMAGE_DOCUMENT_TYPES as readonly string[]).includes(
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
