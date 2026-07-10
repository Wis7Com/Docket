import type { DocketDocument, DocketProject } from "./types";

export const PROJECT_DIRECTORY_ERROR = "Failed to load projects.";

export interface DirectoryListingResult {
    standaloneDocuments: DocketDocument[];
    projectSummaries: DocketProject[];
    error: string | null;
}

export function resolveDirectoryListings(
    projectsResult: PromiseSettledResult<DocketProject[]>,
    documentsResult: PromiseSettledResult<DocketDocument[]>,
): DirectoryListingResult {
    const projectSummaries =
        projectsResult.status === "fulfilled"
            ? projectsResult.value.map((project) => ({
                  ...project,
                  documents: project.documents ?? [],
              }))
            : [];
    const standaloneDocuments =
        documentsResult.status === "fulfilled"
            ? [...documentsResult.value].sort((a, b) =>
                  (b.created_at ?? "").localeCompare(a.created_at ?? ""),
              )
            : [];

    return {
        standaloneDocuments,
        projectSummaries,
        error:
            projectsResult.status === "rejected"
                ? PROJECT_DIRECTORY_ERROR
                : null,
    };
}

export function mergeDirectoryResults(
    summaries: DocketProject[],
    fullProjects: PromiseSettledResult<DocketProject>[],
): DocketProject[] {
    return summaries.map((summary, index) => {
        const result = fullProjects[index];
        return result?.status === "fulfilled" ? result.value : summary;
    });
}
