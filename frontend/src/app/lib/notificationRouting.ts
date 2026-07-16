export type NotificationRouteState = {
  focused: boolean;
  hidden: boolean;
  pathname: string;
};

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
