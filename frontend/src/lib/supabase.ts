/**
 * Compatibility shim for the local desktop build.
 *
 * The original web app called `supabase.auth.getSession()` directly from many
 * components and hooks. In the local desktop build, the JWT comes from the
 * Electron main process after a local desktop session starts. This shim exposes
 * the same `supabase.auth.*` surface the rest of the app already calls, but
 * backs it with `window.docket.*` IPC.
 *
 * `supabase.from(...)` is intentionally not implemented — direct DB access from
 * the browser is replaced by routed backend calls. Any caller still reaching
 * for it will throw, which is a useful signal during compatibility cleanup.
 */

interface DocketBridge {
  getToken: () => Promise<string | null>;
  getUser: () => Promise<{ id: string; email: string } | null>;
}

declare global {
  interface Window {
    docket?: DocketBridge & Record<string, unknown>;
  }
}

interface Session {
  access_token: string;
  user: { id: string; email: string };
}

interface AuthChangeListener {
  (event: string, session: Session | null): void | Promise<void>;
}

// The JWT and user identity are stable for the lifetime of a local project
// session. Electron mints them once at start and users never log in or out.
// Cache the first read so we don't pay an IPC round-trip on every API
// call (the chat hot path was hitting IPC on each `getAuthHeader()`).
type CachedBridge = {
  token: string;
  user: { id: string; email: string };
} | null;

let cachedBridge: CachedBridge = null;
let inflightBridge: Promise<CachedBridge> | null = null;

async function readBridge(): Promise<CachedBridge> {
  if (cachedBridge) return cachedBridge;
  if (inflightBridge) return inflightBridge;
  if (typeof window === "undefined") return null;
  const bridge = window.docket;
  if (!bridge?.getToken || !bridge?.getUser) return null;
  inflightBridge = (async () => {
    const [token, user] = await Promise.all([
      bridge.getToken(),
      bridge.getUser(),
    ]);
    if (!token || !user) return null;
    cachedBridge = { token, user };
    return cachedBridge;
  })();
  try {
    return await inflightBridge;
  } finally {
    inflightBridge = null;
  }
}

function clearBridgeCache(): void {
  cachedBridge = null;
  inflightBridge = null;
}

export function clearLocalSessionCache(): void {
  clearBridgeCache();
}

export const supabase = {
  auth: {
    async getSession(): Promise<{
      data: { session: Session | null };
      error: null;
    }> {
      const bridge = await readBridge();
      if (!bridge) return { data: { session: null }, error: null };
      return {
        data: {
          session: {
            access_token: bridge.token,
            user: bridge.user,
          },
        },
        error: null,
      };
    },
    async getUser(
      _token?: string,
    ): Promise<{
      data: { user: { id: string; email: string } | null };
      error: null;
    }> {
      const bridge = await readBridge();
      return { data: { user: bridge?.user ?? null }, error: null };
    },
    async signOut(): Promise<{ error: null }> {
      clearBridgeCache();
      return { error: null };
    },
    onAuthStateChange(_cb: AuthChangeListener): {
      data: { subscription: { unsubscribe: () => void } };
    } {
      // Auth state in the desktop app is set once at local session start and
      // doesn't change while the window is open. Returning a no-op
      // subscription keeps existing callers happy.
      return {
        data: { subscription: { unsubscribe: () => {} } },
      };
    },
  },
  from(_table: string): never {
    throw new Error(
      "Direct database access via supabase.from() is not supported in the local desktop build. Route the call through the backend API.",
    );
  },
};
