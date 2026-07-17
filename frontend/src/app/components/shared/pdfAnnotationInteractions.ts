import type {
    Dispatch,
    MutableRefObject,
    SetStateAction,
} from "react";
import { updatePdfAnnotation } from "@/app/lib/docketApi";
import type {
    PdfAnnotation,
    PdfAnnotationNotePosition,
    PdfAnnotationRect,
} from "./types";
import { buildPdfAnnotationOverlayItems } from "./pdfAnnotationOverlay";
import {
    clientRectsToPdfAnnotationRects,
    mergePdfAnnotationRects,
} from "./pdfGeometry";
import type {
    ActivePdfSelection,
    PdfContextMenu,
    RenderedPage,
    ResizeEdge,
} from "./docViewTypes";

type Setter<T> = Dispatch<SetStateAction<T>>;

export type PdfAnnotationInteractionDeps = {
    renderedPagesRef: MutableRefObject<RenderedPage[]>;
    annotationsRef: MutableRefObject<PdfAnnotation[]>;
    activeSelectionRef: MutableRefObject<ActivePdfSelection | null>;
    selectedAnnotationIdRef: MutableRefObject<string | null>;
    docIdRef: MutableRefObject<string | null>;
    setAnnotations: Setter<PdfAnnotation[]>;
    setActiveSelection: Setter<ActivePdfSelection | null>;
    setSelectedAnnotationId: Setter<string | null>;
    setContextMenu: Setter<PdfContextMenu | null>;
    setAnnotationBusy: Setter<boolean>;
    setAnnotationError: Setter<string | null>;
    setAnnotationVersionId: Setter<string | null>;
    showAnnotationStatus: (message: string | null, autoClearMs?: number) => void;
};

function pdfXFromClientX(clientX: number, pageEntry: RenderedPage): number {
    const wrapperRect = pageEntry.wrapper.getBoundingClientRect();
    const relX = clientX - wrapperRect.left;
    const [pdfX = 0] = pageEntry.viewport.convertToPdfPoint(
        relX,
        pageEntry.viewport.height / 2,
    );
    return pdfX;
}

function resizeRect(
    original: PdfAnnotationRect,
    edge: ResizeEdge,
    pdfX: number,
): PdfAnnotationRect {
    const minWidth = 2;
    const right = original.x + original.width;
    if (edge === "left") {
        const nextX = Math.min(Math.max(0, pdfX), right - minWidth);
        return { ...original, x: nextX, width: right - nextX };
    }
    const nextRight = Math.max(original.x + minWidth, pdfX);
    return { ...original, width: nextRight - original.x };
}

type CaretPoint = { node: Node; offset: number };

