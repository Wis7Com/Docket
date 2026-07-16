import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationDelivery,
  systemNotificationFallback,
} from "./notificationRouting";

test("notification routing suppresses the page already showing the result", () => {
  assert.equal(notificationDelivery({ focused: true, hidden: false, pathname: "/assistant/chat/a" }, "/assistant/chat/a"), "suppress");
});

test("notification routing prefers a toast while the app is focused", () => {
  assert.equal(notificationDelivery({ focused: true, hidden: false, pathname: "/projects" }, "/assistant/chat/a"), "toast");
});

test("embedding notifications suppress every page inside the project", () => {
  assert.equal(
    notificationDelivery(
      { focused: true, hidden: false, pathname: "/projects/p1/assistant/chat/c1" },
      "/projects/p1",
      "/projects/p1",
    ),
    "suppress",
  );
});

test("notification routing prefers the operating-system channel while hidden", () => {
  assert.equal(notificationDelivery({ focused: false, hidden: true, pathname: "/projects" }, "/assistant/chat/a"), "system");
});

test("an unavailable OS channel queues the notification for the next focus", () => {
  assert.equal(systemNotificationFallback("granted"), "show");
  assert.equal(systemNotificationFallback("default"), "request");
  assert.equal(systemNotificationFallback("denied"), "queue");
  assert.equal(systemNotificationFallback("unsupported"), "queue");
});
