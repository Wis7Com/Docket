"use client";

import type { ReactNode } from "react";

/**
 * Hover/focus bubble for the floating PDF toolbar. The toolbar icons are
 * unlabeled, so the native `title` delay is too slow to explain what a control
 * does — this renders the explanation immediately under the button instead.
 */
export function PdfToolbarTooltip({
    text,
    children,
}: {
    text: string;
    children: ReactNode;
}) {
    return (
        <span className="group relative inline-flex">
            {children}
            <span
                role="tooltip"
                data-session-check="pdf-toolbar-tooltip"
                className="pointer-events-none invisible absolute left-1/2 top-full z-[130] mt-2 w-max max-w-[220px] -translate-x-1/2 rounded-md bg-gray-900 px-2.5 py-1.5 text-[11px] font-normal text-white opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
            >
                <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-gray-900" />
                {text}
            </span>
        </span>
    );
}