// Resolve the text caret under a client point, but only when it lands inside
// a pdf.js text layer — carets in surrounding UI would produce nonsense
// ranges.
function caretFromClientPoint(
    clientX: number,
    clientY: number,
): CaretPoint | null {
    const doc = document as Document & {
        caretPositionFromPoint?: (
            x: number,
            y: number,
        ) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (typeof doc.caretPositionFromPoint === "function") {
        const position = doc.caretPositionFromPoint(clientX, clientY);
        if (position) {
            node = position.offsetNode;
            offset = position.offset;
        }
    } else if (typeof doc.caretRangeFromPoint === "function") {
        const range = doc.caretRangeFromPoint(clientX, clientY);
        if (range) {
            node = range.startContainer;
            offset = range.startOffset;
        }
    }
    if (!node) return null;
    const element = node instanceof Element ? node : node.parentElement;
    if (!element?.closest(".pdf-text-layer")) return null;
    return { node, offset };
}

// The pointerup that ends a handle drag is followed by a mouseup that bubbles
// into DocView's selection handler, which would overwrite the freshly resized
// rects with the pre-drag native selection (or clear them entirely).
function suppressNextMouseUp() {
    window.addEventListener(
        "mouseup",
        (event) => event.stopPropagation(),
        { capture: true, once: true },
    );
}

function withNotePosition(
    annotation: PdfAnnotation,
    notePosition: PdfAnnotationNotePosition,
): Record<string, unknown> {
    return {
        ...(annotation.source_citation ?? {}),
        note_position: notePosition,
    };
}

// Pointer-drag state machines and DOM overlay painters for the PDF viewer.
// Everything here reads component state through refs and commits through the
// injected setters, so a single factory instance stays valid for the lifetime
// of the DocView component that created it.
export function createPdfAnnotationInteractions(
    deps: PdfAnnotationInteractionDeps,
) {
    const {
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
    } = deps;

    // While a handle drag is in flight the overlay layers are repainted on
    // every move; painting them click-through keeps caret hit-testing (and
    // therefore multi-line resizing) working when the pointer crosses the
    // annotation's own markers.
    let overlayInteractionActive = false;

    function geometryPages() {
        return renderedPagesRef.current.map((pageEntry, idx) =>
            pageEntry
                ? {
                      pageNumber: idx + 1,
                      wrapperRect: pageEntry.wrapper.getBoundingClientRect(),
                      viewport: pageEntry.viewport,
                  }
                : null,
        );
    }

    function pdfRectToClientBox(rect: PdfAnnotationRect): {
        left: number;
        top: number;
        right: number;
        bottom: number;
    } | null {
        const pageEntry = renderedPagesRef.current[rect.page - 1];
        if (!pageEntry) return null;
        const [x1, y1, x2, y2] = pageEntry.viewport.convertToViewportRectangle(
            [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
        );
        const wrapperRect = pageEntry.wrapper.getBoundingClientRect();
        return {
            left: wrapperRect.left + Math.min(x1 ?? 0, x2 ?? 0),
            top: wrapperRect.top + Math.min(y1 ?? 0, y2 ?? 0),
            right: wrapperRect.left + Math.max(x1 ?? 0, x2 ?? 0),
            bottom: wrapperRect.top + Math.max(y1 ?? 0, y2 ?? 0),
        };
    }

    // Rebuild highlight geometry as a real text range between the fixed
    // opposite endpoint and the pointer, so handle drags can grow or shrink
    // across lines (and pages) exactly like a native text selection.
    function resizeRectsFromTextRange(
        baseRects: PdfAnnotationRect[],
        edge: ResizeEdge,
        clientX: number,
        clientY: number,
    ): { rects: PdfAnnotationRect[]; text: string; range: Range } | null {
        const anchorRect =
            edge === "right" ? baseRects[0] : baseRects[baseRects.length - 1];
        if (!anchorRect) return null;
        const box = pdfRectToClientBox(anchorRect);
        if (!box) return null;
        const anchorX = edge === "right" ? box.left + 1 : box.right - 1;
        const anchorY = (box.top + box.bottom) / 2;
        const anchorCaret = caretFromClientPoint(anchorX, anchorY);
        const pointerCaret = caretFromClientPoint(clientX, clientY);
        if (!anchorCaret || !pointerCaret) return null;

        const range = document.createRange();
        range.setStart(anchorCaret.node, anchorCaret.offset);
        range.collapse(true);
        const pointerProbe = document.createRange();
        pointerProbe.setStart(pointerCaret.node, pointerCaret.offset);
        pointerProbe.collapse(true);
        if (
            range.compareBoundaryPoints(Range.START_TO_START, pointerProbe) <=
            0
        ) {
            range.setEnd(pointerCaret.node, pointerCaret.offset);
        } else {
            range.setStart(pointerCaret.node, pointerCaret.offset);
            range.setEnd(anchorCaret.node, anchorCaret.offset);
        }
        if (range.collapsed) return null;
        const rects = mergePdfAnnotationRects(
            clientRectsToPdfAnnotationRects(
                Array.from(range.getClientRects()),
                geometryPages(),
            ),
        );
        if (rects.length === 0) return null;
        return { rects, text: range.toString().trim(), range };
    }

    // Fallback when the caret APIs cannot resolve the pointer (e.g. it sits
    // between pages): nudge only the edge rect horizontally, the pre-existing
    // single-line behavior.
    function resizeEdgeRects(
        baseRects: PdfAnnotationRect[],
        edge: ResizeEdge,
        clientX: number,
        pageEntry: RenderedPage,
    ): PdfAnnotationRect[] {
        const pdfX = pdfXFromClientX(clientX, pageEntry);
        const edgeIndex = edge === "left" ? 0 : baseRects.length - 1;
        return baseRects.map((rect, idx) =>
            idx === edgeIndex ? resizeRect(rect, edge, pdfX) : rect,
        );
    }

    function clientPointToPdfPosition(
        clientX: number,
        clientY: number,
        pageEntry: RenderedPage,
    ): PdfAnnotationNotePosition {
        const wrapperRect = pageEntry.wrapper.getBoundingClientRect();
        const [x = 0, y = 0] = pageEntry.viewport.convertToPdfPoint(
            clientX - wrapperRect.left,
            clientY - wrapperRect.top,
        );
        return {
            page: renderedPagesRef.current.indexOf(pageEntry) + 1,
            x,
            y,
        };
    }

    function beginAnnotationResize(
        annotationId: string,
        edge: ResizeEdge,
        pageEntry: RenderedPage,
        event: PointerEvent,
    ) {
        event.preventDefault();
        event.stopPropagation();
        const annotation = annotationsRef.current.find(
            (ann) => ann.id === annotationId,
        );
        if (!annotation) return;
        const originalRects = annotation.rects.map((rect) => ({ ...rect }));
        const baseRects = mergePdfAnnotationRects(originalRects);
        let nextRects = baseRects;
        overlayInteractionActive = true;

        const apply = (clientX: number, clientY: number) => {
            const resized = resizeRectsFromTextRange(
                baseRects,
                edge,
                clientX,
                clientY,
            );
            nextRects =
                resized?.rects ??
                resizeEdgeRects(baseRects, edge, clientX, pageEntry);
            setAnnotations((prev) =>
                prev.map((ann) =>
                    ann.id === annotationId
                        ? { ...ann, rects: nextRects }
                        : ann,
                ),
            );
        };

        const onMove = (moveEvent: PointerEvent) =>
            apply(moveEvent.clientX, moveEvent.clientY);
        const onUp = async (upEvent: PointerEvent) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            suppressNextMouseUp();
            overlayInteractionActive = false;
            apply(upEvent.clientX, upEvent.clientY);
            const documentId = docIdRef.current;
            if (!documentId) return;
            setAnnotationBusy(true);
            setAnnotationError(null);
            showAnnotationStatus("Saving...");
            try {
                const updated = await updatePdfAnnotation(
                    documentId,
                    annotationId,
                    {
                        rects: nextRects,
                    },
                );
                setAnnotations((prev) =>
                    prev.map((ann) => (ann.id === updated.id ? updated : ann)),
                );
                if (updated.version_id)
                    setAnnotationVersionId(updated.version_id);
                showAnnotationStatus("Saved", 1600);
            } catch (err) {
                setAnnotations((prev) =>
                    prev.map((ann) =>
                        ann.id === annotationId
                            ? { ...ann, rects: originalRects }
                            : ann,
                    ),
                );
                showAnnotationStatus(null);
                setAnnotationError(
                    err instanceof Error
                        ? err.message
                        : "Failed to resize annotation.",
                );
            } finally {
                setAnnotationBusy(false);
            }
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    function beginSelectionResize(
        edge: ResizeEdge,
        pageEntry: RenderedPage,
        event: PointerEvent,
    ) {
        event.preventDefault();
        event.stopPropagation();
        const selection = activeSelectionRef.current;
        if (!selection) return;
        const baseRects = selection.rects.map((rect) => ({ ...rect }));
        overlayInteractionActive = true;

        const apply = (clientX: number, clientY: number) => {
            const resized = resizeRectsFromTextRange(
                baseRects,
                edge,
                clientX,
                clientY,
            );
            const rects =
                resized?.rects ??
                resizeEdgeRects(baseRects, edge, clientX, pageEntry);
            const text = resized?.text || selection.text;
            if (resized) {
                // Mirror the drag into the native selection so the user gets
                // the familiar text-selection feedback while extending.
                const nativeSelection = window.getSelection();
                nativeSelection?.removeAllRanges();
                nativeSelection?.addRange(resized.range);
            }
            setActiveSelection({ ...selection, rects, text });
            setContextMenu((prev) =>
                prev?.kind === "selection" ? { ...prev, rects, text } : prev,
            );
        };

        const onMove = (moveEvent: PointerEvent) =>
            apply(moveEvent.clientX, moveEvent.clientY);
        const onUp = (upEvent: PointerEvent) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            suppressNextMouseUp();
            overlayInteractionActive = false;
            apply(upEvent.clientX, upEvent.clientY);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    function beginNoteDrag(
        annotationId: string,
        pageEntry: RenderedPage,
        event: PointerEvent,
        noteEl: HTMLElement,
        lineEl: SVGLineElement | null,
    ) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const annotation = annotationsRef.current.find(
            (ann) => ann.id === annotationId,
        );
        const documentId = docIdRef.current;
        if (!annotation || !documentId) return;

        const startX = event.clientX;
        const startY = event.clientY;
        const clickThresholdPx = 3;
        let moved = false;
        let nextPosition = clientPointToPdfPosition(
            event.clientX,
            event.clientY,
            pageEntry,
        );

        // Capture the pointer so the drag keeps receiving moves even though
        // repaints may swap DOM around, and so it survives the pointer
        // leaving the small bubble.
        try {
            noteEl.setPointerCapture(event.pointerId);
        } catch {
            // setPointerCapture can throw if the element is mid-teardown;
            // the window listeners below are the fallback.
        }

        // During the drag, move the bubble (and its connector tail) directly
        // in the DOM. We intentionally do NOT call setAnnotations per frame:
        // that would rebuild the whole overlay layer and destroy the element
        // we're dragging. State is committed once on pointer-up.
        const apply = (moveEvent: PointerEvent) => {
            if (
                !moved &&
                Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) <
                    clickThresholdPx
            ) {
                return;
            }
            moved = true;
            nextPosition = clientPointToPdfPosition(
                moveEvent.clientX,
                moveEvent.clientY,
                pageEntry,
            );
            const wrapperRect = pageEntry.wrapper.getBoundingClientRect();
            const vx = moveEvent.clientX - wrapperRect.left;
            const vy = moveEvent.clientY - wrapperRect.top;
            noteEl.style.left = `${vx}px`;
            noteEl.style.top = `${vy}px`;
            if (lineEl) {
                lineEl.setAttribute("x2", String(vx + 10));
                lineEl.setAttribute("y2", String(vy + 10));
            }
        };

        const onMove = (moveEvent: PointerEvent) => apply(moveEvent);
        const onUp = async (upEvent: PointerEvent) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            try {
                noteEl.releasePointerCapture(upEvent.pointerId);
            } catch {
                // ignore — capture may already be gone
            }
            if (
                !moved &&
                Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY) <
                    clickThresholdPx
            ) {
                setSelectedAnnotationId(annotationId);
                setActiveSelection(null);
                window.getSelection()?.removeAllRanges();
                setContextMenu({
                    kind: "annotation",
                    variant: "quick",
                    x: upEvent.clientX,
                    y: upEvent.clientY,
                    annotationId,
                });
                return;
            }
            apply(upEvent);
            // Commit the final position to React state so the next repaint
            // renders the bubble where the user dropped it.
            setAnnotations((prev) =>
                prev.map((ann) =>
                    ann.id === annotationId
                        ? {
                              ...ann,
                              source_citation: withNotePosition(
                                  ann,
                                  nextPosition,
                              ),
                          }
                        : ann,
                ),
            );
            setAnnotationBusy(true);
            setAnnotationError(null);
            try {
                const latest =
                    annotationsRef.current.find(
                        (ann) => ann.id === annotationId,
                    ) ?? annotation;
                const updated = await updatePdfAnnotation(
                    documentId,
                    annotationId,
                    {
                        source_citation: withNotePosition(latest, nextPosition),
                    },
                );
                setAnnotations((prev) =>
                    prev.map((ann) => (ann.id === updated.id ? updated : ann)),
                );
                if (updated.version_id)
                    setAnnotationVersionId(updated.version_id);
                showAnnotationStatus("Saved", 1600);
            } catch (err) {
                setAnnotationError(
                    err instanceof Error
                        ? err.message
                        : "Failed to move comment.",
                );
            } finally {
                setAnnotationBusy(false);
            }
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    const paintAnnotationOverlays = (items: PdfAnnotation[]) => {
        for (const p of renderedPagesRef.current) {
            if (!p) continue;
            p.wrapper
                .querySelectorAll(".pdf-saved-annotation-layer")
                .forEach((el) => el.remove());

            const layer = document.createElement("div");
            layer.className = "pdf-saved-annotation-layer";
            layer.style.position = "absolute";
            layer.style.left = "0";
            layer.style.top = "0";
            layer.style.width = `${p.viewport.width}px`;
            layer.style.height = `${p.viewport.height}px`;
            layer.style.pointerEvents = "none";
            p.wrapper.appendChild(layer);

            const overlayItems = buildPdfAnnotationOverlayItems(
                items,
                renderedPagesRef.current.indexOf(p) + 1,
                p.viewport,
            );
            for (const item of overlayItems) {
                const selected =
                    item.annotationId === selectedAnnotationIdRef.current;
                const marker = document.createElement("button");
                marker.type = "button";
                marker.className = "pdf-saved-annotation";
                marker.dataset.annotationId = item.annotationId;
                marker.title = item.title;
                marker.style.position = "absolute";
                marker.style.left = `${item.marker.left}px`;
                marker.style.top = `${item.marker.top}px`;
                marker.style.width = `${item.marker.width}px`;
                marker.style.height = `${item.marker.height}px`;
                marker.style.border = item.marker.border;
                marker.style.background = item.marker.background;
                marker.style.opacity = item.marker.opacity;
                marker.style.mixBlendMode = item.marker.mixBlendMode;
                marker.style.cursor = "pointer";
                marker.style.pointerEvents = overlayInteractionActive
                    ? "none"
                    : "auto";
                marker.style.padding = "0";
                marker.style.borderRadius = "2px";
                marker.style.outline = selected ? "2px solid #111827" : "0";
                marker.style.outlineOffset = selected ? "1px" : "0";
                marker.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedAnnotationId(item.annotationId);
                    setActiveSelection(null);
                    window.getSelection()?.removeAllRanges();
                    setContextMenu({
                        kind: "annotation",
                        variant: "quick",
                        x: e.clientX,
                        y: e.clientY,
                        annotationId: item.annotationId,
                    });
                });
                marker.addEventListener("contextmenu", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedAnnotationId(item.annotationId);
                    setActiveSelection(null);
                    window.getSelection()?.removeAllRanges();
                    setContextMenu({
                        kind: "annotation",
                        variant: "context",
                        x: e.clientX,
                        y: e.clientY,
                        annotationId: item.annotationId,
                    });
                });
                layer.appendChild(marker);

                if (selected) {
                    const resizeEdges: ResizeEdge[] = [];
                    if (item.isFirstRect) resizeEdges.push("left");
                    if (item.isLastRect) resizeEdges.push("right");
                    for (const edge of resizeEdges) {
                        const handle = document.createElement("button");
                        handle.type = "button";
                        handle.title =
                            edge === "left"
                                ? "Drag to adjust start"
                                : "Drag to adjust end";
                        handle.style.position = "absolute";
                        handle.style.left = `${
                            edge === "left"
                                ? item.marker.left - 5
                                : item.marker.left + item.marker.width - 5
                        }px`;
                        handle.style.top = `${
                            item.marker.top + item.marker.height / 2 - 5
                        }px`;
                        handle.style.width = "10px";
                        handle.style.height = "10px";
                        handle.style.border = "2px solid #111827";
                        handle.style.borderRadius = "999px";
                        handle.style.background = "#ffffff";
                        handle.style.boxShadow = "0 1px 4px rgba(0,0,0,0.2)";
                        handle.style.cursor = "ew-resize";
                        handle.style.pointerEvents = overlayInteractionActive
                            ? "none"
                            : "auto";
                        handle.style.padding = "0";
                        handle.addEventListener("pointerdown", (e) => {
                            beginAnnotationResize(
                                item.annotationId,
                                edge,
                                p,
                                e,
                            );
                        });
                        layer.appendChild(handle);
                    }
                }

                if (item.note) {
                    const connector = document.createElementNS(
                        "http://www.w3.org/2000/svg",
                        "svg",
                    );
                    connector.style.position = "absolute";
                    connector.style.left = "0";
                    connector.style.top = "0";
                    connector.style.width = `${p.viewport.width}px`;
                    connector.style.height = `${p.viewport.height}px`;
                    connector.style.overflow = "visible";
                    connector.style.pointerEvents = "none";
                    const line = document.createElementNS(
                        "http://www.w3.org/2000/svg",
                        "line",
                    );
                    line.setAttribute("x1", String(item.note.anchorLeft));
                    line.setAttribute("y1", String(item.note.anchorTop));
                    line.setAttribute("x2", String(item.note.left + 10));
                    line.setAttribute("y2", String(item.note.top + 10));
                    line.setAttribute("stroke", item.note.connectorColor);
                    line.setAttribute("stroke-width", "1.5");
                    line.setAttribute("stroke-linecap", "round");
                    connector.appendChild(line);
                    layer.appendChild(connector);

                    const note = document.createElement("div");
                    note.textContent = item.note.text;
                    note.dataset.annotationId = item.annotationId;
                    note.style.position = "absolute";
                    note.style.left = `${item.note.left}px`;
                    note.style.top = `${item.note.top}px`;
                    note.style.maxWidth = "220px";
                    note.style.overflow = "hidden";
                    note.style.textOverflow = "ellipsis";
                    note.style.whiteSpace = "nowrap";
                    note.style.fontSize = "10px";
                    note.style.lineHeight = "16px";
                    note.style.padding = "2px 6px";
                    note.style.border = item.note.border;
                    note.style.background = "rgba(255,255,255,0.9)";
                    note.style.color = "#1f2937";
                    note.style.borderRadius = "8px";
                    note.style.cursor = "move";
                    note.style.pointerEvents = overlayInteractionActive
                        ? "none"
                        : "auto";
                    note.style.userSelect = "none";
                    note.addEventListener("pointerdown", (e) => {
                        beginNoteDrag(item.annotationId, p, e, note, line);
                    });
                    note.addEventListener("contextmenu", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedAnnotationId(item.annotationId);
                        setActiveSelection(null);
                        window.getSelection()?.removeAllRanges();
                        setContextMenu({
                            kind: "annotation",
                            variant: "context",
                            x: e.clientX,
                            y: e.clientY,
                            annotationId: item.annotationId,
                        });
                    });
                    layer.appendChild(note);
                }
            }
        }
    };

    const paintSelectionHandles = (selection: ActivePdfSelection | null) => {
        // Handles only mark the true start and end of the whole selection —
        // dragging either one re-anchors against the opposite end, so painting
        // per-page pseudo-endpoints would be misleading.
        const endpoints =
            selection && selection.rects.length > 0
                ? [
                      { rect: selection.rects[0], edge: "left" as const },
                      {
                          rect: selection.rects[selection.rects.length - 1],
                          edge: "right" as const,
                      },
                  ]
                : [];
        for (const p of renderedPagesRef.current) {
            if (!p) continue;
            p.wrapper
                .querySelectorAll(".pdf-selection-control-layer")
                .forEach((el) => el.remove());

            const pageNumber = renderedPagesRef.current.indexOf(p) + 1;
            const pageEndpoints = endpoints.filter(
                (endpoint) => endpoint.rect.page === pageNumber,
            );
            if (pageEndpoints.length === 0) continue;

            const layer = document.createElement("div");
            layer.className = "pdf-selection-control-layer";
            layer.style.position = "absolute";
            layer.style.left = "0";
            layer.style.top = "0";
            layer.style.width = `${p.viewport.width}px`;
            layer.style.height = `${p.viewport.height}px`;
            layer.style.pointerEvents = "none";
            p.wrapper.appendChild(layer);

            for (const endpoint of pageEndpoints) {
                const [left, top, right, bottom] =
                    p.viewport.convertToViewportRectangle([
                        endpoint.rect.x,
                        endpoint.rect.y,
                        endpoint.rect.x + endpoint.rect.width,
                        endpoint.rect.y + endpoint.rect.height,
                    ]);
                const x = Math.min(left ?? 0, right ?? 0);
                const y = Math.min(top ?? 0, bottom ?? 0);
                const width = Math.abs((right ?? 0) - (left ?? 0));
                const height = Math.abs((bottom ?? 0) - (top ?? 0));
                const handle = document.createElement("button");
                handle.type = "button";
                handle.title =
                    endpoint.edge === "left"
                        ? "Drag to adjust selection start"
                        : "Drag to adjust selection end";
                handle.style.position = "absolute";
                handle.style.left = `${
                    endpoint.edge === "left" ? x - 6 : x + width - 6
                }px`;
                handle.style.top = `${y + height / 2 - 6}px`;
                handle.style.width = "12px";
                handle.style.height = "12px";
                handle.style.border = "2px solid #2563eb";
                handle.style.borderRadius = "999px";
                handle.style.background = "#ffffff";
                handle.style.boxShadow = "0 1px 4px rgba(0,0,0,0.24)";
                handle.style.cursor = "ew-resize";
                handle.style.pointerEvents = overlayInteractionActive
                    ? "none"
                    : "auto";
                handle.style.padding = "0";
                handle.addEventListener("pointerdown", (e) => {
                    beginSelectionResize(endpoint.edge, p, e);
                });
                layer.appendChild(handle);
            }
        }
    };

    return {
        paintAnnotationOverlays,
        paintSelectionHandles,
    };
}
