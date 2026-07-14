function stripTitleReasoning(raw: string): string {
  let cleaned = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "");
  const unmatchedClose = cleaned.match(/<\/think\s*>/i);
  if (unmatchedClose?.index !== undefined) {
    cleaned = cleaned.slice(unmatchedClose.index + unmatchedClose[0].length);
  }
  const unmatchedOpen = cleaned.search(/<think\b[^>]*>/i);
  if (unmatchedOpen >= 0) cleaned = cleaned.slice(0, unmatchedOpen);
  return cleaned.replace(/<\/?think\b[^>]*>/gi, "").trim();
}

export function sanitizeGeneratedChatTitle(
  raw: string,
  fallbackMessage: string,
): string {
  const fallback = fallbackMessage.trim().slice(0, 60);
  const candidate = stripTitleReasoning(raw)
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[.!?]+$/g, "") ?? "";
  const wordCount = candidate.split(/\s+/).filter(Boolean).length;
  if (
    !candidate ||
    candidate.length > 80 ||
    wordCount > 6 ||
    /(?:generate|create|need).{0,24}(?:concise\s+)?title|concise title/i.test(candidate)
  ) {
    return fallback;
  }
  return candidate;
}
