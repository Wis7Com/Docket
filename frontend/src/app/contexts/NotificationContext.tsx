"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import {
  notificationDelivery,
  systemNotificationFallback,
} from "@/app/lib/notificationRouting";

export type NotificationKind =
  | "chat-complete"
  | "chat-error"
  | "embedding-complete"
  | "embedding-error"
  | "tabular-complete"
  | "tabular-error";

export type AppNotification = {
  title: string;
  body?: string;
  href?: string;
  kind: NotificationKind;
  actionLabel?: string;
  suppressPathPrefix?: string;
};

type NotificationContextValue = {
  notify: (notification: AppNotification) => void;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

function focusDesktopWindow(): void {
  const docket = window.docket as
    | { focusMainWindow?: () => Promise<unknown> }
    | undefined;
  void docket?.focusMainWindow?.();
  window.focus();
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [toasts, setToasts] = useState<(AppNotification & { id: number })[]>([]);
  const nextId = useRef(0);
  const pathnameRef = useRef(pathname);
  const routerRef = useRef(router);
  const dismissTimers = useRef(new Set<number>());
  pathnameRef.current = pathname;
  routerRef.current = router;

  useEffect(() => () => {
    dismissTimers.current.forEach(window.clearTimeout);
    dismissTimers.current.clear();
  }, []);

  const navigate = useCallback((href?: string) => {
    if (href) routerRef.current.push(href);
  }, []);

  const showToast = useCallback((notification: AppNotification) => {
    const id = ++nextId.current;
    setToasts((current) => [...current, { ...notification, id }]);
    const timer = window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
      dismissTimers.current.delete(timer);
    }, 7000);
    dismissTimers.current.add(timer);
  }, []);

  // Notifications that could not reach a hidden/unfocused user (OS channel
  // denied or unsupported) wait here until the window regains focus.
  const pendingToasts = useRef<AppNotification[]>([]);

  useEffect(() => {
    const flushPending = () => {
      if (pendingToasts.current.length === 0) return;
      const queued = pendingToasts.current;
      pendingToasts.current = [];
      for (const notification of queued) {
        // Re-evaluate suppression at flush time: the user may have returned
        // straight to the page the notification points at.
        const delivery = notificationDelivery(
          { focused: true, hidden: false, pathname: pathnameRef.current },
          notification.href,
          notification.suppressPathPrefix,
        );
        if (delivery !== "suppress") showToast(notification);
      }
    };
    window.addEventListener("focus", flushPending);
    return () => window.removeEventListener("focus", flushPending);
  }, [showToast]);

  const notify = useCallback(
    (notification: AppNotification) => {
      // The current page already presents the completed result, so another
      // visual interruption would only be noise.
      const delivery = notificationDelivery(
        {
          focused: document.hasFocus(),
          hidden: document.hidden,
          pathname: pathnameRef.current,
        },
        notification.href,
        notification.suppressPathPrefix,
      );
      if (delivery === "suppress") return;
      if (delivery === "system") {
        const show = () => {
          const systemNotification = new Notification(notification.title, {
            body: notification.body,
          });
          systemNotification.onclick = () => {
            focusDesktopWindow();
            navigate(notification.href);
          };
        };
        const fallback = systemNotificationFallback(
          "Notification" in window ? Notification.permission : "unsupported",
        );
        if (fallback === "show") {
          show();
        } else if (fallback === "request") {
          void Notification.requestPermission().then((permission) => {
            if (permission === "granted") show();
            else pendingToasts.current.push(notification);
          });
        } else {
          pendingToasts.current.push(notification);
        }
        return;
      }

      showToast(notification);
    },
    [navigate, showToast],
  );

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            onClick={() => {
              setToasts((current) => current.filter((item) => item.id !== toast.id));
              navigate(toast.href);
            }}
            className="group flex w-full items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left shadow-lg transition hover:border-gray-300"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-gray-900">{toast.title}</span>
              {toast.body ? <span className="mt-1 block text-sm text-gray-600">{toast.body}</span> : null}
              {toast.actionLabel ? <span className="mt-2 block text-sm font-medium text-blue-600">{toast.actionLabel}</span> : null}
            </span>
            <X className="h-4 w-4 shrink-0 text-gray-400 group-hover:text-gray-700" />
          </button>
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const value = useContext(NotificationContext);
  if (!value) throw new Error("useNotifications must be used inside NotificationProvider");
  return value;
}
