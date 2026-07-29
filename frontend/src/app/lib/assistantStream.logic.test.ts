import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizedMessagesWithHydratedTail,
  updateLastAssistantContentEvent,
  type MessageWithAssistantEvents,
} from "./assistantStream.logic";
import type { DocketMessage } from "@/app/components/shared/types";

test("content_replace remains intact when DONE flush has no drip target", () => {
  let messages: DocketMessage[] = [
    {
      role: "assistant",
      content: "",
      annotations: [],
      events: [
        { type: "reasoning", text: "first thought" },
        { type: "reasoning", text: "second thought" },
        ...Array.from({ length: 8 }, () => ({
          type: "doc_find" as const,
          filename: "source.pdf",
          query: "summary judgment response",
          total_matches: 3,
        })),
        { type: "reasoning", text: "final thought" },
        { type: "content", text: "", isStreaming: true },
      ],
    },
  ];
  const sanitized = [
    "| Issue | Response |",
    "| --- | --- |",
    "| One | Supported [1] and unresolved [2]. |",
    "| Two | Supported [3] through [11]. |",
  ].join("\n");

  messages = updateLastAssistantContentEvent(messages, sanitized);
  assert.equal(messages[0].events?.at(-1)?.type, "content");
  assert.equal(
    (messages[0].events?.at(-1) as { type: "content"; text: string }).text,
    sanitized,
  );

  messages = [
    {
      ...messages[0],
      events: [
        ...(messages[0].events ?? []),
        {
          type: "citation_diagnostics",
          discarded: {},
          recovered: 1,
          repair_attempted: true,
          repair_added: 0,
          orphan_marker_count: 10,
        },
      ],
    },
  ];
  assert.equal(
    (messages[0].events?.find((event) => event.type === "content") as {
      type: "content";
      text: string;
    }).text,
    sanitized,
  );

  messages = [
    {
      ...messages[0],
      events: [
        ...(messages[0].events ?? []),
        {
          type: "citation_summary",
          verified_count: 1,
          used_document_tools: true,
        },
      ],
    },
  ];
  messages = updateLastAssistantContentEvent(messages, "");
  assert.equal(
    (messages[0].events?.find((event) => event.type === "content") as {
      type: "content";
      text: string;
    }).text,
    sanitized,
  );
});

test("finalized content guard applies to tabular-compatible message shape", () => {
  type TRMessage = MessageWithAssistantEvents & { content: string };
  const prev: TRMessage[] = [
    {
      role: "assistant",
      content: "",
      events: [{ type: "content", text: "final table [1]." }],
    },
  ];

  assert.equal(
    updateLastAssistantContentEvent(prev, "", false),
    prev,
  );
  assert.equal(
    updateLastAssistantContentEvent(
      prev,
      "a longer stale drip must not mutate finalized tabular content",
      true,
    ),
    prev,
  );
});

test("terminal hydration falls back to streamed answer when fetched chat is stale", () => {
  const localMessages: DocketMessage[] = [
    { role: "user", content: "compare the highlights" },
    {
      role: "assistant",
      content: "",
      annotations: [],
      events: [{ type: "content", text: "complete answer [1]." }],
    },
  ];
  const staleHydration: DocketMessage[] = [
    { role: "user", content: "compare the highlights" },
  ];
  const freshHydration: DocketMessage[] = [
    ...staleHydration,
    {
      role: "assistant",
      content: "",
      annotations: [],
      events: [{ type: "content", text: "persisted answer [1]." }],
    },
  ];

  assert.equal(
    finalizedMessagesWithHydratedTail(localMessages, staleHydration),
    localMessages,
  );
  assert.equal(
    finalizedMessagesWithHydratedTail(localMessages, freshHydration),
    freshHydration,
  );
});
