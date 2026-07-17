"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type FormEvent,
} from "react";
import {
    ChevronDown,
    ChevronUp,
    Copy,
    FileDown,
    Highlighter,
    MessageSquare,
    MessageSquarePlus,
    MousePointer2,
    Save,
    Search,
    Trash2,
    X,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import { DocketIcon } from "@/components/chat/docket-icon";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";
import {
    createPdfAnnotation,
    deletePdfAnnotation,
    exportAnnotatedPdf,
    generateDocumentOutline,
    getDocumentOcrRegions,
    getDocumentUrl,
    listPdfAnnotations,
    updatePdfAnnotation,
} from "@/app/lib/docketApi";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";
import { DocxView } from "./DocxView";
import { MarkdownDocView } from "./MarkdownDocView";
import { ImageDocView } from "./ImageDocView";
import type { CitationQuote, PdfAnnotation, PdfAnnotationRect } from "./types";
import {
    clearHighlights,
    getPdfJs,
    highlightQuote,
    STANDARD_FONT_DATA_URL,
} from "./highlightQuote";
import {
    buildCitationPromotionCreatePayload,
    buildPdfAnnotationCreatePayload,
    type PdfAnnotationCreatePayload,
} from "./pdfAnnotationActions";
import {
    clientRectsToPdfAnnotationRects,
    mergePdfAnnotationRects,
} from "./pdfGeometry";
import {
    DocumentNavigationPane,
    type DocumentNavigationItem,
} from "./DocumentNavigationPane";
import { buildHeuristicPdfOutline } from "./documentOutlineHeuristics";
import {
    documentOutlineStorageKey,
    loadGeneratedDocumentOutline,
    saveGeneratedDocumentOutline,
} from "./documentOutlineStorage";
import {
    ANNOTATION_COLORS,
    SIDE_PADDING,
    ZOOM_MAX,
    ZOOM_MIN,
    ZOOM_STEP,
    type ActivePdfSelection,
    type AnnotationMode,
    type PdfCommentEditor,
    type PdfContextMenu,
    type QuoteEntry,
    type RenderedPage,
} from "./docViewTypes";
import { createPdfAnnotationInteractions } from "./pdfAnnotationInteractions";
import { useAnnotationColorPalette } from "@/contexts/AnnotationColorPaletteContext";
import {
    COLOR_WHEEL_GRADIENT,
    PdfCustomColorPicker,
} from "./PdfCustomColorPicker";
import { ctrlZoomFactor, useCtrlZoom } from "@/lib/ctrlZoom";
import {
    clearFindHighlightLayer,
    findMatchesInTexts,
    normalizeFindText,
    paintFindHighlights,
} from "./pdfFind";
import { normalizedOcrRegionToPdfRect } from "./ocrRegionGeometry";
import { buildPdfAnnotationOverlayItems } from "./pdfAnnotationOverlay";
import { buildCitationNavigationEffectKey } from "./citationNavigation";

interface Props {
    doc: { document_id: string; version_id?: string | null } | null;
    /** Preferred: one or more (page, quote) pairs to highlight. */
    quotes?: CitationQuote[];
    /** Back-compat single-quote API. Ignored if `quotes` is provided. */
    quote?: string;
    fallbackPage?: number;
    /** Scroll to and select this saved annotation once it renders. */
    focusAnnotationId?: string | null;
    /** Bump to re-trigger focusing the same annotation id. */
    focusAnnotationKey?: number | string;
    /** Bump to re-trigger navigation for the same citation without reloading the PDF. */
    citationNavigationKey?: string | null;
    /** Called after a citation-navigation request has scrolled the viewer. */
    onCitationNavigationHandled?: (key: string) => void;
    /** Restored after a route remount when no citation click is pending. */
    initialScrollTop?: number | null;
    /** Persists the user's PDF scroll position for a route remount. */
    onScrollChange?: (top: number) => void;
    /** Reports progressive PDF page rendering: (renderedPages, totalPages). */
    onRenderProgress?: (rendered: number, total: number) => void;
    /** Reports saved annotation mutations so parents can refresh side lists. */
    onAnnotationsChanged?: (docId: string) => void;
    rounded?: boolean;
    bordered?: boolean;
}

type PdfDocumentProxy = import("pdfjs-dist").PDFDocumentProxy;
type PdfJsLib = typeof import("pdfjs-dist");
type PdfOutlineNode = Awaited<
    ReturnType<PdfDocumentProxy["getOutline"]>
>[number];
type PageSize = {
    width: number;
    height: number;
};
type PdfRenderRuntime = {
    doc: PdfDocumentProxy;
    lib: PdfJsLib;
    scale: number;
    renderRun: number;
    container: HTMLDivElement;
};

const PDF_RENDER_BUFFER_PAGES = 2;
const PDF_RENDER_MAX_LIVE_PAGES = 14;
const PDF_RENDER_CONCURRENCY = 1;

export function DocView({
    doc,
    quotes,
    quote,
    fallbackPage,
    focusAnnotationId,
    focusAnnotationKey,
    citationNavigationKey,
    onCitationNavigationHandled,
    initialScrollTop,
    onScrollChange,
    onRenderProgress,
    onAnnotationsChanged,
    rounded = true,
    bordered = true,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const pdfDocRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(
        null,
    );
    const renderedPagesRef = useRef<RenderedPage[]>([]);
    const pageWrappersRef = useRef<(HTMLDivElement | undefined)[]>([]);
    const pageSizesRef = useRef<PageSize[]>([]);
    const pdfRuntimeRef = useRef<PdfRenderRuntime | null>(null);
    const renderQueueRef = useRef<number[]>([]);
    const queuedRenderPagesRef = useRef<Set<number>>(new Set());
    const renderingPagesRef = useRef<Set<number>>(new Set());
    const activeRenderCountRef = useRef(0);
    const pendingRenderResolversRef = useRef<
        Map<number, Array<(page: RenderedPage | null) => void>>
    >(new Map());
    const resolvedQuotePagesRef = useRef<Map<string, number>>(new Map());
    const quoteListRef = useRef<QuoteEntry[]>([]);
    const annotationsRef = useRef<PdfAnnotation[]>([]);
    const activeSelectionRef = useRef<ActivePdfSelection | null>(null);
    const selectedAnnotationIdRef = useRef<string | null>(null);
    const docIdRef = useRef<string | null>(null);
    const versionIdRef = useRef<string | null>(null);
    const commentInputRef = useRef<HTMLTextAreaElement | null>(null);
    const zoomRef = useRef(1.0);
    const currentPageRef = useRef(1);
    const lastHandledCitationNavigationKeyRef = useRef<string | null>(null);
    const highlightRunRef = useRef(0);
    const pdfRenderRunRef = useRef(0);
    const annotationStatusTimerRef = useRef<number | null>(null);
    const scrollFrameRef = useRef<number | null>(null);
    const wheelZoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const annotationStatusRunRef = useRef(0);
    // Ref'd so renderPDF (a useCallback) always reports to the latest
    // handler without re-rendering the PDF when the parent re-renders.
    const onRenderProgressRef = useRef(onRenderProgress);
    const onScrollChangeRef = useRef(onScrollChange);
    useEffect(() => {
        onRenderProgressRef.current = onRenderProgress;
    });
    useEffect(() => {
        onScrollChangeRef.current = onScrollChange;
    });

    const quoteList: QuoteEntry[] = useMemo(() => {
        if (quotes?.length)
            return quotes.map((q) => ({
                page: q.page,
                quote: q.quote,
                citation: q.citation,
            }));
        if (quote) return [{ page: fallbackPage, quote }];
        return [];
    }, [quotes, quote, fallbackPage]);

    // Combine stable source-passage identity with the per-click request key so
    // selecting the same passage again still re-runs highlight-and-scroll.
    const citationNavigationEffectKey = buildCitationNavigationEffectKey(
        quoteList,
        citationNavigationKey,
    );

    const [containerWidth, setContainerWidth] = useState(0);
    const [zoom, setZoom] = useState(1.0);
    const [currentPage, setCurrentPage] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const [mode, setMode] = useState<AnnotationMode>("select");
    const { colors: annotationColors, replaceColor: replacePaletteColor } =
        useAnnotationColorPalette();
    const [selectedColorIndex, setSelectedColorIndex] = useState(0);
    const [annotationColor, setAnnotationColor] = useState(
        ANNOTATION_COLORS[0],
    );
    useEffect(() => {
        setAnnotationColor(
            annotationColors[selectedColorIndex] ?? annotationColors[0],
        );
    }, [annotationColors, selectedColorIndex]);
    // Custom-color popover target. Selections are snapshotted at open time so
    // applying still works after the quick menu or native selection is gone.
    const [customColorPicker, setCustomColorPicker] = useState<
        | {
              kind: "selection";
              x: number;
              y: number;
              text: string;
              rects: PdfAnnotationRect[];
              source?: "user" | "citation";
          }
        | { kind: "annotation"; annotationId: string; x: number; y: number }
        | { kind: "default"; x: number; y: number }
        | null
    >(null);
    // Find-in-document state. Matches are (page, ordinal-on-page) pairs; the
    // per-page text cache lets the whole document be searched without
    // rendering every page.
    const [findOpen, setFindOpen] = useState(false);
    const [findQuery, setFindQuery] = useState("");
    const [findMatches, setFindMatches] = useState<
        { page: number; indexOnPage: number }[]
    >([]);
    const [findActiveIndex, setFindActiveIndex] = useState(0);
    const findInputRef = useRef<HTMLInputElement>(null);
    const findRunRef = useRef(0);
    const findPageTextsRef = useRef(new Map<number, string[]>());
    // Snapshot for the render pipeline, which repaints find overlays on pages
    // rendered after the search ran (virtualized pages, zoom re-renders).
    const findPaintRef = useRef({
        open: false,
        query: "",
        matches: [] as { page: number; indexOnPage: number }[],
        activeIndex: 0,
    });
    findPaintRef.current = {
        open: findOpen,
        query: findQuery,
        matches: findMatches,
        activeIndex: findActiveIndex,
    };
    const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
    const [selectedAnnotationId, setSelectedAnnotationId] = useState<
        string | null
    >(null);
    const [annotationBusy, setAnnotationBusy] = useState(false);
    const [annotationError, setAnnotationError] = useState<string | null>(null);
    const [annotationStatus, setAnnotationStatus] = useState<string | null>(
        null,
    );
    const [activeSelection, setActiveSelection] =
        useState<ActivePdfSelection | null>(null);
    const [contextMenu, setContextMenu] = useState<PdfContextMenu | null>(null);
    const [commentEditor, setCommentEditor] = useState<PdfCommentEditor | null>(
        null,
    );
    const [commentDraft, setCommentDraft] = useState("");
    const [displayVersionId, setDisplayVersionId] = useState<string | null>(
        null,
    );
    const [annotationVersionId, setAnnotationVersionId] = useState<
        string | null
    >(null);
    const [navOpen, setNavOpen] = useState(true);
    const [navItems, setNavItems] = useState<DocumentNavigationItem[]>([]);
    const [activeNavId, setActiveNavId] = useState<string | null>(null);
    const [generatingNav, setGeneratingNav] = useState(false);
    const [navGenerateMessage, setNavGenerateMessage] = useState<string | null>(
        null,
    );
    const [outlineModel] = useSelectedModel();
    const generatedOutlineKey = documentOutlineStorageKey(
        "pdf",
        doc?.document_id ?? "unknown",
        displayVersionId ?? doc?.version_id,
    );
    const generatedOutlineKeyRef = useRef(generatedOutlineKey);
    generatedOutlineKeyRef.current = generatedOutlineKey;
    const navGenerationRef = useRef(0);
    const navGenerationBusyRef = useRef(false);
    useEffect(() => {
        navGenerationRef.current += 1;
        navGenerationBusyRef.current = false;
        setGeneratingNav(false);
        setNavGenerateMessage(null);
    }, [generatedOutlineKey]);
    // Set when pdf.js rejects the fetched bytes (e.g. InvalidPDFException). We
    // surface a readable message instead of letting the rejection escape as an
    // unhandled error that crashes the renderer.
    const [pdfLoadError, setPdfLoadError] = useState<string | null>(null);

    const { result, loading, error } = useFetchSingleDoc(
        doc?.document_id ?? null,
        displayVersionId ?? doc?.version_id ?? null,
    );

    // /display returned DOCX bytes — the active version has no PDF
    // rendition, so fall back to docx-preview (still applies citation
    // highlighting via the same `quotes` API).
    const fallbackToDocx = result?.type === "docx";

    // Track container width via ResizeObserver so re-renders fire on resize
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            setContainerWidth(entries[0]?.contentRect.width ?? 0);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Track current page via scroll position
    useEffect(() => {
        const scrollEl = scrollContainerRef.current;
        if (!scrollEl) return;

        const runScrollUpdate = () => {
            scrollFrameRef.current = null;
            onScrollChangeRef.current?.(scrollEl.scrollTop);
            const pages = pageWrappersRef.current;
            if (!pages.length) return;
            const scrollCenter = scrollEl.scrollTop + scrollEl.clientHeight / 2;
            let closest = 0;
            let closestDist = Infinity;
            pages.forEach((wrapper, i) => {
                if (!wrapper) return;
                const pageCenter = wrapper.offsetTop + wrapper.clientHeight / 2;
                const dist = Math.abs(pageCenter - scrollCenter);
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = i;
                }
            });
            const nextPage = closest + 1;
            currentPageRef.current = nextPage;
            setCurrentPage(nextPage);
            const active =
                [...navItems]
                    .reverse()
                    .find((item) => (item.page ?? 0) <= nextPage)?.id ??
                navItems[0]?.id ??
                null;
            setActiveNavId(active);
            scheduleWindowRender();
        };
        const handleScroll = () => {
            if (scrollFrameRef.current !== null) return;
            scrollFrameRef.current =
                window.requestAnimationFrame(runScrollUpdate);
        };

        scrollEl.addEventListener("scroll", handleScroll, { passive: true });
        handleScroll();
        return () => {
            scrollEl.removeEventListener("scroll", handleScroll);
            if (scrollFrameRef.current !== null) {
                window.cancelAnimationFrame(scrollFrameRef.current);
                scrollFrameRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navItems]);

    useEffect(() => {
        setDisplayVersionId(null);
        setAnnotations([]);
        setSelectedAnnotationId(null);
        setAnnotationError(null);
        annotationStatusRunRef.current += 1;
        clearAnnotationStatusTimer();
        setAnnotationStatus(null);
        setActiveSelection(null);
        setContextMenu(null);
        setCommentEditor(null);
        setCommentDraft("");
        setAnnotationVersionId(null);
        setNavItems([]);
        setActiveNavId(null);
        setGeneratingNav(false);
        setNavGenerateMessage(null);
        // clearAnnotationStatusTimer is declared below; it is stable and only
        // touches a ref, so this reset effect stays keyed to the document.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [doc?.document_id, doc?.version_id]);

    useEffect(() => {
        annotationsRef.current = annotations;
    }, [annotations]);

    useEffect(() => {
        activeSelectionRef.current = activeSelection;
    }, [activeSelection]);

    useEffect(() => {
        selectedAnnotationIdRef.current = selectedAnnotationId;
    }, [selectedAnnotationId]);

    useEffect(() => {
        docIdRef.current = doc?.document_id ?? null;
        versionIdRef.current = displayVersionId ?? doc?.version_id ?? null;
    }, [doc?.document_id, doc?.version_id, displayVersionId]);

    useEffect(() => {
        return () => {
            if (annotationStatusTimerRef.current != null) {
                window.clearTimeout(annotationStatusTimerRef.current);
                annotationStatusTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!commentEditor) return;
        const id = window.requestAnimationFrame(() => {
            commentInputRef.current?.focus();
            commentInputRef.current?.select();
        });
        return () => window.cancelAnimationFrame(id);
    }, [commentEditor]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setFindOpen(false);
            setActiveSelection(null);
            setSelectedAnnotationId(null);
            setContextMenu(null);
            setCommentEditor(null);
            setCommentDraft("");
            setCustomColorPicker(null);
            window.getSelection()?.removeAllRanges();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    async function copyText(text: string) {
        if (!text.trim()) return;
        await navigator.clipboard?.writeText(text);
        showAnnotationStatus("Copied", 1600);
        setContextMenu(null);
    }

    const clearAnnotationStatusTimer = useCallback(() => {
        if (annotationStatusTimerRef.current == null) return;
        window.clearTimeout(annotationStatusTimerRef.current);
        annotationStatusTimerRef.current = null;
    }, []);

    const showAnnotationStatus = useCallback(
        (message: string | null, autoClearMs?: number) => {
            annotationStatusRunRef.current += 1;
            const run = annotationStatusRunRef.current;
            clearAnnotationStatusTimer();
            setAnnotationStatus(message);
            if (!message || autoClearMs == null) return;
            annotationStatusTimerRef.current = window.setTimeout(() => {
                if (annotationStatusRunRef.current !== run) return;
                annotationStatusTimerRef.current = null;
                setAnnotationStatus(null);
            }, autoClearMs);
        },
        [clearAnnotationStatusTimer],
    );

    const { paintAnnotationOverlays, paintSelectionHandles } = useMemo(
        () =>
            createPdfAnnotationInteractions({
                renderedPagesRef,
                annotationsRef,
                activeSelectionRef,
                selectedAnnotationIdRef,
                docIdRef,
                setAnnotations,
                setActiveSelection,
                setSelectedAnnotationId,
                setContextMenu,
                setAnnotationBusy,
                setAnnotationError,
                setAnnotationVersionId,
                showAnnotationStatus,
            }),
        [showAnnotationStatus],
    );

    useEffect(() => {
        paintAnnotationOverlays(annotations);
    }, [selectedAnnotationId, annotations, paintAnnotationOverlays]);

    useEffect(() => {
        paintSelectionHandles(activeSelection);
    }, [activeSelection, paintSelectionHandles]);

    // Search the whole document (debounced) while the find bar is open. The
    // per-page text cache means unrendered (virtualized) pages are searched
    // without rendering them.
    useEffect(() => {
        if (!findOpen || result?.type !== "pdf") return;
        const runId = ++findRunRef.current;
        if (!normalizeFindText(findQuery)) {
            setFindMatches([]);
            setFindActiveIndex(0);
            return;
        }
        const timer = window.setTimeout(() => {
            void (async () => {
                const pdfDoc = pdfDocRef.current;
                if (!pdfDoc) return;
                const matches: { page: number; indexOnPage: number }[] = [];
                for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
                    const texts = await getFindPageTexts(pageNum);
                    if (runId !== findRunRef.current) return;
                    findMatchesInTexts(texts, findQuery).forEach(
                        (_, indexOnPage) =>
                            matches.push({ page: pageNum, indexOnPage }),
                    );
                }
                if (runId !== findRunRef.current) return;
                setFindMatches(matches);
                const fromPage = currentPageRef.current;
                const startIndex = matches.findIndex((m) => m.page >= fromPage);
                setFindActiveIndex(startIndex === -1 ? 0 : startIndex);
            })();
        }, 200);
        return () => window.clearTimeout(timer);
    }, [findOpen, findQuery, result]);

    // Paint match overlays on rendered pages and keep the active match in
    // view (rendering its page first when it is outside the live window).
    useEffect(() => {
        if (result?.type !== "pdf") return;
        if (!findOpen) {
            renderedPagesRef.current.forEach((entry) => {
                if (entry) clearFindHighlightLayer(entry.wrapper);
            });
            return;
        }
        let cancelled = false;
        void (async () => {
            const active = findMatches[findActiveIndex];
            if (active) await ensurePageRendered(active.page);
            if (cancelled) return;
            let activeRect: DOMRect | null = null;
            for (let idx = 0; idx < renderedPagesRef.current.length; idx++) {
                if (!renderedPagesRef.current[idx]) continue;
                const rect = paintFindOnPage(idx + 1);
                if (rect) activeRect = rect;
            }
            const container = scrollContainerRef.current;
            if (activeRect && container) {
                const containerRect = container.getBoundingClientRect();
                const offset =
                    activeRect.top -
                    containerRect.top -
                    containerRect.height / 2 +
                    activeRect.height / 2;
                if (Math.abs(offset) > 4) container.scrollTop += offset;
            }
        })();
        return () => {
            cancelled = true;
        };
        // ensurePageRendered reads live refs; a stable closure is correct.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [findOpen, findMatches, findActiveIndex, result]);

    // Ctrl/Cmd+F opens the find bar for the visible PDF viewer.
    useEffect(() => {
        if (result?.type !== "pdf") return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
            if (event.key !== "f" && event.key !== "F") return;
            const container = scrollContainerRef.current;
            if (!container || container.getBoundingClientRect().width === 0) {
                return;
            }
            event.preventDefault();
            openFindBar();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [result]);

    useEffect(() => {
        if (!doc?.document_id || result?.type !== "pdf") return;
        let cancelled = false;
        (async () => {
            try {
                setAnnotationError(null);
                const rows = await listPdfAnnotations(
                    doc.document_id,
                    annotationVersionId ??
                        displayVersionId ??
                        doc.version_id ??
                        null,
                );
                if (!cancelled) setAnnotations(rows);
            } catch (err) {
                if (!cancelled) {
                    setAnnotationError(
                        err instanceof Error
                            ? err.message
                            : "Failed to load annotations.",
                    );
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [
        doc?.document_id,
        doc?.version_id,
        annotationVersionId,
        displayVersionId,
        result,
    ]);

    async function getFindPageTexts(pageNum: number): Promise<string[]> {
        const cached = findPageTextsRef.current.get(pageNum);
        if (cached) return cached;
        const pdfDoc = pdfDocRef.current;
        if (!pdfDoc) return [];
        const page = await pdfDoc.getPage(pageNum);
        const content = await page.getTextContent();
        const texts = (content.items as Array<{ str?: string }>).map(
            (item) => item.str ?? "",
        );
        findPageTextsRef.current.set(pageNum, texts);
        return texts;
    }

    function paintFindOnPage(pageNum: number): DOMRect | null {
        const pageEntry = renderedPagesRef.current[pageNum - 1];
        if (!pageEntry) return null;
        const { open, query, matches, activeIndex } = findPaintRef.current;
        if (!open || !normalizeFindText(query)) {
            clearFindHighlightLayer(pageEntry.wrapper);
            return null;
        }
        const texts = pageEntry.textDivs.map((div) => div.textContent ?? "");
        const pageMatches = findMatchesInTexts(texts, query);
        const active = matches[activeIndex];
        const activeOnPage = active?.page === pageNum ? active.indexOnPage : -1;
        return paintFindHighlights(pageEntry, pageMatches, activeOnPage);
    }

    function stepFindMatch(delta: number) {
        setFindActiveIndex((prev) => {
            const total = findMatches.length;
            if (total === 0) return 0;
            return (prev + delta + total) % total;
        });
    }

    function openFindBar() {
        setFindOpen(true);
        window.requestAnimationFrame(() => {
            findInputRef.current?.focus();
            findInputRef.current?.select();
        });
    }

    function clientRectsToPdfRects(
        clientRects: DOMRect[],
    ): PdfAnnotationRect[] {
        return mergePdfAnnotationRects(
            clientRectsToPdfAnnotationRects(
                clientRects,
                renderedPagesRef.current.map((pageEntry, idx) => ({
                    pageNumber: idx + 1,
                    wrapperRect: pageEntry.wrapper.getBoundingClientRect(),
                    viewport: pageEntry.viewport,
                })),
            ),
        );
    }

    function readCurrentPdfSelection(): ActivePdfSelection | null {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return null;
        const root = scrollContainerRef.current;
        const anchorNode = selection.anchorNode;
        const focusNode = selection.focusNode;
        if (
            root &&
            anchorNode &&
            focusNode &&
            !root.contains(anchorNode) &&
            !root.contains(focusNode)
        ) {
            return null;
        }
        const selectedText = selection.toString().trim();
        if (!selectedText) return null;
        const rects: DOMRect[] = [];
        for (let i = 0; i < selection.rangeCount; i++) {
            rects.push(...Array.from(selection.getRangeAt(i).getClientRects()));
        }
        const pdfRects = clientRectsToPdfRects(rects);
        if (pdfRects.length === 0) return null;
        return { text: selectedText, rects: pdfRects, source: "user" };
    }

    function readTemporaryHighlightSelection(
        target: HTMLElement | null,
    ): ActivePdfSelection | null {
        const highlight = target?.closest<HTMLElement>(".pdf-text-highlight");
        if (!highlight) return null;
        const root = scrollContainerRef.current;
        if (root && !root.contains(highlight)) return null;

        const highlightEls = Array.from(
            root?.querySelectorAll<HTMLElement>(".pdf-text-highlight") ?? [],
        );
        if (highlightEls.length === 0) return null;

        const rects = highlightEls.flatMap((el) =>
            Array.from(el.getClientRects()),
        );
        const pdfRects = clientRectsToPdfRects(rects);
        if (pdfRects.length === 0) return null;

        const quoteText =
            quoteListRef.current
                .map((q) => q.quote)
                .join("\n\n")
                .trim() ||
            highlightEls
                .map((el) => el.textContent?.trim() ?? "")
                .filter(Boolean)
                .join(" ");
        if (!quoteText) return null;

        return {
            text: quoteText,
            rects: pdfRects,
            source: "citation",
        };
    }

    function collectTemporaryHighlightRects(): PdfAnnotationRect[] {
        const rects: DOMRect[] = [];
        for (const pageEntry of renderedPagesRef.current) {
            if (!pageEntry) continue;
            pageEntry.wrapper
                .querySelectorAll<HTMLElement>(".pdf-text-highlight")
                .forEach((el) => rects.push(el.getBoundingClientRect()));
        }
        return clientRectsToPdfRects(rects);
    }

    function buildSelectionCreatePayload(args: {
        rects: PdfAnnotationRect[];
        text: string;
        source?: "user" | "citation";
        annotationType: "highlight" | "comment";
        color: string;
        comment?: string | null;
    }): PdfAnnotationCreatePayload | null {
        if (args.source === "citation" && args.annotationType === "highlight") {
            return buildCitationPromotionCreatePayload({
                rects: args.rects,
                quoteList: quoteListRef.current.length
                    ? quoteListRef.current
                    : [{ quote: args.text }],
                color: args.color,
                displayVersionId: annotationVersionId ?? displayVersionId,
                documentVersionId: doc?.version_id ?? null,
            });
        }

        const firstCitation = quoteListRef.current.find(
            (q) => q.citation,
        )?.citation;
        return buildPdfAnnotationCreatePayload({
            rects: args.rects,
            annotationType: args.annotationType,
            color: args.color,
            displayVersionId: annotationVersionId ?? displayVersionId,
            documentVersionId: doc?.version_id ?? null,
            quote: args.text || null,
            comment: args.comment ?? null,
            source: args.source === "citation" ? "citation_promotion" : "user",
            sourceCitation:
                args.source === "citation" && firstCitation
                    ? (firstCitation as unknown as Record<string, unknown>)
                    : null,
        });
    }

    function normalizeQuoteText(value: string): string {
        return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    }

    function quotePageCacheKey(entry: QuoteEntry): string {
        return `${entry.page ?? ""}:${entry.quote}`;
    }

    function clearRenderQueue() {
        renderQueueRef.current = [];
        queuedRenderPagesRef.current.clear();
        renderingPagesRef.current.clear();
        activeRenderCountRef.current = 0;
        for (const resolvers of pendingRenderResolversRef.current.values()) {
            resolvers.forEach((resolve) => resolve(null));
        }
        pendingRenderResolversRef.current.clear();
    }

    function destroyPdfDocument(pdfDoc: import("pdfjs-dist").PDFDocumentProxy) {
        Promise.resolve(pdfDoc.destroy()).catch((err) => {
            console.warn("PDF destroy failed", err);
        });
    }

    function destroyCurrentPdfDocument() {
        const pdfDoc = pdfDocRef.current;
        pdfDocRef.current = null;
        if (pdfDoc) destroyPdfDocument(pdfDoc);
    }

    function isCurrentPdfRuntime(runtime: PdfRenderRuntime) {
        return (
            runtime.renderRun === pdfRenderRunRef.current &&
            pdfRuntimeRef.current === runtime &&
            containerRef.current === runtime.container &&
            runtime.container.isConnected
        );
    }

    function scaledPageSize(pageNum: number, scale: number): PageSize {
        const natural =
            pageSizesRef.current[pageNum - 1] ?? pageSizesRef.current[0];
        return {
            width: Math.max(1, (natural?.width ?? 1) * scale),
            height: Math.max(1, (natural?.height ?? 1) * scale),
        };
    }

    function resetWrapperToPlaceholder(
        wrapper: HTMLDivElement,
        pageNum: number,
        scale: number,
    ) {
        const size = scaledPageSize(pageNum, scale);
        wrapper.dataset.pdfPageNumber = String(pageNum);
        wrapper.className = "shadow-md";
        wrapper.style.position = "relative";
        wrapper.style.margin = "0 auto 8px";
        wrapper.style.width = `${size.width}px`;
        wrapper.style.height = `${size.height}px`;
        wrapper.style.background = "#f8fafc";
        wrapper.style.overflow = "hidden";
        wrapper.style.display = "block";
        wrapper.innerHTML = "";

        const placeholder = document.createElement("div");
        placeholder.textContent = String(pageNum);
        placeholder.style.position = "absolute";
        placeholder.style.inset = "0";
        placeholder.style.display = "flex";
        placeholder.style.alignItems = "center";
        placeholder.style.justifyContent = "center";
        placeholder.style.color = "#94a3b8";
        placeholder.style.fontSize = "12px";
        placeholder.style.userSelect = "none";
        wrapper.appendChild(placeholder);
    }

    function resolvePageRender(
        pageNum: number,
        pageEntry: RenderedPage | null,
    ) {
        const resolvers = pendingRenderResolversRef.current.get(pageNum);
        if (!resolvers) return;
        pendingRenderResolversRef.current.delete(pageNum);
        resolvers.forEach((resolve) => resolve(pageEntry));
    }

    function evictRenderedPage(pageNum: number) {
        const pageEntry = renderedPagesRef.current[pageNum - 1];
        const runtime = pdfRuntimeRef.current;
        const wrapper = pageWrappersRef.current[pageNum - 1];
        if (!pageEntry || !runtime || !wrapper) return;
        pageEntry.page.cleanup();
        pageEntry.canvas.width = 0;
        pageEntry.canvas.height = 0;
        delete renderedPagesRef.current[pageNum - 1];
        resetWrapperToPlaceholder(wrapper, pageNum, runtime.scale);
    }

    function currentVisiblePages(bufferPages = PDF_RENDER_BUFFER_PAGES) {
        const scrollEl = scrollContainerRef.current;
        const wrappers = pageWrappersRef.current;
        if (!scrollEl || wrappers.length === 0) {
            return [currentPageRef.current];
        }
        const top = scrollEl.scrollTop;
        const bottom = top + scrollEl.clientHeight;
        const visible: number[] = [];
        wrappers.forEach((wrapper, index) => {
            if (!wrapper) return;
            const pageTop = wrapper.offsetTop;
            const pageBottom = pageTop + wrapper.offsetHeight;
            if (pageBottom >= top && pageTop <= bottom) visible.push(index + 1);
        });
        if (visible.length === 0) visible.push(currentPageRef.current);
        const first = Math.max(1, Math.min(...visible) - bufferPages);
        const last = Math.min(
            wrappers.length,
            Math.max(...visible) + bufferPages,
        );
        return Array.from(
            { length: last - first + 1 },
            (_, idx) => first + idx,
        );
    }

    function evictDistantRenderedPages(keepPages: Set<number>) {
        const rendered = renderedPagesRef.current
            .map((entry, index) => (entry ? index + 1 : null))
            .filter((pageNum): pageNum is number => pageNum !== null);
        const current = currentPageRef.current;
        const candidates = rendered
            .filter((pageNum) => !keepPages.has(pageNum))
            .sort((a, b) => Math.abs(b - current) - Math.abs(a - current));
        for (const pageNum of candidates) {
            if (Math.abs(pageNum - current) <= PDF_RENDER_BUFFER_PAGES + 2)
                continue;
            evictRenderedPage(pageNum);
        }
        if (
            renderedPagesRef.current.filter(Boolean).length <=
            PDF_RENDER_MAX_LIVE_PAGES
        )
            return;
        while (
            renderedPagesRef.current.filter(Boolean).length >
                PDF_RENDER_MAX_LIVE_PAGES &&
            candidates.length
        ) {
            const pageNum = candidates.shift();
            if (pageNum) evictRenderedPage(pageNum);
        }
    }

    function enqueuePageRender(pageNum: number, priority = false) {
        const runtime = pdfRuntimeRef.current;
        if (!runtime) return;
        if (pageNum < 1 || pageNum > runtime.doc.numPages) return;
        if (renderedPagesRef.current[pageNum - 1]) return;
        if (renderingPagesRef.current.has(pageNum)) return;

        if (queuedRenderPagesRef.current.has(pageNum)) {
            if (priority) {
                renderQueueRef.current = renderQueueRef.current.filter(
                    (queued) => queued !== pageNum,
                );
                renderQueueRef.current.unshift(pageNum);
            }
            return;
        }

        queuedRenderPagesRef.current.add(pageNum);
        if (priority) renderQueueRef.current.unshift(pageNum);
        else renderQueueRef.current.push(pageNum);
        pumpRenderQueue();
    }

    function scheduleWindowRender(centerPage?: number) {
        const runtime = pdfRuntimeRef.current;
        if (!runtime) return;
        const pages =
            centerPage == null
                ? currentVisiblePages()
                : Array.from(
                      {
                          length:
                              Math.min(
                                  runtime.doc.numPages,
                                  centerPage + PDF_RENDER_BUFFER_PAGES,
                              ) -
                              Math.max(
                                  1,
                                  centerPage - PDF_RENDER_BUFFER_PAGES,
                              ) +
                              1,
                      },
                      (_, idx) =>
                          Math.max(1, centerPage - PDF_RENDER_BUFFER_PAGES) +
                          idx,
                  );
        const keepPages = new Set(pages);
        for (const pageNum of pages) enqueuePageRender(pageNum);
        evictDistantRenderedPages(keepPages);
    }

    function pumpRenderQueue() {
        while (
            activeRenderCountRef.current < PDF_RENDER_CONCURRENCY &&
            renderQueueRef.current.length > 0
        ) {
            const pageNum = renderQueueRef.current.shift();
            if (!pageNum) return;
            queuedRenderPagesRef.current.delete(pageNum);
            if (renderedPagesRef.current[pageNum - 1]) {
                resolvePageRender(
                    pageNum,
                    renderedPagesRef.current[pageNum - 1],
                );
                continue;
            }
            const runtime = pdfRuntimeRef.current;
            if (!runtime) {
                resolvePageRender(pageNum, null);
                continue;
            }
            activeRenderCountRef.current += 1;
            renderingPagesRef.current.add(pageNum);
            void renderPageNow(pageNum, runtime)
                .then((pageEntry) => {
                    resolvePageRender(pageNum, pageEntry);
                })
                .finally(() => {
                    renderingPagesRef.current.delete(pageNum);
                    activeRenderCountRef.current = Math.max(
                        0,
                        activeRenderCountRef.current - 1,
                    );
                    pumpRenderQueue();
                });
        }
    }

    async function renderPageNow(
        pageNum: number,
        runtime: PdfRenderRuntime,
    ): Promise<RenderedPage | null> {
        if (!isCurrentPdfRuntime(runtime)) return null;
        const existing = renderedPagesRef.current[pageNum - 1];
        if (existing) return existing;

        const wrapper = pageWrappersRef.current[pageNum - 1];
        if (!wrapper) return null;

        const page = await runtime.doc.getPage(pageNum);
        if (!isCurrentPdfRuntime(runtime)) return null;
        // Page sizes are measured lazily. Initial citation navigation must not
        // await getPage() for every page in a several-hundred-page PDF before
        // the cited page can be painted.
        const naturalViewport = page.getViewport({ scale: 1 });
        pageSizesRef.current[pageNum - 1] = {
            width: naturalViewport.width,
            height: naturalViewport.height,
        };
        const viewport = page.getViewport({ scale: runtime.scale });
        resetWrapperToPlaceholder(wrapper, pageNum, runtime.scale);
        wrapper.innerHTML = "";
        wrapper.style.background = "#ffffff";

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.display = "block";
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        wrapper.appendChild(canvas);

        const pageEntry: RenderedPage = {
            page,
            viewport,
            wrapper,
            canvas,
            textDivs: [],
        };

        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "pdf-text-layer";
        textLayerDiv.style.position = "absolute";
        textLayerDiv.style.left = "0";
        textLayerDiv.style.top = "0";
        textLayerDiv.style.width = `${viewport.width}px`;
        textLayerDiv.style.height = `${viewport.height}px`;
        textLayerDiv.style.setProperty("--scale-factor", String(runtime.scale));
        wrapper.appendChild(textLayerDiv);

        const textLayer = new runtime.lib.TextLayer({
            textContentSource: page.streamTextContent(),
            container: textLayerDiv,
            viewport,
        });
        const textLayerPromise = textLayer
            .render()
            .then(() => {
                pageEntry.textDivs = textLayer.textDivs;
            })
            .catch((e) => {
                console.error("PDF text layer render error", e);
            });

        const task = page.render({ canvasContext: ctx, viewport });
        const renderPromise = task.promise.catch((e: unknown) => {
            if (
                (e as { name?: string })?.name !== "RenderingCancelledException"
            ) {
                console.error("PDF render error", e);
            }
        });
        await Promise.all([textLayerPromise, renderPromise]);
        if (!isCurrentPdfRuntime(runtime)) return null;

        renderedPagesRef.current[pageNum - 1] = pageEntry;
        await applyHighlightsToPage(pageNum, quoteListRef.current);
        paintAnnotationOverlays(annotationsRef.current);
        paintSelectionHandles(activeSelectionRef.current);
        paintFindOnPage(pageNum);
        return pageEntry;
    }

    function ensurePageRendered(pageNum: number): Promise<RenderedPage | null> {
        const existing = renderedPagesRef.current[pageNum - 1];
        if (existing) return Promise.resolve(existing);
        const runtime = pdfRuntimeRef.current;
        if (!runtime || pageNum < 1 || pageNum > runtime.doc.numPages) {
            return Promise.resolve(null);
        }
        const promise = new Promise<RenderedPage | null>((resolve) => {
            const resolvers =
                pendingRenderResolversRef.current.get(pageNum) ?? [];
            resolvers.push(resolve);
            pendingRenderResolversRef.current.set(pageNum, resolvers);
        });
        enqueuePageRender(pageNum, true);
        return promise;
    }

    async function locateQuotePage(
        entry: QuoteEntry,
        runId: number,
    ): Promise<number | null> {
        const runtime = pdfRuntimeRef.current;
        if (!runtime) return null;
        const cacheKey = quotePageCacheKey(entry);
        const cached = resolvedQuotePagesRef.current.get(cacheKey);
        if (cached) return cached;

        const segments = entry.quote
            .split(/\.{3}|…/)
            .map((segment) => normalizeQuoteText(segment))
            .filter(Boolean);
        if (segments.length === 0) return null;

        for (let pageNum = 1; pageNum <= runtime.doc.numPages; pageNum++) {
            if (
                runId !== highlightRunRef.current ||
                !isCurrentPdfRuntime(runtime)
            ) {
                return null;
            }
            const page = await runtime.doc.getPage(pageNum);
            const content = await page.getTextContent();
            const pageText = (content.items as Array<{ str?: string }>)
                .map((item) => item.str ?? "")
                .join("");
            const normalized = normalizeQuoteText(pageText);
            const found = segments.some((segment) =>
                normalized.includes(segment.slice(0, 30)),
            );
            if (found) {
                resolvedQuotePagesRef.current.set(cacheKey, pageNum);
                return pageNum;
            }
        }
        return null;
    }

    async function applyHighlightsToPage(
        pageNum: number,
        list: QuoteEntry[],
    ): Promise<boolean> {
        const pageEntry = renderedPagesRef.current[pageNum - 1];
        if (!pageEntry) return false;
        clearHighlights(pageEntry.textDivs);
        let foundAny = false;
        for (const entry of list) {
            const resolvedPage =
                entry.page ??
                resolvedQuotePagesRef.current.get(quotePageCacheKey(entry));
            if (resolvedPage !== pageNum) continue;
            let found = await highlightQuote(pageEntry.textDivs, entry.quote);
            if (!found && resolvedPage === pageNum) {
                found = await paintOcrCitationFallback(
                    pageEntry,
                    pageNum,
                    entry.quote,
                );
            }
            if (found) foundAny = true;
        }
        return foundAny;
    }

    function clearOcrCitationLayers() {
        for (const page of renderedPagesRef.current) {
            page?.wrapper
                .querySelectorAll(".pdf-ocr-citation-layer")
                .forEach((element) => element.remove());
        }
    }

    async function paintOcrCitationFallback(
        pageEntry: RenderedPage,
        pageNumber: number,
        citation: string,
    ): Promise<boolean> {
        const documentId = docIdRef.current;
        if (!documentId) return false;
        const match = await getDocumentOcrRegions(
            documentId,
            versionIdRef.current,
            pageNumber,
            citation,
        ).catch(() => null);
        if (!match?.regions.length) return false;
        const natural = pageEntry.page.getViewport({ scale: 1 });
        const annotation: PdfAnnotation = {
            id: `ocr-citation-${pageNumber}`,
            document_id: documentId,
            version_id: versionIdRef.current,
            user_id: "",
            page_number: pageNumber,
            annotation_type: "highlight",
            color: "#ffe066",
            quote: citation,
            comment: null,
            rects: match.regions.map((region) =>
                normalizedOcrRegionToPdfRect(region.bbox, pageNumber, natural),
            ),
            source: "citation_promotion",
            source_citation: null,
            created_at: "",
            updated_at: "",
        };
        let layer = pageEntry.wrapper.querySelector<HTMLDivElement>(
            ".pdf-ocr-citation-layer",
        );
        if (!layer) {
            layer = document.createElement("div");
            layer.className = "pdf-ocr-citation-layer";
            Object.assign(layer.style, {
                position: "absolute",
                left: "0",
                top: "0",
                width: `${pageEntry.viewport.width}px`,
                height: `${pageEntry.viewport.height}px`,
                pointerEvents: "none",
            });
            pageEntry.wrapper.appendChild(layer);
        }
        for (const item of buildPdfAnnotationOverlayItems(
            [annotation],
            pageNumber,
            pageEntry.viewport,
        )) {
            const marker = document.createElement("div");
            marker.className = "pdf-ocr-citation";
            Object.assign(marker.style, {
                position: "absolute",
                left: `${item.marker.left}px`,
                top: `${item.marker.top}px`,
                width: `${item.marker.width}px`,
                height: `${item.marker.height}px`,
                background: item.marker.background,
                opacity: item.marker.opacity,
                mixBlendMode: "multiply",
            });
            layer.appendChild(marker);
        }
        return true;
    }

    // Highlights requested quotes by rendering only the pages that can contain them.
    // Returns the 1-based page number of the first successfully highlighted entry.
    const applyHighlights = useCallback(
        async (
            list: QuoteEntry[],
            runId = ++highlightRunRef.current,
        ): Promise<number | null> => {
            for (const p of renderedPagesRef.current) {
                if (!p) continue;
                clearHighlights(p.textDivs);
            }
            clearOcrCitationLayers();

            let firstHitPage: number | null = null;
            for (const entry of list) {
                let candidatePage = entry.page ?? null;
                if (candidatePage == null) {
                    candidatePage = await locateQuotePage(entry, runId);
                }
                if (runId !== highlightRunRef.current) return null;
                if (candidatePage == null) continue;

                const pageEntry = await ensurePageRendered(candidatePage);
                if (runId !== highlightRunRef.current) return null;
                if (!pageEntry) continue;

                let found = await highlightQuote(
                    pageEntry.textDivs,
                    entry.quote,
                );
                if (runId !== highlightRunRef.current) return null;
                if (!found && entry.page) {
                    const fallbackPage = await locateQuotePage(entry, runId);
                    if (
                        fallbackPage &&
                        fallbackPage !== entry.page &&
                        runId === highlightRunRef.current
                    ) {
                        const fallbackEntry =
                            await ensurePageRendered(fallbackPage);
                        found = fallbackEntry
                            ? await highlightQuote(
                                  fallbackEntry.textDivs,
                                  entry.quote,
                              )
                            : false;
                        candidatePage = fallbackPage;
                    }
                }
                if (!found && candidatePage === entry.page) {
                    found = await paintOcrCitationFallback(
                        pageEntry,
                        candidatePage,
                        entry.quote,
                    );
                }
                if (found && firstHitPage === null)
                    firstHitPage = candidatePage;
            }
            return firstHitPage;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    async function pdfOutlineDestPage(
        pdfDoc: PdfDocumentProxy,
        dest: PdfOutlineNode["dest"],
    ): Promise<number | null> {
        if (!dest) return null;
        const resolved =
            typeof dest === "string" ? await pdfDoc.getDestination(dest) : dest;
        if (!resolved?.length) return null;
        const first = resolved[0];
        if (typeof first === "number") {
            return Math.min(pdfDoc.numPages, Math.max(1, first + 1));
        }
        if (first && typeof first === "object") {
            try {
                return (await pdfDoc.getPageIndex(first)) + 1;
            } catch {
                return null;
            }
        }
        return null;
    }

    async function buildPdfNavigationItems(
        pdfDoc: PdfDocumentProxy,
    ): Promise<DocumentNavigationItem[]> {
        const outline = await pdfDoc.getOutline();
        if (!outline?.length) return [];
        const items: DocumentNavigationItem[] = [];
        let index = 0;
        const visit = async (nodes: PdfOutlineNode[], level: number) => {
            for (const node of nodes) {
                const title = node.title?.trim();
                const page = await pdfOutlineDestPage(pdfDoc, node.dest);
                if (title && page) {
                    items.push({
                        id: `pdf-outline-${index++}`,
                        title,
                        level,
                        page,
                    });
                }
                if (node.items?.length) {
                    await visit(node.items as PdfOutlineNode[], level + 1);
                }
            }
        };
        await visit(outline, 1);
        return items;
    }

    async function generateHeuristicNavItems() {
        const pdfDoc = pdfDocRef.current;
        if (!pdfDoc || navGenerationBusyRef.current) return;
        const generation = ++navGenerationRef.current;
        const requestKey = generatedOutlineKey;
        const isCurrent = () =>
            generation === navGenerationRef.current &&
            requestKey === generatedOutlineKeyRef.current;
        navGenerationBusyRef.current = true;
        setGeneratingNav(true);
        setNavGenerateMessage(null);
        try {
            let items = await buildHeuristicPdfOutline(pdfDoc);
            if (!isCurrent()) return;
            let fallbackMessage: string | undefined;
            if (!items.length && doc?.document_id) {
                const fallback = await generateDocumentOutline(
                    doc.document_id,
                    {
                        versionId: displayVersionId ?? doc.version_id,
                        model: outlineModel,
                    },
                );
                if (!isCurrent()) return;
                items = fallback.items;
                fallbackMessage = fallback.message;
            }
            setNavItems(items);
            setActiveNavId(items[0]?.id ?? null);
            if (items.length) {
                saveGeneratedDocumentOutline(
                    window.localStorage,
                    generatedOutlineKey,
                    items,
                );
            }
            if (!items.length) {
                setNavGenerateMessage(
                    fallbackMessage ??
                        "No heading structure detected in this document.",
                );
            }
        } catch (err) {
            if (!isCurrent()) return;
            console.warn("Heuristic outline generation failed", err);
            setNavGenerateMessage(
                err instanceof Error
                    ? err.message
                    : "Couldn't analyze this document.",
            );
        } finally {
            if (isCurrent()) {
                navGenerationBusyRef.current = false;
                setGeneratingNav(false);
            }
        }
    }

    function computePdfScale(container: HTMLDivElement) {
        const firstPageSize = pageSizesRef.current[0];
        const naturalWidth = firstPageSize?.width ?? container.clientWidth;
        return (
            Math.max(
                0.5,
                (container.clientWidth - SIDE_PADDING) / naturalWidth,
            ) * zoomRef.current
        );
    }

    function resetRenderedPagesAtCurrentScale(scrollToPage?: number) {
        const runtime = pdfRuntimeRef.current;
        const container = containerRef.current;
        if (!runtime || !container || pageWrappersRef.current.length === 0)
            return;
        const renderRun = ++pdfRenderRunRef.current;
        clearRenderQueue();
        renderedPagesRef.current.forEach((pageEntry) => {
            if (!pageEntry) return;
            pageEntry.page.cleanup();
            pageEntry.canvas.width = 0;
            pageEntry.canvas.height = 0;
        });
        renderedPagesRef.current = [];
        const nextRuntime = {
            ...runtime,
            scale: computePdfScale(container),
            renderRun,
            container,
        };
        pdfRuntimeRef.current = nextRuntime;
        pageWrappersRef.current.forEach((wrapper, index) => {
            if (!wrapper) return;
            resetWrapperToPlaceholder(wrapper, index + 1, nextRuntime.scale);
        });
        const targetPage = Math.min(
            nextRuntime.doc.numPages,
            Math.max(1, scrollToPage ?? currentPageRef.current),
        );
        window.requestAnimationFrame(() => {
            pageWrappersRef.current[targetPage - 1]?.scrollIntoView({
                behavior: "instant" as ScrollBehavior,
                block: "start",
            });
            currentPageRef.current = targetPage;
            setCurrentPage(targetPage);
            scheduleWindowRender(targetPage);
        });
    }

    const renderPDF = useCallback(
        async (
            doc: import("pdfjs-dist").PDFDocumentProxy,
            list: QuoteEntry[],
            scrollToPage?: number,
        ) => {
            const container = containerRef.current;
            if (!container) return;
            const renderRun = ++pdfRenderRunRef.current;
            const isCurrentRender = () =>
                renderRun === pdfRenderRunRef.current &&
                containerRef.current === container &&
                container.isConnected;

            container.innerHTML = "";
            clearRenderQueue();
            pdfRuntimeRef.current = null;
            renderedPagesRef.current = [];
            pageWrappersRef.current = [];
            pageSizesRef.current = [];
            resolvedQuotePagesRef.current.clear();
            const lib = await getPdfJs();
            if (!isCurrentRender()) return;
            lib.TextLayer.cleanup();

            setNumPages(doc.numPages);
            setCurrentPage(1);
            currentPageRef.current = 1;

            const hasCitation = list.length > 0;
            const citationNavigationPending =
                Boolean(citationNavigationKey) &&
                lastHandledCitationNavigationKeyRef.current !==
                    citationNavigationKey;
            if (hasCitation && scrollContainerRef.current) {
                scrollContainerRef.current.style.opacity = "0";
            }
            let citationRevealed = false;

            const reveal = () => {
                citationRevealed = true;
                if (scrollContainerRef.current)
                    scrollContainerRef.current.style.opacity = "1";
            };

            // getPage rejects with "Transport destroyed" when the document
            // effect's cleanup destroys the doc (document swap / unmount)
            // while this measurement loop is mid-await. That's a stale
            // render, not a failure — exit silently instead of throwing.
            const getPageOrNull = async (pageNum: number) => {
                if (doc.loadingTask.destroyed) return null;
                try {
                    return await doc.getPage(pageNum);
                } catch (err) {
                    if (!isCurrentRender() || doc.loadingTask.destroyed)
                        return null;
                    throw err;
                }
            };

            const firstPage = await getPageOrNull(1);
            if (!firstPage || !isCurrentRender()) return;
            const firstViewport = firstPage.getViewport({ scale: 1 });
            pageSizesRef.current[0] = {
                width: firstViewport.width,
                height: firstViewport.height,
            };
            onRenderProgressRef.current?.(1, doc.numPages);

            // Use the first page as a temporary placeholder size. Individual
            // dimensions are measured only when that page enters the render
            // window, so a citation on page 700 can appear without waiting
            // for pages 2–699 to be fetched first.
            pageSizesRef.current = Array.from({ length: doc.numPages }, () => ({
                width: firstViewport.width,
                height: firstViewport.height,
            }));

            const scale = computePdfScale(container);

            const hintedPage = citationNavigationPending
                ? (list.find((entry) => entry.page && entry.page >= 1)
                      ?.page ??
                  scrollToPage ??
                  1)
                : (scrollToPage ?? 1);
            const initialPage = Math.min(
                doc.numPages,
                Math.max(1, hintedPage),
            );
            const fragment = document.createDocumentFragment();
            for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
                const wrapper = document.createElement("div");
                resetWrapperToPlaceholder(wrapper, pageNum, scale);
                pageWrappersRef.current[pageNum - 1] = wrapper;
                fragment.appendChild(wrapper);
            }
            container.appendChild(fragment);
            pdfRuntimeRef.current = { doc, lib, scale, renderRun, container };
            scheduleWindowRender(initialPage);
            if (
                !citationNavigationPending &&
                typeof initialScrollTop === "number" &&
                initialScrollTop > 0
            ) {
                window.requestAnimationFrame(() => {
                    const scrollEl = scrollContainerRef.current;
                    if (!scrollEl || !isCurrentRender()) return;
                    scrollEl.scrollTop = initialScrollTop;
                    scheduleWindowRender();
                });
            }

            const initialHighlightList = quoteListRef.current;
            if (initialHighlightList.length > 0 && !citationRevealed) {
                let targetPage = await applyHighlights(initialHighlightList);
                if (targetPage === null) {
                    targetPage =
                        initialHighlightList.find((entry) => entry.page)
                            ?.page ?? null;
                }
                if (targetPage && citationNavigationPending) {
                    await scrollToHighlightOnPage(targetPage);
                    lastHandledCitationNavigationKeyRef.current =
                        citationNavigationKey ?? null;
                    if (citationNavigationKey) {
                        onCitationNavigationHandled?.(citationNavigationKey);
                    }
                }
                reveal();
            } else if (!hasCitation && scrollToPage && scrollToPage > 1) {
                const wrapper = pageWrappersRef.current[scrollToPage - 1];
                if (wrapper)
                    wrapper.scrollIntoView({
                        behavior: "instant" as ScrollBehavior,
                        block: "start",
                    });
                scheduleWindowRender(scrollToPage);
            }

            // Keep applying highlight boxes for live quote updates, but never
            // treat that update as navigation. Scrolling is reserved for an
            // explicit citation-click key above.
            const latestHighlightList = quoteListRef.current;
            if (latestHighlightList.length && !hasCitation) {
                await applyHighlights(latestHighlightList);
            }
            if (!hasCitation && scrollToPage && scrollToPage > 1) {
                // Restore scroll position after zoom re-render
                const wrapper = pageWrappersRef.current[scrollToPage - 1];
                if (wrapper)
                    wrapper.scrollIntoView({
                        behavior: "instant" as ScrollBehavior,
                        block: "start",
                    });
                scheduleWindowRender(scrollToPage);
            }

            paintAnnotationOverlays(annotationsRef.current);
            paintSelectionHandles(activeSelectionRef.current);
            if (!citationRevealed) reveal();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [applyHighlights, paintAnnotationOverlays, paintSelectionHandles],
    );

    // Focus a saved annotation requested by the parent (explorer click or a
    // viewer deep link): select it and center its first rect, rendering only
    // that page if the virtual window has not rendered it yet.
    useEffect(() => {
        if (!focusAnnotationId) return;
        let cancelled = false;
        const focus = async () => {
            const ann = annotationsRef.current.find(
                (a) => a.id === focusAnnotationId,
            );
            const rect = ann?.rects[0];
            if (!ann || !rect) return;
            const wrapper = pageWrappersRef.current[rect.page - 1];
            const scrollEl = scrollContainerRef.current;
            if (!wrapper || !scrollEl) return;
            wrapper.scrollIntoView({
                behavior: "instant" as ScrollBehavior,
                block: "center",
            });
            scheduleWindowRender(rect.page);
            const pageEntry = await ensurePageRendered(rect.page);
            if (cancelled || !pageEntry) return;
            setSelectedAnnotationId(ann.id);
            const [left, top, right, bottom] =
                pageEntry.viewport.convertToViewportRectangle([
                    rect.x,
                    rect.y,
                    rect.x + rect.width,
                    rect.y + rect.height,
                ]);
            void left;
            void right;
            const rectTop = Math.min(top ?? 0, bottom ?? 0);
            const containerRect = scrollEl.getBoundingClientRect();
            const wrapperRect = pageEntry.wrapper.getBoundingClientRect();
            const targetTop =
                scrollEl.scrollTop +
                (wrapperRect.top - containerRect.top) +
                rectTop -
                scrollEl.clientHeight / 2;
            scrollEl.scrollTo({
                top: Math.max(0, targetTop),
                behavior: "instant" as ScrollBehavior,
            });
        };
        void focus();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusAnnotationId, focusAnnotationKey, doc?.document_id]);

    // Scroll so the first highlight on `pageNum` lands at the vertical center
    // of the viewer. We compute the scroll position explicitly on the scroll
    // container — calling `scrollIntoView` on a child of the absolutely-
    // positioned text layer can scroll just the overlay while leaving the
    // canvas untouched, which is why we don't use it here.
    async function scrollToHighlightOnPage(pageNum: number) {
        const wrapper = pageWrappersRef.current[pageNum - 1];
        const scrollEl = scrollContainerRef.current;
        if (!wrapper || !scrollEl) return;
        wrapper.scrollIntoView({
            behavior: "instant" as ScrollBehavior,
            block: "start",
        });
        scheduleWindowRender(pageNum);
        const pageEntry = await ensurePageRendered(pageNum);
        if (!pageEntry || !scrollEl) return;

        const highlightEl = pageEntry.wrapper.querySelector<HTMLElement>(
            ".pdf-text-highlight",
        );
        if (highlightEl) {
            const containerRect = scrollEl.getBoundingClientRect();
            const highlightRect = highlightEl.getBoundingClientRect();
            const offsetWithinContainer = highlightRect.top - containerRect.top;
            const targetTop =
                scrollEl.scrollTop +
                offsetWithinContainer -
                scrollEl.clientHeight / 2 +
                highlightRect.height / 2;
            scrollEl.scrollTo({
                top: Math.max(0, targetTop),
                behavior: "instant" as ScrollBehavior,
            });
        } else {
            const wrapperRect = pageEntry.wrapper.getBoundingClientRect();
            const containerRect = scrollEl.getBoundingClientRect();
            const targetTop =
                scrollEl.scrollTop + (wrapperRect.top - containerRect.top);
            scrollEl.scrollTo({
                top: Math.max(0, targetTop),
                behavior: "instant" as ScrollBehavior,
            });
        }
    }

    const rehighlightQuotes = useCallback(
        async (list: QuoteEntry[]) => {
            const runId = ++highlightRunRef.current;
            const targetPage = await applyHighlights(list, runId);
            if (runId !== highlightRunRef.current) return;
            const citationNavigationPending =
                Boolean(citationNavigationKey) &&
                lastHandledCitationNavigationKeyRef.current !==
                    citationNavigationKey;
            if (!citationNavigationPending) return;
            const scrollPage =
                targetPage ?? list.find((e) => e.page)?.page ?? null;
            if (scrollPage && scrollPage >= 1) {
                await scrollToHighlightOnPage(scrollPage);
                lastHandledCitationNavigationKeyRef.current =
                    citationNavigationKey ?? null;
                if (citationNavigationKey) {
                    onCitationNavigationHandled?.(citationNavigationKey);
                }
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [applyHighlights, citationNavigationKey, onCitationNavigationHandled],
    );

    async function scrollToNavItem(item: DocumentNavigationItem) {
        if (!item.page) return;
        setActiveNavId(item.id);
        const wrapper = pageWrappersRef.current[item.page - 1];
        if (!wrapper) return;
        wrapper.scrollIntoView({
            behavior: "smooth",
            block: "start",
        });
        scheduleWindowRender(item.page);
        void ensurePageRendered(item.page);
    }

    useCtrlZoom(scrollContainerRef, (detail) => {
        const next = Math.min(
            ZOOM_MAX,
            Math.max(
                ZOOM_MIN,
                Math.round(zoomRef.current * ctrlZoomFactor(detail) * 100) / 100,
            ),
        );
        if (next === zoomRef.current) return;
        zoomRef.current = next;
        setZoom(next);
        if (wheelZoomTimerRef.current) clearTimeout(wheelZoomTimerRef.current);
        wheelZoomTimerRef.current = setTimeout(() => {
            resetRenderedPagesAtCurrentScale(currentPageRef.current);
        }, 150);
    });

    useEffect(
        () => () => {
            if (wheelZoomTimerRef.current) {
                clearTimeout(wheelZoomTimerRef.current);
            }
        },
        [],
    );

    // Touch pinch-to-zoom
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        let initialDist = 0;
        let initialZoom = 1.0;

        function getTouchDist(touches: TouchList) {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.hypot(dx, dy);
        }

        const handleTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                initialDist = getTouchDist(e.touches);
                initialZoom = zoomRef.current;
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 2 || initialDist === 0) return;
            e.preventDefault();
            const next = Math.min(
                ZOOM_MAX,
                Math.max(
                    ZOOM_MIN,
                    Math.round(
                        initialZoom *
                            (getTouchDist(e.touches) / initialDist) *
                            100,
                    ) / 100,
                ),
            );
            zoomRef.current = next;
            setZoom(next);
        };

        const handleTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2 && initialDist > 0) {
                initialDist = 0;
                resetRenderedPagesAtCurrentScale(currentPageRef.current);
            }
        };

        el.addEventListener("touchstart", handleTouchStart, { passive: true });
        el.addEventListener("touchmove", handleTouchMove, { passive: false });
        el.addEventListener("touchend", handleTouchEnd, { passive: true });
        return () => {
            el.removeEventListener("touchstart", handleTouchStart);
            el.removeEventListener("touchmove", handleTouchMove);
            el.removeEventListener("touchend", handleTouchEnd);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderPDF]);

    // Clean up PDF.js static font-measurement canvases on unmount
    useEffect(() => {
        return () => {
            clearRenderQueue();
            destroyCurrentPdfDocument();
            getPdfJs().then((lib) => lib.TextLayer.cleanup());
        };
    }, []);

    // Render PDF when fetch result arrives
    useEffect(() => {
        if (!result || result.type !== "pdf") return;
        destroyCurrentPdfDocument();
        clearRenderQueue();
        pdfRuntimeRef.current = null;
        renderedPagesRef.current = [];
        pageWrappersRef.current = [];
        pageSizesRef.current = [];
        resolvedQuotePagesRef.current.clear();
        findPageTextsRef.current.clear();
        findRunRef.current += 1;
        setFindOpen(false);
        setFindQuery("");
        setFindMatches([]);
        setFindActiveIndex(0);
        quoteListRef.current = quoteList;
        zoomRef.current = 1.0;
        setZoom(1.0);
        setNumPages(0);
        setPdfLoadError(null);
        const list = quoteList;

        let cancelled = false;
        (async () => {
            const lib = await getPdfJs();
            if (cancelled) return;
            // Parse the bytes with pdf.js. A rejection here (e.g. the worker not
            // being ready yet on a cold dev load, or genuinely bad bytes) must
            // never escape this async IIFE — an unhandled rejection surfaces as
            // a full-screen error overlay in dev and tears the viewer down. Try
            // once more on failure, then fall back to a readable error state.
            const parse = () =>
                lib.getDocument({
                    // pdf.js transfers (detaches) the buffer backing `data` to
                    // its worker. Pass a fresh copy (.slice() allocates a new
                    // ArrayBuffer) so the original `result.buffer` is never
                    // detached and the effect can safely re-run on re-render /
                    // Strict Mode double-invoke without "detached ArrayBuffer".
                    data: new Uint8Array(result.buffer).slice(),
                    standardFontDataUrl: STANDARD_FONT_DATA_URL,
                }).promise;
            let pdfDoc;
            try {
                pdfDoc = await parse();
            } catch (firstErr) {
                if (cancelled) return;
                console.warn("PDF load failed; retrying once", firstErr);
                try {
                    pdfDoc = await parse();
                } catch (secondErr) {
                    if (cancelled) return;
                    console.error("PDF load failed", secondErr);
                    setPdfLoadError("This document could not be displayed.");
                    return;
                }
            }
            if (cancelled) {
                destroyPdfDocument(pdfDoc);
                return;
            }
            pdfDocRef.current = pdfDoc;
            buildPdfNavigationItems(pdfDoc)
                .then((items) => {
                    if (cancelled) return;
                    const nextItems = items.length
                        ? items
                        : loadGeneratedDocumentOutline(
                              window.localStorage,
                              generatedOutlineKey,
                          );
                    setNavItems(nextItems);
                    setActiveNavId(nextItems[0]?.id ?? null);
                })
                .catch((err) => {
                    console.warn("PDF outline load failed", err);
                    if (cancelled) return;
                    const cachedItems = loadGeneratedDocumentOutline(
                        window.localStorage,
                        generatedOutlineKey,
                    );
                    setNavItems(cachedItems);
                    setActiveNavId(cachedItems[0]?.id ?? null);
                });
            await renderPDF(pdfDoc, list).catch((err) => {
                if (cancelled) return; // doc was destroyed mid-render
                console.error("PDF render failed", err);
                setPdfLoadError("This document could not be displayed.");
            });
        })();
        return () => {
            cancelled = true;
            clearRenderQueue();
            destroyCurrentPdfDocument();
        };
        // Only re-parse when the document changes — NOT when renderPDF's
        // identity changes (it does so on every annotation/selection/highlight
        // update). Re-parsing on those would needlessly reset zoom/page/scroll
        // and re-detach the buffer. Live updates are handled by the zoom,
        // resize, and rehighlight effects below. The one-shot renderPDF call
        // here reads live values from refs, so a stable closure is correct.
    }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-render at new scale when container is resized (debounced 150ms)
    useEffect(() => {
        if (!pdfDocRef.current) return;
        const timer = setTimeout(() => {
            resetRenderedPagesAtCurrentScale(currentPageRef.current);
        }, 150);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [containerWidth]);

    // Re-highlight when quotes change without full re-render
    useEffect(() => {
        if (!pdfDocRef.current) return;
        quoteListRef.current = quoteList;
        if (quoteList.length === 0) return;
        void rehighlightQuotes(quoteList);
    }, [citationNavigationEffectKey, rehighlightQuotes]); // eslint-disable-line react-hooks/exhaustive-deps

    function handleZoomIn() {
        const next = Math.min(
            ZOOM_MAX,
            Math.round((zoomRef.current + ZOOM_STEP) * 100) / 100,
        );
        zoomRef.current = next;
        setZoom(next);
        resetRenderedPagesAtCurrentScale(currentPageRef.current);
    }

    function handleZoomOut() {
        const next = Math.max(
            ZOOM_MIN,
            Math.round((zoomRef.current - ZOOM_STEP) * 100) / 100,
        );
        zoomRef.current = next;
        setZoom(next);
        resetRenderedPagesAtCurrentScale(currentPageRef.current);
    }

    async function saveAnnotationPayload(
        payload: PdfAnnotationCreatePayload | null,
    ) {
        if (!doc?.document_id || !payload) return;
        setAnnotationBusy(true);
        setAnnotationError(null);
        showAnnotationStatus("Saving...");
        try {
            const saved = await createPdfAnnotation(doc.document_id, payload);
            setAnnotations((prev) => [...prev, saved]);
            setSelectedAnnotationId(saved.id);
            if (saved.version_id) setAnnotationVersionId(saved.version_id);
            onAnnotationsChanged?.(doc.document_id);
            showAnnotationStatus("Saved", 1600);
        } catch (err) {
            showAnnotationStatus(null);
            setAnnotationError(
                err instanceof Error
                    ? err.message
                    : "Failed to save annotation.",
            );
        } finally {
            setAnnotationBusy(false);
        }
    }

    function openCommentEditor(editor: PdfCommentEditor, initial = "") {
        setCommentDraft(initial);
        setCommentEditor(editor);
        setContextMenu(null);
    }

    function clearPdfInteractionSelection() {
        setActiveSelection(null);
        setSelectedAnnotationId(null);
        setContextMenu(null);
        setCustomColorPicker(null);
        window.getSelection()?.removeAllRanges();
    }

    function isPdfInteractionControl(target: HTMLElement | null) {
        return Boolean(
            target?.closest(
                [
                    ".pdf-saved-annotation",
                    ".pdf-selection-control-layer",
                    "[data-session-check='pdf-quick-menu']",
                    "[data-session-check='pdf-context-menu']",
                    "[data-session-check='pdf-comment-editor']",
                    "[data-session-check='pdf-custom-color-picker']",
                ].join(","),
            ),
        );
    }

    function getRectsEditorAnchor(rects: PdfAnnotationRect[]): {
        x: number;
        y: number;
    } {
        for (const rect of rects) {
            const pageEntry = renderedPagesRef.current[rect.page - 1];
            if (!pageEntry) continue;
            const [left, top, right, bottom] =
                pageEntry.viewport.convertToViewportRectangle([
                    rect.x,
                    rect.y,
                    rect.x + rect.width,
                    rect.y + rect.height,
                ]);
            const wrapperRect = pageEntry.wrapper.getBoundingClientRect();
            return {
                x: wrapperRect.left + Math.min(left ?? 0, right ?? 0),
                y: wrapperRect.top + Math.min(top ?? 0, bottom ?? 0),
            };
        }
        return { x: window.innerWidth / 2, y: 120 };
    }

    function getAnnotationEditorAnchor(annotation: PdfAnnotation): {
        x: number;
        y: number;
    } {
        return getRectsEditorAnchor(annotation.rects);
    }

    function openContextCommentEditor() {
        if (!contextMenu) return;
        if (contextMenu.kind === "selection") {
            openCommentEditor({
                kind: "selection",
                x: contextMenu.x,
                y: contextMenu.y,
                text: contextMenu.text,
                rects: contextMenu.rects,
                source: contextMenu.source,
            });
            return;
        }
        const current = annotations.find(
            (ann) => ann.id === contextMenu.annotationId,
        );
        openCommentEditor(
            {
                kind: "annotation",
                x: contextMenu.x,
                y: contextMenu.y,
                annotationId: contextMenu.annotationId,
            },
            current?.comment ?? "",
        );
    }

    function openActiveSelectionCommentEditor() {
        const selection =
            activeSelectionRef.current ??
            (contextMenu?.kind === "selection"
                ? {
                      text: contextMenu.text,
                      rects: contextMenu.rects,
                      source: contextMenu.source,
                  }
                : null);
        if (!selection) {
            setMode("comment");
            return;
        }
        const anchor =
            contextMenu?.kind === "selection"
                ? { x: contextMenu.x, y: contextMenu.y }
                : getRectsEditorAnchor(selection.rects);
        openCommentEditor({
            kind: "selection",
            x: anchor.x,
            y: anchor.y,
            text: selection.text,
            rects: selection.rects,
            source: selection.source,
        });
    }

    function closeCommentEditor(clearSelection = false) {
        setCommentEditor(null);
        setCommentDraft("");
        if (clearSelection) {
            setActiveSelection(null);
            window.getSelection()?.removeAllRanges();
        }
    }

    async function submitCommentEditor(e?: FormEvent<HTMLFormElement>) {
        e?.preventDefault();
        if (!doc?.document_id || !commentEditor) return;
        const next = commentDraft.trim();
        if (commentEditor.kind === "selection") {
            if (!next) return;
            const editor = commentEditor;
            closeCommentEditor(true);
            await saveAnnotationPayload(
                buildSelectionCreatePayload({
                    rects: editor.rects,
                    annotationType: "comment",
                    color: annotationColor,
                    text: editor.text,
                    source: editor.source,
                    comment: next,
                }),
            );
            return;
        }
        const annotationId = commentEditor.annotationId;
        const current = annotations.find((ann) => ann.id === annotationId);
        if (!current) return;
        if (!next) {
            setAnnotationError("Comment cannot be blank.");
            return;
        }
        closeCommentEditor();
        if (current.annotation_type === "highlight") {
            await saveAnnotationPayload(
                buildPdfAnnotationCreatePayload({
                    rects: current.rects,
                    annotationType: "comment",
                    color: current.color,
                    displayVersionId: current.version_id,
                    documentVersionId: doc.version_id ?? null,
                    quote: current.quote,
                    comment: next,
                    source: "user",
                }),
            );
            return;
        }
        setAnnotationBusy(true);
        setAnnotationError(null);
        showAnnotationStatus("Saving...");
        try {
            const updated = await updatePdfAnnotation(
                doc.document_id,
                annotationId,
                {
                    comment: next || null,
                },
            );
            setAnnotations((prev) =>
                prev.map((ann) => (ann.id === updated.id ? updated : ann)),
            );
            if (updated.version_id) setAnnotationVersionId(updated.version_id);
            onAnnotationsChanged?.(doc.document_id);
            showAnnotationStatus("Saved", 1600);
        } catch (err) {
            showAnnotationStatus(null);
            setAnnotationError(
                err instanceof Error
                    ? err.message
                    : "Failed to update annotation.",
            );
        } finally {
            setAnnotationBusy(false);
        }
    }

    async function handleSelectionMouseUp(e: ReactMouseEvent<HTMLDivElement>) {
        // Only the primary (left) button drives selection. A right-button
        // release would otherwise run right after `onContextMenu` opened the
        // menu and immediately overwrite/clear it — making the menu vanish the
        // instant the user lets go of the right button.
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        const current =
            readCurrentPdfSelection() ??
            readTemporaryHighlightSelection(target);
        if (!current) {
            if (!isPdfInteractionControl(target)) {
                clearPdfInteractionSelection();
            }
            return;
        }
        if (mode === "select" || current.source === "citation") {
            setActiveSelection(current);
            setSelectedAnnotationId(null);
            setContextMenu({
                kind: "selection",
                variant: "quick",
                x: e.clientX,
                y: e.clientY,
                text: current.text,
                rects: current.rects,
                source: current.source,
            });
            return;
        }
        setContextMenu(null);

        if (mode === "comment") {
            setActiveSelection(current);
            openCommentEditor({
                kind: "selection",
                x: e.clientX,
                y: e.clientY,
                text: current.text,
                rects: current.rects,
                source: current.source,
            });
            return;
        }
        window.getSelection()?.removeAllRanges();
        setActiveSelection(null);
        await saveAnnotationPayload(
            buildSelectionCreatePayload({
                rects: current.rects,
                annotationType: mode,
                color: annotationColor,
                text: current.text,
                source: current.source,
            }),
        );
    }

    function handlePdfPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (isPdfInteractionControl(target)) return;

        const selection = window.getSelection();
        const isExtendingTextSelection =
            selection != null && !selection.isCollapsed;
        if (isExtendingTextSelection) return;

        if (activeSelectionRef.current || selectedAnnotationIdRef.current) {
            setContextMenu(null);
        }
    }

    async function handlePromoteCitationHighlight() {
        if (!quoteListRef.current.length) return;
        const rects = collectTemporaryHighlightRects();
        if (rects.length === 0) {
            setAnnotationError(
                "No temporary citation highlight found to save.",
            );
            return;
        }
        await saveAnnotationPayload(
            buildCitationPromotionCreatePayload({
                rects,
                quoteList: quoteListRef.current,
                color: annotationColor,
                displayVersionId: annotationVersionId ?? displayVersionId,
                documentVersionId: doc?.version_id ?? null,
            }),
        );
    }

    function handlePdfContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
        const target = e.target as HTMLElement | null;
        if (
            target?.closest(".pdf-saved-annotation") ||
            target?.closest(".pdf-selection-control-layer")
        ) {
            return;
        }
        const current =
            readTemporaryHighlightSelection(target) ??
            readCurrentPdfSelection() ??
            activeSelectionRef.current;
        if (!current || current.rects.length === 0) return;
        e.preventDefault();
        setActiveSelection(current);
        setContextMenu({
            kind: "selection",
            variant: "context",
            x: e.clientX,
            y: e.clientY,
            text: current.text,
            rects: current.rects,
            source: current.source,
        });
    }

    async function saveSelectionAnnotation(
        annotationType: "highlight" | "comment",
    ) {
        if (!doc?.document_id || contextMenu?.kind !== "selection") return;
        if (annotationType === "comment") {
            openContextCommentEditor();
            return;
        }
        setContextMenu(null);
        window.getSelection()?.removeAllRanges();
        setActiveSelection(null);
        await saveAnnotationPayload(
            buildSelectionCreatePayload({
                rects: contextMenu.rects,
                annotationType,
                color: annotationColor,
                text: contextMenu.text,
                source: contextMenu.source,
            }),
        );
    }

    async function saveSelectionHighlightWithColor(color: string) {
        setAnnotationColor(color);
        if (!doc?.document_id || contextMenu?.kind !== "selection") return;
        const selection = contextMenu;
        setContextMenu(null);
        window.getSelection()?.removeAllRanges();
        setActiveSelection(null);
        await saveAnnotationPayload(
            buildSelectionCreatePayload({
                rects: selection.rects,
                annotationType: "highlight",
                color,
                text: selection.text,
                source: selection.source,
            }),
        );
    }

    async function updateAnnotationColor(
        annotationId: string | null,
        color: string,
    ) {
        setAnnotationColor(color);
        if (!doc?.document_id || !annotationId) return;
        const current = annotations.find((ann) => ann.id === annotationId);
        if (!current || current.color === color) return;
        setContextMenu(null);
        setAnnotationBusy(true);
        setAnnotationError(null);
        showAnnotationStatus("Saving...");
        try {
            const updated = await updatePdfAnnotation(
                doc.document_id,
                annotationId,
                {
                    color,
                },
            );
            setAnnotations((prev) =>
                prev.map((ann) => (ann.id === updated.id ? updated : ann)),
            );
            if (updated.version_id) setAnnotationVersionId(updated.version_id);
            onAnnotationsChanged?.(doc.document_id);
            showAnnotationStatus("Saved", 1600);
        } catch (err) {
            showAnnotationStatus(null);
            setAnnotationError(
                err instanceof Error
                    ? err.message
                    : "Failed to update annotation.",
            );
        } finally {
            setAnnotationBusy(false);
        }
    }

    async function deleteAnnotation(annotationId: string | null) {
        if (!doc?.document_id || !annotationId) return;
        setAnnotationBusy(true);
        setAnnotationError(null);
        showAnnotationStatus("Deleting...");
        try {
            await deletePdfAnnotation(doc.document_id, annotationId);
            setAnnotations((prev) =>
                prev.filter((ann) => ann.id !== annotationId),
            );
            setSelectedAnnotationId(null);
            setContextMenu(null);
            onAnnotationsChanged?.(doc.document_id);
            showAnnotationStatus("Saved", 1600);
        } catch (err) {
            showAnnotationStatus(null);
            setAnnotationError(
                err instanceof Error
                    ? err.message
                    : "Failed to delete annotation.",
            );
        } finally {
            setAnnotationBusy(false);
        }
    }

    async function handleDeleteSelectedAnnotation() {
        await deleteAnnotation(selectedAnnotationId);
    }

    async function editAnnotationComment(annotationId: string | null) {
        if (!doc?.document_id || !annotationId) return;
        const current = annotations.find((ann) => ann.id === annotationId);
        if (!current) return;
        const anchor = getAnnotationEditorAnchor(current);
        openCommentEditor(
            {
                kind: "annotation",
                x: anchor.x,
                y: anchor.y,
                annotationId,
            },
            current.comment ?? "",
        );
    }

    async function handleEditSelectedComment() {
        await editAnnotationComment(selectedAnnotationId);
    }

    async function handleAnnotationColorClick(index: number, color: string) {
        setSelectedColorIndex(index);
        setAnnotationColor(color);
        await updateAnnotationColor(selectedAnnotationId, color);
    }

    async function applyCustomColor(color: string, paletteIndex: number) {
        const target = customColorPicker;
        setCustomColorPicker(null);
        if (!target) return;
        setSelectedColorIndex(paletteIndex);
        replacePaletteColor(paletteIndex, color);
        setAnnotationColor(color);
        if (target.kind === "selection") {
            setContextMenu(null);
            window.getSelection()?.removeAllRanges();
            setActiveSelection(null);
            await saveAnnotationPayload(
                buildSelectionCreatePayload({
                    rects: target.rects,
                    annotationType: "highlight",
                    color,
                    text: target.text,
                    source: target.source,
                }),
            );
            return;
        }
        await updateAnnotationColor(
            target.kind === "annotation"
                ? target.annotationId
                : selectedAnnotationId,
            color,
        );
    }

    function openCustomColorPickerFromMenu() {
        if (!contextMenu) return;
        if (contextMenu.kind === "selection") {
            setCustomColorPicker({
                kind: "selection",
                x: contextMenu.x,
                y: contextMenu.y,
                text: contextMenu.text,
                rects: contextMenu.rects,
                source: contextMenu.source,
            });
            return;
        }
        setCustomColorPicker({
            kind: "annotation",
            annotationId: contextMenu.annotationId,
            x: contextMenu.x,
            y: contextMenu.y,
        });
    }

    const customColorInitial =
        (customColorPicker?.kind === "annotation"
            ? annotations.find(
                  (ann) => ann.id === customColorPicker.annotationId,
              )?.color
            : null) ?? annotationColor;

    async function handleExportAnnotatedPdf() {
        if (!doc?.document_id || annotations.length === 0) return;
        setAnnotationBusy(true);
        setAnnotationError(null);
        showAnnotationStatus("Exporting PDF...");
        try {
            const version = await exportAnnotatedPdf(
                doc.document_id,
                annotationVersionId ??
                    displayVersionId ??
                    doc.version_id ??
                    null,
            );
            const resolved = await getDocumentUrl(doc.document_id, version.id);
            const a = document.createElement("a");
            a.href = resolved.url;
            a.download = resolved.filename;
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setSelectedAnnotationId(null);
            showAnnotationStatus(`Exported ${resolved.filename}`, 2400);
        } catch (err) {
            showAnnotationStatus(null);
            setAnnotationError(
                err instanceof Error
                    ? err.message
                    : "Failed to export annotated PDF.",
            );
        } finally {
            setAnnotationBusy(false);
        }
    }

    const menuAnnotation =
        contextMenu?.kind === "annotation"
            ? (annotations.find((ann) => ann.id === contextMenu.annotationId) ??
              null)
            : null;
    const selectedAnnotation =
        selectedAnnotationId == null
            ? null
            : (annotations.find((ann) => ann.id === selectedAnnotationId) ??
              null);

    const menuStyle =
        contextMenu == null
            ? undefined
            : {
                  left: contextMenu.x,
                  top: contextMenu.y,
                  transform:
                      contextMenu.variant === "quick"
                          ? "translate(-50%, calc(-100% - 12px))"
                          : "translate(8px, 8px)",
              };
    const commentEditorStyle =
        commentEditor == null
            ? undefined
            : (() => {
                  const x = Math.min(
                      Math.max(commentEditor.x, 140),
                      window.innerWidth - 140,
                  );
                  const openBelow = commentEditor.y < 150;
                  const y = openBelow
                      ? Math.max(commentEditor.y, 16)
                      : Math.min(commentEditor.y, window.innerHeight - 16);
                  return {
                      left: x,
                      top: y,
                      transform: openBelow
                          ? "translate(-50%, 12px)"
                          : "translate(-50%, calc(-100% - 10px))",
                  };
              })();

    const menuText =
        contextMenu?.kind === "selection"
            ? contextMenu.text
            : menuAnnotation?.quote || menuAnnotation?.comment || "";

    if (fallbackToDocx && doc?.document_id) {
        return (
            <DocxView
                documentId={doc.document_id}
                versionId={doc.version_id ?? undefined}
                quotes={quotes}
                rounded={rounded}
                bordered={bordered}
            />
        );
    }

    if (result?.type === "markdown" || result?.type === "text") {
        return (
            <MarkdownDocView
                content={result.text}
                kind={result.type === "markdown" ? "markdown" : "text"}
                quotes={quotes}
                quote={quote}
                fallbackPage={fallbackPage}
            />
        );
    }

    if (result?.type === "image") {
        return (
            <ImageDocView
                buffer={result.buffer}
                contentType={result.contentType}
                rounded={rounded}
                bordered={bordered}
            />
        );
    }

    return (
        <div
            data-session-check="doc-view"
            className={`relative flex flex-1 overflow-hidden ${bordered ? "border border-gray-200" : ""} ${rounded ? "rounded-xl" : ""}`}
        >
            <DocumentNavigationPane
                items={navItems}
                open={navOpen}
                activeId={activeNavId}
                onOpenChange={setNavOpen}
                onSelect={(item) => {
                    void scrollToNavItem(item);
                }}
                onGenerate={
                    numPages > 0
                        ? () => {
                              void generateHeuristicNavItems();
                          }
                        : undefined
                }
                generating={generatingNav}
                generateMessage={navGenerateMessage}
            />
            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
                <div
                    data-session-check="doc-view-scroll"
                    data-ctrl-zoom="doc"
                    ref={scrollContainerRef}
                    className="min-w-0 flex-1 overflow-auto bg-gray-100 px-3 pt-5 pb-3"
                    onPointerDown={handlePdfPointerDown}
                    onMouseUp={(e) => {
                        void handleSelectionMouseUp(e);
                    }}
                    onContextMenu={handlePdfContextMenu}
                >
                    {loading && (
                        <div className="flex h-full items-center justify-center">
                            <DocketIcon spin docket size={28} />
                        </div>
                    )}
                    {error && (
                        <div className="flex h-full items-center justify-center">
                            <p className="text-sm text-red-500">{error}</p>
                        </div>
                    )}
                    {pdfLoadError && (
                        <div
                            data-session-check="doc-view-load-error"
                            className="flex h-full items-center justify-center"
                        >
                            <p className="text-sm text-red-500">
                                {pdfLoadError}
                            </p>
                        </div>
                    )}
                    <div ref={containerRef} />
                </div>
                {contextMenu && (
                    <div
                        data-session-check={
                            contextMenu.variant === "quick"
                                ? "pdf-quick-menu"
                                : "pdf-context-menu"
                        }
                        className={`fixed z-[120] border border-gray-200 bg-white shadow-lg ${
                            contextMenu.variant === "quick"
                                ? "flex items-center gap-1 rounded-md px-1.5 py-1"
                                : "min-w-44 rounded-lg py-1"
                        }`}
                        style={menuStyle}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                    >
                        {contextMenu.variant === "quick" ? (
                            <>
                                <button
                                    title="Comment"
                                    disabled={annotationBusy}
                                    onClick={() => {
                                        if (contextMenu.kind === "selection") {
                                            void saveSelectionAnnotation(
                                                "comment",
                                            );
                                        } else {
                                            openContextCommentEditor();
                                        }
                                    }}
                                    className="flex h-6 w-6 items-center justify-center rounded hover:bg-gray-100 disabled:opacity-40"
                                >
                                    <MessageSquare className="h-3.5 w-3.5" />
                                </button>
                                {annotationColors.map((color, index) => (
                                    <button
                                        key={index}
                                        aria-label={`Highlight ${color}`}
                                        disabled={annotationBusy}
                                        onClick={() => {
                                            setSelectedColorIndex(index);
                                            if (
                                                contextMenu.kind === "selection"
                                            ) {
                                                void saveSelectionHighlightWithColor(
                                                    color,
                                                );
                                            } else {
                                                void updateAnnotationColor(
                                                    contextMenu.annotationId,
                                                    color,
                                                );
                                            }
                                        }}
                                        className="h-4 w-4 rounded-full border border-gray-300 disabled:opacity-40"
                                        style={{ backgroundColor: color }}
                                    />
                                ))}
                                <button
                                    title="Custom color"
                                    aria-label="Custom highlight color"
                                    disabled={annotationBusy}
                                    onClick={openCustomColorPickerFromMenu}
                                    className="h-4 w-4 rounded-full border border-gray-300 disabled:opacity-40"
                                    style={{ background: COLOR_WHEEL_GRADIENT }}
                                />
                                <button
                                    title="Copy"
                                    onClick={() => {
                                        void copyText(menuText);
                                    }}
                                    className="flex h-6 w-6 items-center justify-center rounded hover:bg-gray-100"
                                >
                                    <Copy className="h-3.5 w-3.5" />
                                </button>
                            </>
                        ) : (
                            <>
                                <button
                                    onClick={() => {
                                        void copyText(menuText);
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50"
                                >
                                    <Copy className="h-3.5 w-3.5" />
                                    Copy text
                                </button>
                                {contextMenu.kind === "selection" ? (
                                    <>
                                        <button
                                            disabled={annotationBusy}
                                            onClick={() => {
                                                void saveSelectionAnnotation(
                                                    "highlight",
                                                );
                                            }}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                                        >
                                            <Highlighter className="h-3.5 w-3.5" />
                                            Highlight
                                        </button>
                                        <button
                                            disabled={annotationBusy}
                                            onClick={() => {
                                                void saveSelectionAnnotation(
                                                    "comment",
                                                );
                                            }}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                                        >
                                            <MessageSquarePlus className="h-3.5 w-3.5" />
                                            Add comment
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <button
                                            disabled={annotationBusy}
                                            onClick={() => {
                                                openContextCommentEditor();
                                            }}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                                        >
                                            <MessageSquarePlus className="h-3.5 w-3.5" />
                                            {menuAnnotation?.annotation_type ===
                                            "comment"
                                                ? "Edit comment"
                                                : "Add comment"}
                                        </button>
                                        <div className="flex items-center gap-1 px-3 py-2">
                                            {annotationColors.map(
                                                (color, index) => (
                                                    <button
                                                        key={index}
                                                        title={color}
                                                        disabled={
                                                            annotationBusy
                                                        }
                                                        onClick={() => {
                                                            setSelectedColorIndex(
                                                                index,
                                                            );
                                                            void updateAnnotationColor(
                                                                contextMenu.annotationId,
                                                                color,
                                                            );
                                                        }}
                                                        className="h-5 w-5 rounded-full border border-gray-300 disabled:opacity-40"
                                                        style={{
                                                            backgroundColor:
                                                                color,
                                                        }}
                                                    />
                                                ),
                                            )}
                                            <button
                                                title="Custom color"
                                                aria-label="Custom highlight color"
                                                disabled={annotationBusy}
                                                onClick={
                                                    openCustomColorPickerFromMenu
                                                }
                                                className="h-5 w-5 rounded-full border border-gray-300 disabled:opacity-40"
                                                style={{
                                                    background:
                                                        COLOR_WHEEL_GRADIENT,
                                                }}
                                            />
                                        </div>
                                        <button
                                            disabled={annotationBusy}
                                            onClick={() => {
                                                void deleteAnnotation(
                                                    contextMenu.annotationId,
                                                );
                                            }}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            Delete annotation
                                        </button>
                                    </>
                                )}
                                <button
                                    onClick={() => {
                                        setContextMenu(null);
                                        setActiveSelection(null);
                                        window
                                            .getSelection()
                                            ?.removeAllRanges();
                                    }}
                                    className="flex w-full items-center gap-2 border-t border-gray-100 px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-50"
                                >
                                    Close
                                </button>
                            </>
                        )}
                    </div>
                )}
                {customColorPicker && (
                    <PdfCustomColorPicker
                        x={customColorPicker.x}
                        y={customColorPicker.y}
                        initialColor={customColorInitial}
                        colors={annotationColors}
                        initialSlotIndex={selectedColorIndex}
                        busy={annotationBusy}
                        onCancel={() => setCustomColorPicker(null)}
                        onApply={(color, paletteIndex) => {
                            void applyCustomColor(color, paletteIndex);
                        }}
                    />
                )}
                {commentEditor && (
                    <form
                        data-session-check="pdf-comment-editor"
                        className="fixed z-[130] w-[260px] rounded-md border border-gray-200 bg-white p-2 shadow-xl"
                        style={commentEditorStyle}
                        onSubmit={(e) => {
                            void submitCommentEditor(e);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                    >
                        <textarea
                            ref={commentInputRef}
                            value={commentDraft}
                            onChange={(e) => setCommentDraft(e.target.value)}
                            placeholder="Add comment"
                            rows={3}
                            className="block w-full resize-none rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-gray-400"
                        />
                        <div className="mt-2 flex items-center justify-end gap-1.5">
                            <button
                                type="button"
                                className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                                onClick={() =>
                                    closeCommentEditor(
                                        commentEditor.kind === "selection",
                                    )
                                }
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={
                                    annotationBusy ||
                                    commentDraft.trim().length === 0
                                }
                                className="rounded bg-gray-900 px-2 py-1 text-xs text-white disabled:opacity-40"
                            >
                                Save
                            </button>
                        </div>
                    </form>
                )}
                {numPages > 0 && (
                    <>
                        <div className="pointer-events-none absolute top-4 right-4 left-4 flex flex-col items-end gap-2">
                            <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-1 rounded-lg border border-white/60 bg-white/85 px-2 py-1 shadow-md backdrop-blur-md">
                                <button
                                    data-session-check="pdf-mode-select"
                                    title="Select"
                                    aria-pressed={mode === "select"}
                                    onClick={() => setMode("select")}
                                    className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                                        mode === "select"
                                            ? "bg-gray-900 text-white"
                                            : "text-gray-600 hover:bg-white"
                                    }`}
                                >
                                    <MousePointer2 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    data-session-check="pdf-mode-highlight"
                                    title="Highlight"
                                    aria-pressed={mode === "highlight"}
                                    onClick={() => setMode("highlight")}
                                    className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                                        mode === "highlight"
                                            ? "bg-gray-900 text-white"
                                            : "text-gray-600 hover:bg-white"
                                    }`}
                                >
                                    <Highlighter className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    data-session-check="pdf-mode-comment"
                                    title="Comment"
                                    aria-pressed={mode === "comment"}
                                    onClick={() =>
                                        openActiveSelectionCommentEditor()
                                    }
                                    className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                                        mode === "comment"
                                            ? "bg-gray-900 text-white"
                                            : "text-gray-600 hover:bg-white"
                                    }`}
                                >
                                    <MessageSquarePlus className="h-3.5 w-3.5" />
                                </button>
                                <div className="mx-1 h-5 w-px bg-gray-200" />
                                {annotationColors.map((color, index) => (
                                    <button
                                        key={index}
                                        data-session-check="pdf-annotation-color"
                                        data-color={color}
                                        title={color}
                                        onClick={() => {
                                            void handleAnnotationColorClick(
                                                index,
                                                color,
                                            );
                                        }}
                                        className={`h-5 w-5 rounded-full border transition-transform ${
                                            selectedColorIndex === index
                                                ? "scale-110 border-gray-900"
                                                : "border-white"
                                        }`}
                                        style={{ backgroundColor: color }}
                                    />
                                ))}
                                <button
                                    data-session-check="pdf-annotation-custom-color"
                                    title="Custom color"
                                    aria-label="Custom highlight color"
                                    onClick={(e) => {
                                        const rect =
                                            e.currentTarget.getBoundingClientRect();
                                        setCustomColorPicker({
                                            kind: "default",
                                            x: rect.left + rect.width / 2,
                                            y: rect.bottom + 6,
                                        });
                                    }}
                                    className="h-5 w-5 rounded-full border border-white transition-transform hover:scale-110"
                                    style={{ background: COLOR_WHEEL_GRADIENT }}
                                />
                                {quoteList.length > 0 && (
                                    <>
                                        <div className="mx-1 h-5 w-px bg-gray-200" />
                                        <button
                                            data-session-check="pdf-save-citation-highlight"
                                            title="Save citation highlight"
                                            disabled={annotationBusy}
                                            onClick={() => {
                                                void handlePromoteCitationHighlight();
                                            }}
                                            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-600 transition-colors hover:bg-white disabled:opacity-40"
                                        >
                                            <Save className="h-3.5 w-3.5" />
                                        </button>
                                    </>
                                )}
                                <div className="mx-1 h-5 w-px bg-gray-200" />
                                <button
                                    data-session-check="pdf-find-toggle"
                                    title="Find in document (Ctrl+F)"
                                    aria-pressed={findOpen}
                                    onClick={() => {
                                        if (findOpen) setFindOpen(false);
                                        else openFindBar();
                                    }}
                                    className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                                        findOpen
                                            ? "bg-gray-900 text-white"
                                            : "text-gray-600 hover:bg-white"
                                    }`}
                                >
                                    <Search className="h-3.5 w-3.5" />
                                </button>
                                <div className="mx-1 h-5 w-px bg-gray-200" />
                                <button
                                    data-session-check="pdf-export-annotated"
                                    title={
                                        annotations.length > 0
                                            ? "Export PDF"
                                            : "No annotations to export"
                                    }
                                    disabled={
                                        annotationBusy ||
                                        annotations.length === 0
                                    }
                                    onClick={() => {
                                        void handleExportAnnotatedPdf();
                                    }}
                                    className="flex h-7 items-center justify-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-gray-700 transition-colors hover:bg-white disabled:opacity-40"
                                >
                                    <FileDown className="h-3.5 w-3.5" />
                                    <span>Export PDF</span>
                                </button>
                                {selectedAnnotationId && (
                                    <>
                                        <button
                                            title={
                                                selectedAnnotation?.annotation_type ===
                                                "comment"
                                                    ? "Edit comment"
                                                    : "Add comment"
                                            }
                                            disabled={annotationBusy}
                                            onClick={() => {
                                                void handleEditSelectedComment();
                                            }}
                                            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-600 transition-colors hover:bg-white disabled:opacity-40"
                                        >
                                            <MessageSquarePlus className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            title="Delete annotation"
                                            disabled={annotationBusy}
                                            onClick={() => {
                                                void handleDeleteSelectedAnnotation();
                                            }}
                                            className="flex h-7 w-7 items-center justify-center rounded-full text-red-600 transition-colors hover:bg-white disabled:opacity-40"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </>
                                )}
                            </div>
                            {findOpen && (
                                <div
                                    data-session-check="pdf-find-bar"
                                    className="pointer-events-auto flex items-center gap-1 rounded-lg border border-white/60 bg-white/95 px-2 py-1 shadow-md backdrop-blur-md"
                                >
                                    <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                    <input
                                        ref={findInputRef}
                                        value={findQuery}
                                        onChange={(e) =>
                                            setFindQuery(e.target.value)
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                stepFindMatch(
                                                    e.shiftKey ? -1 : 1,
                                                );
                                            } else if (e.key === "Escape") {
                                                e.stopPropagation();
                                                setFindOpen(false);
                                            }
                                        }}
                                        placeholder="Find in document"
                                        spellCheck={false}
                                        className="w-44 bg-transparent text-xs text-gray-800 outline-none placeholder:text-gray-400"
                                    />
                                    <span className="min-w-10 text-right text-[11px] tabular-nums text-gray-500">
                                        {normalizeFindText(findQuery)
                                            ? `${Math.min(
                                                  findActiveIndex + 1,
                                                  findMatches.length,
                                              )}/${findMatches.length}`
                                            : ""}
                                    </span>
                                    <button
                                        title="Previous match (Shift+Enter)"
                                        disabled={findMatches.length === 0}
                                        onClick={() => stepFindMatch(-1)}
                                        className="flex h-6 w-6 items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                                    >
                                        <ChevronUp className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        title="Next match (Enter)"
                                        disabled={findMatches.length === 0}
                                        onClick={() => stepFindMatch(1)}
                                        className="flex h-6 w-6 items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                                    >
                                        <ChevronDown className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        title="Close (Esc)"
                                        onClick={() => setFindOpen(false)}
                                        className="flex h-6 w-6 items-center justify-center rounded text-gray-600 hover:bg-gray-100"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            )}
                            {annotationError && (
                                <div className="max-w-[280px] rounded-md border border-red-200 bg-white/95 px-3 py-2 text-xs text-red-600 shadow-md">
                                    {annotationError}
                                </div>
                            )}
                            {annotationStatus && !annotationError && (
                                <div className="max-w-[280px] rounded-md border border-gray-200 bg-white/95 px-3 py-2 text-xs text-gray-600 shadow-md">
                                    {annotationStatus}
                                </div>
                            )}
                        </div>

                        {/* Page counter — bottom left */}
                        <div className="absolute bottom-4 left-4 pointer-events-none">
                            <span className="flex items-center px-3 py-1.5 rounded-full text-xs font-medium tabular-nums text-gray-700 bg-white/25 backdrop-blur-md border border-white/30 shadow-md">
                                {currentPage}/{numPages}
                            </span>
                        </div>

                        {/* Zoom controls — bottom right */}
                        <div className="absolute bottom-4 right-4 flex items-center gap-px rounded-full bg-white/25 backdrop-blur-md border border-white/30 shadow-md px-1 py-1">
                            <button
                                onClick={handleZoomOut}
                                disabled={zoom <= ZOOM_MIN}
                                className="flex items-center justify-center w-7 h-7 rounded-full text-gray-600 hover:bg-white/80 disabled:opacity-30 transition-colors"
                            >
                                <ZoomOut className="h-3.5 w-3.5" />
                            </button>
                            <span className="text-xs font-medium text-gray-600 tabular-nums w-9 text-center select-none">
                                {Math.round(zoom * 100)}%
                            </span>
                            <button
                                onClick={handleZoomIn}
                                disabled={zoom >= ZOOM_MAX}
                                className="flex items-center justify-center w-7 h-7 rounded-full text-gray-600 hover:bg-white/80 disabled:opacity-30 transition-colors"
                            >
                                <ZoomIn className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
