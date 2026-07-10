"use client";

import { useCallback, useEffect, useState } from "react";
import { getProject, listProjects, listStandaloneDocuments } from "@/app/lib/docketApi";
import {
    mergeDirectoryResults,
    PROJECT_DIRECTORY_ERROR,
    resolveDirectoryListings,
} from "./directoryData";
import type { DocketDocument, DocketProject } from "./types";

const CACHE_TTL_MS = 30_000;

interface DirectoryCache {
    standaloneDocuments: DocketDocument[];
    projects: DocketProject[];
    fetchedAt: number;
}

let cache: DirectoryCache | null = null;

export function invalidateDirectoryCache() {
    cache = null;
}

export function useDirectoryData(enabled: boolean) {
    const [loading, setLoading] = useState(true);
    const [standaloneDocuments, setStandaloneDocuments] = useState<DocketDocument[]>([]);
    const [projects, setProjects] = useState<DocketProject[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    const refresh = useCallback(() => {
        invalidateDirectoryCache();
        setRefreshKey((key) => key + 1);
    }, []);

    useEffect(() => {
        if (!enabled) return;

        let cancelled = false;

        const now = Date.now();
        if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
            const cached = cache;
            queueMicrotask(() => {
                if (cancelled) return;
                setStandaloneDocuments(cached.standaloneDocuments);
                setProjects(cached.projects);
                setError(null);
                setLoading(false);
            });
            return () => {
                cancelled = true;
            };
        }

        queueMicrotask(() => {
            if (cancelled) return;
            setLoading(true);
            setError(null);
        });

        const projectsRequest = listProjects()
            .then(async (summaries) => {
                const { projectSummaries: summaryRows } =
                    resolveDirectoryListings(
                        { status: "fulfilled", value: summaries },
                        { status: "fulfilled", value: [] },
                    );
                if (!cancelled) {
                    setProjects(summaryRows);
                    setLoading(false);
                }

                const fullProjects = await Promise.allSettled(
                    summaries.map((project) => getProject(project.id)),
                );
                fullProjects.forEach((result, index) => {
                    if (result.status === "rejected") {
                        console.error(
                            `Failed to load project ${summaries[index].id}`,
                            result.reason,
                        );
                    }
                });

                const mergedProjects = mergeDirectoryResults(
                    summaryRows,
                    fullProjects,
                );
                if (!cancelled) setProjects(mergedProjects);

                return {
                    projects: mergedProjects,
                    fullyLoaded: fullProjects.every(
                        (result) => result.status === "fulfilled",
                    ),
                };
            })
            .catch((reason: unknown) => {
                console.error(PROJECT_DIRECTORY_ERROR, reason);
                if (!cancelled) {
                    setProjects([]);
                    setError(PROJECT_DIRECTORY_ERROR);
                    setLoading(false);
                }
                throw reason;
            });

        const documentsRequest = listStandaloneDocuments().then((documents) => {
            const { standaloneDocuments: sorted } = resolveDirectoryListings(
                { status: "fulfilled", value: [] },
                { status: "fulfilled", value: documents },
            );
            if (!cancelled) setStandaloneDocuments(sorted);
            return sorted;
        });

        void Promise.allSettled([projectsRequest, documentsRequest]).then(
            ([projectsResult, documentsResult]) => {
                if (
                    cancelled ||
                    projectsResult.status !== "fulfilled" ||
                    documentsResult.status !== "fulfilled" ||
                    !projectsResult.value.fullyLoaded
                ) {
                    return;
                }

                cache = {
                    standaloneDocuments: documentsResult.value,
                    projects: projectsResult.value.projects,
                    fetchedAt: Date.now(),
                };
            },
        );

        return () => {
            cancelled = true;
        };
    }, [enabled, refreshKey]);

    return { loading, standaloneDocuments, projects, error, refresh };
}
