export type StoredOcrRegion = {
  region_index: number;
  text: string;
  bbox_x: number;
  bbox_y: number;
  bbox_width: number;
  bbox_height: number;
};

function searchable(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function findMatchingOcrRegions<T extends StoredOcrRegion>(
  rows: T[],
  citation: string,
): T[] {
  const quote = searchable(citation);
  if (quote.length < 4) return [];
  const ordered = [...rows].sort((a, b) => a.region_index - b.region_index);
  for (let start = 0; start < ordered.length; start += 1) {
    let combined = "";
    for (
      let end = start;
      end < Math.min(ordered.length, start + 64);
      end += 1
    ) {
      combined += searchable(ordered[end].text);
      if (combined.includes(quote)) return ordered.slice(start, end + 1);
      if (combined.length > quote.length * 2) break;
    }
  }
  return [];
}
