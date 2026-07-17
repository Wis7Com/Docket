"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ctrlZoomFactor, useCtrlZoom } from "@/lib/ctrlZoom";
import {
    CHAT_FONT_SCALE_MAX,
    CHAT_FONT_SCALE_MIN,
    CHAT_FONT_SCALE_STEP,
    clampChatFontScale,
    parseStoredChatFontScale,
} from "@/app/lib/chatFontScale";

export function useChatFontScale(
    containerRef: RefObject<HTMLElement | null>,
    storageKey: string,
) {
    const [fontScale, setFontScale] = useState(1);
    const loadedRef = useRef(false);

    const updateFontScale = useCallback((value: number) => {
        setFontScale(clampChatFontScale(value));
    }, []);

    useEffect(() => {
        let frame = requestAnimationFrame(() => {
            try {
                const saved = parseStoredChatFontScale(
                    localStorage.getItem(storageKey),
                );
                if (saved !== null) setFontScale(saved);
            } catch {
                // Storage can be unavailable in locked-down browser contexts.
            } finally {
                loadedRef.current = true;
            }
            frame = 0;
        });
        return () => {
            if (frame) cancelAnimationFrame(frame);
        };
    }, [storageKey]);

    useEffect(() => {
        if (!loadedRef.current) return;
        try {
            localStorage.setItem(storageKey, String(fontScale));
        } catch {
            // Storage can be unavailable in locked-down browser contexts.
        }
    }, [fontScale, storageKey]);

    useCtrlZoom(containerRef, (detail) => {
        setFontScale((value) =>
            clampChatFontScale(value * ctrlZoomFactor(detail)),
        );
    });

    return {
        fontScale,
        updateFontScale,
        increase: () => updateFontScale(fontScale + CHAT_FONT_SCALE_STEP),
        decrease: () => updateFontScale(fontScale - CHAT_FONT_SCALE_STEP),
        canIncrease: fontScale < CHAT_FONT_SCALE_MAX,
        canDecrease: fontScale > CHAT_FONT_SCALE_MIN,
    };
}
