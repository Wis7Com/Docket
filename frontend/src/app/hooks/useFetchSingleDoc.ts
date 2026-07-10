"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getApiBase } from "@/app/lib/docketApi";

/**
 * /display returns PDF bytes when a rendition exists, raw DOCX bytes for
 * Word documents, or UTF-8 text for text/markdown documents. Reporting
 * the type lets the caller pick the matching viewer.
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "docx" }
    | { type: "markdown"; text: string }
    | { type: "text"; text: string }
    | null;

// The `%PDF-` header must appear within the first 1024 bytes (the spec
// allows leading junk). Rejecting mislabeled bytes here keeps them out of
// pdf.js, whose InvalidPDFException would surface as a dev error overlay.
function looksLikePdf(buffer: ArrayBuffer): boolean {
    const bytes = new Uint8Array(buffer.slice(0, 1024));
    const marker = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
    for (let i = 0; i + marker.length <= bytes.length; i++) {
        let found = true;
        for (let j = 0; j < marker.length; j++) {
            if (bytes[i + j] !== marker[j]) {
                found = false;
                break;
            }
        }
        if (found) return true;
    }
    return false;
}

export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
) {
    const [result, setResult] = useState<DocResult>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const prevKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!documentId) return;
        const requestKey = `${documentId}:${versionId ?? "current"}`;
        if (requestKey === prevKeyRef.current) return;
        prevKeyRef.current = requestKey;

        setLoading(true);
        setError(null);
        setResult(null);

        let cancelled = false;

        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                if (cancelled) return;

                const apiBase = await getApiBase();
                const qs = versionId
                    ? `?version_id=${encodeURIComponent(versionId)}`
                    : "";
                const response = await fetch(
                    `${apiBase}/single-documents/${documentId}/display${qs}`,
                    {
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : {},
                    },
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (cancelled) return;

                const contentType =
                    response.headers.get("content-type") ?? "";
                if (contentType.includes("application/pdf")) {
                    const buffer = await response.arrayBuffer();
                    if (cancelled) return;
                    if (!looksLikePdf(buffer)) {
                        setError("This document could not be displayed.");
                        return;
                    }
                    setResult({ type: "pdf", buffer });
                } else if (contentType.includes("text/markdown")) {
                    const text = await response.text();
                    if (!cancelled) setResult({ type: "markdown", text });
                } else if (contentType.includes("text/plain")) {
                    const text = await response.text();
                    if (!cancelled) setResult({ type: "text", text });
                } else {
                    // Drain the body so the connection is reusable, but the
                    // bytes are useless to the PDF viewer — the caller will
                    // fall back to DocxView, which fetches `/docx` itself.
                    await response.arrayBuffer().catch(() => {});
                    if (!cancelled) setResult({ type: "docx" });
                }
            } catch {
                if (!cancelled) setError("Failed to load document.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            prevKeyRef.current = null;
        };
    }, [documentId, versionId]);

    return { result, loading, error };
}
