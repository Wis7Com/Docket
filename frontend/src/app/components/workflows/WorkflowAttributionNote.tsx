"use client";

import type { WorkflowAttribution } from "../shared/types";

/**
 * Credits whoever wrote a workflow's prompt.
 *
 * The Source column in the workflow list answers "how did this reach my
 * workspace" (built-in / mine / shared by someone). That is a different
 * question from who wrote it: most built-in prompts are Open Legal Products'
 * work, reproduced under MIT, and the list would otherwise read as if Docket
 * had authored them.
 */
export function WorkflowAttributionNote({
  attribution,
  className = "",
}: {
  attribution?: WorkflowAttribution | null;
  className?: string;
}) {
  if (!attribution) return null;

  const { author, license, url } = attribution;

  return (
    <span className={`text-xs text-gray-400 ${className}`}>
      Prompt by{" "}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-gray-600 transition-colors"
        >
          {author}
        </a>
      ) : (
        author
      )}{" "}
      · {license}
    </span>
  );
}
