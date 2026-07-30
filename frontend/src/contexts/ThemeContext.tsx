"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
} from "react";

export type ThemePreference = "light" | "dark" | "system";

// Fallback storage for non-desktop runs (plain `next dev` in a browser).
// Inside Docket the preference lives in the desktop config instead — see
// the bridge below. Also read by the pre-hydration inline script in
// app/layout.tsx; keep the key in sync with it.
const STORAGE_KEY = "docket-theme";

interface ThemeBridge {
    initialTheme?: ThemePreference;
    setTheme?: (theme: ThemePreference) => Promise<{ ok: boolean }>;
    onThemeChanged?: (cb: (theme: ThemePreference) => void) => () => void;
}

interface ThemeContextValue {
    theme: ThemePreference;
    setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
    theme: "system",
    setTheme: () => {},
});

function isThemePreference(value: unknown): value is ThemePreference {
    return value === "light" || value === "dark" || value === "system";
}

function themeBridge(): ThemeBridge | undefined {
    if (typeof window === "undefined") return undefined;
    return window.docket as ThemeBridge | undefined;
}

/**
 * The desktop bridge wins over localStorage. The launcher hands the frontend
 * an OS-assigned port on every start, so the renderer's origin changes each
 * run and takes its localStorage with it — a preference stored only there is
 * gone by the next launch.
 */
function readStoredTheme(): ThemePreference {
    const fromBridge = themeBridge()?.initialTheme;
    if (isThemePreference(fromBridge)) return fromBridge;
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return isThemePreference(stored) ? stored : "system";
    } catch {
        return "system";
    }
}

function applyTheme(theme: ThemePreference) {
    const prefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
    ).matches;
    const isDark = theme === "dark" || (theme === "system" && prefersDark);
    document.documentElement.classList.toggle("dark", isDark);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    // Start from "system" on both server and client, then sync from storage
    // after mount to avoid a hydration mismatch. The visual theme itself is
    // applied pre-hydration by the layout inline script.
    const [theme, setThemeState] = useState<ThemePreference>("system");

    useEffect(() => {
        setThemeState(readStoredTheme());
    }, []);

    const setTheme = useCallback((next: ThemePreference) => {
        setThemeState(next);
        // Persisting is best-effort on both paths; the in-memory theme still
        // applies for this session if a write fails.
        void themeBridge()?.setTheme?.(next);
        try {
            window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // storage may be unavailable (private mode, blocked origin)
        }
    }, []);

    // A change made in one window (Settings) applies to the others.
    useEffect(() => {
        const unsubscribe = themeBridge()?.onThemeChanged?.((next) => {
            if (isThemePreference(next)) setThemeState(next);
        });
        return unsubscribe;
    }, []);

    useEffect(() => {
        applyTheme(theme);
        if (theme !== "system") return;
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => applyTheme("system");
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, [theme]);

    return (
        <ThemeContext.Provider value={{ theme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    return useContext(ThemeContext);
}
