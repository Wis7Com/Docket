"use client";

import { useEffect, useRef, type RefObject } from "react";

export const CTRL_ZOOM_EVENT = "docket:ctrl-zoom";

export type CtrlZoomDetail = {
    deltaY: number;
    deltaMode: number;
};

export function ctrlZoomFactor({ deltaY, deltaMode }: CtrlZoomDetail) {
    const delta = deltaMode === 0 ? deltaY / 300 : deltaY * 0.1;
    return Math.exp(-delta);
}

export function useCtrlZoom(
    targetRef: RefObject<HTMLElement | null>,
    onZoom: (detail: CtrlZoomDetail) => void,
) {
    const onZoomRef = useRef(onZoom);
    useEffect(() => {
        onZoomRef.current = onZoom;
    }, [onZoom]);

    useEffect(() => {
        const handleZoom = (event: Event) => {
            if (event.target !== targetRef.current) return;
            onZoomRef.current((event as CustomEvent<CtrlZoomDetail>).detail);
        };
        window.addEventListener(CTRL_ZOOM_EVENT, handleZoom);
        return () => window.removeEventListener(CTRL_ZOOM_EVENT, handleZoom);
    }, [targetRef]);
}
