import type { AnnotationColorFamily } from "@/app/components/shared/types";
import type { ProjectAnnotationFilters } from "@/app/lib/docketApi";

const COLOR_FAMILY_ORDER: Array<AnnotationColorFamily | null> = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "gray",
  null,
];

export function buildProjectAnnotationQueryString(
  filters: ProjectAnnotationFilters,
): string {
  const params = new URLSearchParams();
  if (filters.colorFamily?.length) {
    params.set("color_family", filters.colorFamily.join(","));
  }
  if (filters.docId?.length) params.set("doc_id", filters.docId.join(","));
  if (filters.annotationType) {
    params.set("annotation_type", filters.annotationType);
  }
  if (filters.hasComment !== undefined) {
    params.set("has_comment", String(filters.hasComment));
  }
  if (filters.source) params.set("source", filters.source);
  if (filters.order) params.set("order", filters.order);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) {
    params.set("offset", String(filters.offset));
  }
  return params.toString();
}

export function colorFamilyLabel(
  family: AnnotationColorFamily | null,
  legend?: Partial<Record<AnnotationColorFamily, string>>,
): string {
  if (family === null) return "unclassified";
  return legend?.[family] ?? family;
}

export function orderColorFamilyChips(
  counts: Array<{
    color_family: AnnotationColorFamily | null;
    count: number;
  }>,
): Array<{ color_family: AnnotationColorFamily | null; count: number }> {
  const order = new Map(
    COLOR_FAMILY_ORDER.map((family, index) => [family, index]),
  );
  return [...counts].sort(
    (left, right) =>
      (order.get(left.color_family) ?? COLOR_FAMILY_ORDER.length) -
      (order.get(right.color_family) ?? COLOR_FAMILY_ORDER.length),
  );
}
