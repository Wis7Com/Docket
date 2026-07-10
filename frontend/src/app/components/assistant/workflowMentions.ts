export type WorkflowMention = {
  start: number;
  end: number;
  query: string;
};

export function findWorkflowMention(
  value: string,
  cursor: number,
): WorkflowMention | null {
  const beforeCursor = value.slice(0, Math.max(0, cursor));
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const atOffset = match[0].lastIndexOf("@");
  const start = beforeCursor.length - match[0].length + atOffset;
  return {
    start,
    end: beforeCursor.length,
    query: match[1],
  };
}

export function removeWorkflowMention(
  value: string,
  mention: WorkflowMention,
): { value: string; cursor: number } {
  const before = value.slice(0, mention.start);
  const after = value.slice(mention.end);
  return { value: `${before}${after}`, cursor: before.length };
}
