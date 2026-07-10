"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type NavigateBridge = {
    onMainNavigate?: (
        callback: (payload: { path?: string }) => void,
    ) => () => void;
};

// Subscribes to client-side navigation requests pushed from the Electron
// main process (e.g. the document viewer's "+ Chat" routing the main
// window). router.push keeps the running SPA alive — the previous
// win.loadURL path forced a full reload on every hand-off.
export function MainRouteListener() {
    const router = useRouter();

    useEffect(() => {
        const bridge =
            typeof window === "undefined"
                ? undefined
                : (window.docket as NavigateBridge | undefined);
        if (!bridge?.onMainNavigate) return;
        return bridge.onMainNavigate(({ path }) => {
            if (
                typeof path !== "string" ||
                !path.startsWith("/") ||
                path.startsWith("//")
            ) {
                return;
            }
            router.push(path);
        });
    }, [router]);

    return null;
}
