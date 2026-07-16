export type NotificationRouteState = {
  focused: boolean;
  hidden: boolean;
  pathname: string;
};

export type SystemNotificationPermission =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

/**
 * What to do when routing chose "system" delivery. "queue" means the OS
 * channel is unavailable and an immediate toast would be invisible to a
 * hidden/unfocused user — hold it until the window regains focus.
 */
export function systemNotificationFallback(
  permission: SystemNotificationPermission,
): "show" | "request" | "queue" {
  if (permission === "granted") return "show";
  if (permission === "default") return "request";
  return "queue";
}

export function notificationDelivery(
  state: NotificationRouteState,
  href?: string,
  suppressPathPrefix?: string,
): "suppress" | "system" | "toast" {
  if (
    href === state.pathname ||
    (suppressPathPrefix && state.pathname.startsWith(suppressPathPrefix))
  ) {
    return "suppress";
  }
  return state.hidden || !state.focused ? "system" : "toast";
}
