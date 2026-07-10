"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { supabase } from "@/lib/supabase";
import { getApiBase } from "@/app/lib/docketApi";

interface User {
  id: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  authLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Module-level guard so the same token doesn't trigger duplicate
// /user/profile POSTs from both checkUser() and the auth-state-change
// listener firing back-to-back at session restore.
const ensuredTokens = new Set<string>();
const LOCAL_USER: User = { id: "local-user", email: "user@local" };

async function ensureProfile(accessToken: string): Promise<void> {
  if (ensuredTokens.has(accessToken)) return;
  ensuredTokens.add(accessToken);
  try {
    const apiBase = await getApiBase();
    const resp = await fetch(`${apiBase}/user/profile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      console.warn(
        "[auth] ensureProfile non-OK:",
        resp.status,
        resp.statusText,
      );
    }
  } catch (err) {
    // Re-allow retry on next session change if this fetch failed.
    ensuredTokens.delete(accessToken);
    console.warn("[auth] ensureProfile failed:", err);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(LOCAL_USER);
  const [authLoading, setAuthLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const checkUser = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;

      if (session?.user) {
        setUser({
          id: session.user.id,
          email: session.user.email || "",
        });
        void ensureProfile(session.access_token);
      } else {
        setUser(LOCAL_USER);
      }
      setAuthLoading(false);
    };

    void checkUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      if (session?.user) {
        setUser({
          id: session.user.id,
          email: session.user.email || "",
        });
        void ensureProfile(session.access_token);
      } else {
        setUser(LOCAL_USER);
      }
      setAuthLoading(false);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: true,
        authLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
