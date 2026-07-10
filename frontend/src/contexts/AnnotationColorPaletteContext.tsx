"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import {
    ANNOTATION_COLOR_PALETTE_STORAGE_KEY,
    defaultAnnotationColorPalette,
    readAnnotationColorPalette,
    replaceAnnotationPaletteColor,
    writeAnnotationColorPalette,
} from "@/app/components/shared/annotationColorPalette";

type AnnotationColorPaletteContextValue = {
    colors: string[];
    replaceColor: (index: number, color: string) => void;
};

const AnnotationColorPaletteContext =
    createContext<AnnotationColorPaletteContextValue>({
        colors: defaultAnnotationColorPalette(),
        replaceColor: () => {},
    });

export function AnnotationColorPaletteProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const [colors, setColors] = useState(defaultAnnotationColorPalette);
    const colorsRef = useRef(colors);

    useEffect(() => {
        const initialSyncFrame = window.requestAnimationFrame(() => {
            const stored = readAnnotationColorPalette();
            colorsRef.current = stored;
            setColors(stored);
        });
        const syncFromStorage = (event: StorageEvent) => {
            if (
                event.storageArea === window.localStorage &&
                event.key === ANNOTATION_COLOR_PALETTE_STORAGE_KEY
            ) {
                const stored = readAnnotationColorPalette();
                colorsRef.current = stored;
                setColors(stored);
            }
        };
        window.addEventListener("storage", syncFromStorage);
        return () => {
            window.cancelAnimationFrame(initialSyncFrame);
            window.removeEventListener("storage", syncFromStorage);
        };
    }, []);

    const replaceColor = useCallback((index: number, color: string) => {
        const next = replaceAnnotationPaletteColor(
            colorsRef.current,
            index,
            color,
        );
        colorsRef.current = next;
        setColors(next);
        writeAnnotationColorPalette(next);
    }, []);

    return (
        <AnnotationColorPaletteContext.Provider value={{ colors, replaceColor }}>
            {children}
        </AnnotationColorPaletteContext.Provider>
    );
}

export function useAnnotationColorPalette() {
    return useContext(AnnotationColorPaletteContext);
}
