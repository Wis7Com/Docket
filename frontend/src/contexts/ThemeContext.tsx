"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
} from "react";

export type ThemePreference = "light" | "dark" | "system";

// Also read by the pre-hydration inline script in app/layout.tsx —
// keep the key in sync with it.
const STORAGE_KEY = "docket-theme";

interface ThemeContextValue {
    theme: ThemePreference;
    setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
    theme: "system",
    setTheme: () => {},
});

function readStoredTheme(): ThemePreference {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
}

function applyTheme(theme: ThemePreference) {
    const prefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
    ).matches;
    const isDark = theme === "dark" || (theme === "system" && prefersDark);
    document.documentElement.classList.toggle("dark", isDark);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    // Start from "system" on both server and client, then sync from
    // localStorage after mount to avoid a hydration mismatch. The visual
    // theme itself is applied pre-hydration by the layout inline script.
    const [theme, setThemeState] = useState<ThemePreference>("system");

    useEffect(() => {
        setThemeState(readStoredTheme());
    }, []);

    const setTheme = useCallback((next: ThemePreference) => {
        setThemeState(next);
        try {
            window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // Persisting is best-effort; the in-memory theme still applies.
        }
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
