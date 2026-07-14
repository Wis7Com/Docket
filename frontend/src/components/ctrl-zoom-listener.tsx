"use client";

import { useEffect } from "react";
import { CTRL_ZOOM_EVENT, type CtrlZoomDetail } from "@/lib/ctrlZoom";

export function CtrlZoomListener() {
    useEffect(() => {
        const handleWheel = (event: WheelEvent) => {
            if (!event.ctrlKey || !(event.target instanceof Element)) return;
            const target = event.target.closest<HTMLElement>(
                '[data-ctrl-zoom="doc"], [data-ctrl-zoom="chat"]',
            );
            if (!target) return;

            event.preventDefault();
            target.dispatchEvent(
                new CustomEvent<CtrlZoomDetail>(CTRL_ZOOM_EVENT, {
                    bubbles: true,
                    detail: {
                        deltaY: event.deltaY,
                        deltaMode: event.deltaMode,
                    },
                }),
            );
        };

        window.addEventListener("wheel", handleWheel, {
            capture: true,
            passive: false,
        });
        return () =>
            window.removeEventListener("wheel", handleWheel, { capture: true });
    }, []);

    // macOS Electron path: Ctrl+wheel never reaches the page as a wheel
    // event — Chromium zooms the whole window at the browser level. The
    // preload script reverts that zoom and emits "docket:zoom-intent";
    // route the intent to the pane under the pointer, or sanction it
    // app-wide (restoring the old whole-app zoom) over neither pane.
    useEffect(() => {
        let pointerX = window.innerWidth / 2;
        let pointerY = window.innerHeight / 2;
        const onPointerMove = (e: PointerEvent) => {
            pointerX = e.clientX;
            pointerY = e.clientY;
        };
        const onZoomIntent = () => {
            const docket = window.docket as
                | {
                      consumeZoomIntent?: () => number | null;
                      applyAppZoom?: (ratio: number) => void;
                  }
                | undefined;
            const ratio = docket?.consumeZoomIntent?.();
            if (
                typeof ratio !== "number" ||
                !Number.isFinite(ratio) ||
                ratio <= 0
            ) {
                return;
            }
            const target =
                document
                    .elementFromPoint(pointerX, pointerY)
                    ?.closest<HTMLElement>("[data-ctrl-zoom]") ?? null;
            if (target) {
                // Same event the wheel path dispatches; ctrlZoomFactor()
                // recovers exactly `ratio` from this deltaY.
                target.dispatchEvent(
                    new CustomEvent<CtrlZoomDetail>(CTRL_ZOOM_EVENT, {
                        bubbles: true,
                        detail: {
                            deltaY: -300 * Math.log(ratio),
                            deltaMode: 0,
                        },
                    }),
                );
            } else {
                docket?.applyAppZoom?.(ratio);
            }
        };
        window.addEventListener("pointermove", onPointerMove, {
            passive: true,
        });
        window.addEventListener("docket:zoom-intent", onZoomIntent);
        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("docket:zoom-intent", onZoomIntent);
        };
    }, []);

    return null;
}
