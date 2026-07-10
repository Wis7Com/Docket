"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getApiBase } from "@/app/lib/docketApi";

export interface Capabilities {
    libreoffice: {
        available: boolean;
        version: string | null;
        install_url: string | null;
    };
}

let cached: Capabilities | null = null;
let inflight: Promise<Capabilities | null> | null = null;

async function fetchCapabilities(
    opts: { force?: boolean } = {},
): Promise<Capabilities | null> {
    if (cached && !opts.force) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) return null;
        try {
            const resp = await fetch(`${await getApiBase()}/auth/capabilities`, {
                headers: { Authorization: `Bearer ${session.access_token}` },
            });
            if (!resp.ok) return null;
            const data = (await resp.json()) as Capabilities;
            cached = data;
            return data;
        } catch {
            return null;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

export function useCapabilities(): {
    capabilities: Capabilities | null;
    loading: boolean;
    refresh: () => Promise<Capabilities | null>;
} {
    const [capabilities, setCapabilities] = useState<Capabilities | null>(
        cached,
    );
    const [loading, setLoading] = useState(!cached);

    useEffect(() => {
        if (cached) return;
        let mounted = true;
        fetchCapabilities()
            .then((c) => {
                if (mounted) setCapabilities(c);
            })
            .finally(() => {
                if (mounted) setLoading(false);
            });
        return () => {
            mounted = false;
        };
    }, []);

    const refresh = useCallback(async () => {
        setLoading(true);
        cached = null;
        const next = await fetchCapabilities({ force: true });
        setCapabilities(next);
        setLoading(false);
        return next;
    }, []);

    return { capabilities, loading, refresh };
}
