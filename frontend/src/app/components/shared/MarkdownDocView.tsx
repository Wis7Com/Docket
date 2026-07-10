"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    DocumentNavigationPane,
    type DocumentNavigationItem,
} from "./DocumentNavigationPane";
import type { CitationQuote } from "./types";

interface Props {
    content: string;
    kind: "markdown" | "text";
    quotes?: CitationQuote[];
    quote?: string;
    fallbackPage?: number;
}

const HIGHLIGHT_ATTR = "data-markdown-search-highlight";
const NAV_ATTR = "data-document-nav-id";

function clearMarkdownHighlights(root: HTMLElement) {
    root.querySelectorAll<HTMLElement>(`mark[${HIGHLIGHT_ATTR}]`).forEach((mark) => {
        mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
    });
    root.normalize();
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteCandidates(
    quotes: CitationQuote[] | undefined,
    quote: string | undefined,
): string[] {
    const raw = quotes?.length ? quotes.map((q) => q.quote) : quote ? [quote] : [];
    const candidates: string[] = [];
    for (const value of raw) {
        const cleaned = value
            .replace(/\[\[\/?HL\]\]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        if (!cleaned) continue;
        const segments = cleaned
            .split(/\.{3}|…/)
            .map((segment) => segment.trim())
            .filter(Boolean);
        for (const segment of segments) {
            if (segment.length <= 240) {
                candidates.push(segment);
                continue;
            }
            const words = segment.split(" ").filter(Boolean);
            for (let start = 0; start < words.length; start += 8) {
                const window = words.slice(start, start + 14).join(" ");
                if (window.length >= 32) candidates.push(window);
                if (candidates.length >= 18) break;
            }
        }
    }
    return Array.from(new Set(candidates)).sort((a, b) => b.length - a.length);
}

function highlightInTextNode(node: Text, regex: RegExp): HTMLElement | null {
    const text = node.nodeValue ?? "";
    const match = regex.exec(text);
    if (!match?.[0]) return null;

    const before = text.slice(0, match.index);
    const matched = text.slice(match.index, match.index + match[0].length);
    const after = text.slice(match.index + match[0].length);
    const fragment = document.createDocumentFragment();
    if (before) fragment.appendChild(document.createTextNode(before));
    const mark = document.createElement("mark");
    mark.setAttribute(HIGHLIGHT_ATTR, "true");
    mark.className = "rounded bg-yellow-100 px-0.5 text-gray-950";
    mark.textContent = matched;
    fragment.appendChild(mark);
    if (after) fragment.appendChild(document.createTextNode(after));
    node.replaceWith(fragment);
    return mark;
}

function highlightMarkdownQuote(root: HTMLElement, candidates: string[]) {
    clearMarkdownHighlights(root);
    for (const candidate of candidates) {
        const regex = new RegExp(escapeRegExp(candidate).replace(/\s+/g, "\\s+"), "i");
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent || !node.nodeValue?.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (parent.closest("code, pre, script, style")) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });

        let current = walker.nextNode();
        while (current) {
            const mark = highlightInTextNode(current as Text, regex);
            if (mark) return mark;
            current = walker.nextNode();
        }
    }
    return null;
}

function textFromReactNode(node: React.ReactNode): string {
    if (typeof node === "string" || typeof node === "number") {
        return String(node);
    }
    if (Array.isArray(node)) return node.map(textFromReactNode).join("");
    return "";
}

function slugifyHeading(value: string): string {
    const slug = value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "section";
}

export function MarkdownDocView({
    content,
    kind,
    quotes,
    quote,
}: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const [navOpen, setNavOpen] = useState(true);
    const [navItems, setNavItems] = useState<DocumentNavigationItem[]>([]);
    const [activeNavId, setActiveNavId] = useState<string | null>(null);
    const candidates = useMemo(
        () => quoteCandidates(quotes, quote),
        [quotes, quote],
    );

    const collectNavigation = useCallback(() => {
        const body = bodyRef.current;
        if (!body || kind !== "markdown") {
            setNavItems([]);
            return;
        }
        const seen = new Map<string, number>();
        const items: DocumentNavigationItem[] = [];
        Array.from(body.querySelectorAll<HTMLElement>("h1, h2, h3")).forEach(
            (heading, index) => {
                const title = (heading.textContent ?? "").trim();
                if (!title) return;
                const base = slugifyHeading(title);
                const count = seen.get(base) ?? 0;
                seen.set(base, count + 1);
                const id = `md-${base}${count ? `-${count + 1}` : ""}`;
                const level = Number(heading.tagName.slice(1));
                heading.setAttribute(NAV_ATTR, id);
                heading.id = id;
                items.push({ id, title, level, page: index + 1 });
            },
        );
        setNavItems(items);
        setActiveNavId(items[0]?.id ?? null);
    }, [kind]);

    useEffect(() => {
        const frame = requestAnimationFrame(collectNavigation);
        return () => cancelAnimationFrame(frame);
    }, [collectNavigation, content]);

    useEffect(() => {
        const scrollEl = scrollRef.current;
        const body = bodyRef.current;
        if (!scrollEl || !body || navItems.length === 0) return;
        let scheduled = false;
        const update = () => {
            scheduled = false;
            const scrollRect = scrollEl.getBoundingClientRect();
            let active = navItems[0]?.id ?? null;
            for (const item of navItems) {
                const el = body.querySelector<HTMLElement>(
                    `[${NAV_ATTR}="${CSS.escape(item.id)}"]`,
                );
                if (!el) continue;
                const top = el.getBoundingClientRect().top - scrollRect.top;
                if (top <= 96) active = item.id;
                else break;
            }
            setActiveNavId(active);
        };
        const onScroll = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(update);
        };
        scrollEl.addEventListener("scroll", onScroll, { passive: true });
        update();
        return () => scrollEl.removeEventListener("scroll", onScroll);
    }, [navItems]);

    function scrollToNavItem(item: DocumentNavigationItem) {
        const scrollEl = scrollRef.current;
        const body = bodyRef.current;
        if (!scrollEl || !body) return;
        const el = body.querySelector<HTMLElement>(
            `[${NAV_ATTR}="${CSS.escape(item.id)}"]`,
        );
        if (!el) return;
        const scrollRect = scrollEl.getBoundingClientRect();
        const targetRect = el.getBoundingClientRect();
        scrollEl.scrollTo({
            top: Math.max(0, scrollEl.scrollTop + targetRect.top - scrollRect.top - 24),
            behavior: "smooth",
        });
        setActiveNavId(item.id);
    }

    useEffect(() => {
        const body = bodyRef.current;
        if (!body) return;
        const mark = highlightMarkdownQuote(body, candidates);
        mark?.scrollIntoView({ block: "center", behavior: "smooth" });
        return () => clearMarkdownHighlights(body);
    }, [content, candidates]);

    return (
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
            <DocumentNavigationPane
                items={navItems}
                open={navOpen}
                activeId={activeNavId}
                onOpenChange={setNavOpen}
                onSelect={scrollToNavItem}
            />
            <div
                ref={scrollRef}
                data-session-check="markdown-doc-view"
                className="min-w-0 flex-1 overflow-auto bg-gray-100 px-3 py-5"
            >
                <div className="mx-auto min-h-full max-w-3xl rounded-lg bg-white px-8 py-7 shadow-sm">
                {kind === "markdown" ? (
                    <div
                        ref={bodyRef}
                        className="font-serif text-sm leading-7 text-gray-800"
                    >
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                                h1: ({ children }) => (
                                    <h1
                                        id={`md-${slugifyHeading(textFromReactNode(children))}`}
                                        className="mb-4 mt-6 scroll-mt-6 border-b border-gray-100 pb-2 text-2xl font-semibold leading-tight text-gray-950 first:mt-0"
                                    >
                                        {children}
                                    </h1>
                                ),
                                h2: ({ children }) => (
                                    <h2
                                        id={`md-${slugifyHeading(textFromReactNode(children))}`}
                                        className="mb-3 mt-6 scroll-mt-6 text-xl font-semibold leading-tight text-gray-950 first:mt-0"
                                    >
                                        {children}
                                    </h2>
                                ),
                                h3: ({ children }) => (
                                    <h3
                                        id={`md-${slugifyHeading(textFromReactNode(children))}`}
                                        className="mb-2 mt-5 scroll-mt-6 text-base font-semibold text-gray-900 first:mt-0"
                                    >
                                        {children}
                                    </h3>
                                ),
                                p: ({ children }) => (
                                    <p className="mb-4 last:mb-0">{children}</p>
                                ),
                                ul: ({ children }) => (
                                    <ul className="mb-4 list-disc space-y-1 pl-5">
                                        {children}
                                    </ul>
                                ),
                                ol: ({ children }) => (
                                    <ol className="mb-4 list-decimal space-y-1 pl-5">
                                        {children}
                                    </ol>
                                ),
                                blockquote: ({ children }) => (
                                    <blockquote className="mb-4 border-l-2 border-gray-300 pl-4 text-gray-600">
                                        {children}
                                    </blockquote>
                                ),
                                code: ({ children }) => (
                                    <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.88em] text-gray-900">
                                        {children}
                                    </code>
                                ),
                                pre: ({ children }) => (
                                    <pre className="mb-4 overflow-x-auto rounded-md bg-gray-950 px-4 py-3 text-xs leading-6 text-gray-100">
                                        {children}
                                    </pre>
                                ),
                                table: ({ children }) => (
                                    <div className="mb-4 overflow-x-auto">
                                        <table className="min-w-full border-collapse text-left text-xs">
                                            {children}
                                        </table>
                                    </div>
                                ),
                                th: ({ children }) => (
                                    <th className="border border-gray-200 bg-gray-50 px-2 py-1 font-semibold text-gray-800">
                                        {children}
                                    </th>
                                ),
                                td: ({ children }) => (
                                    <td className="border border-gray-200 px-2 py-1 align-top">
                                        {children}
                                    </td>
                                ),
                                a: ({ children, href }) => (
                                    <a
                                        href={href}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-700 underline decoration-blue-200 underline-offset-2 hover:text-blue-900"
                                    >
                                        {children}
                                    </a>
                                ),
                            }}
                        >
                            {content}
                        </ReactMarkdown>
                    </div>
                ) : (
                    <div ref={bodyRef}>
                        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-gray-800">
                            {content}
                        </pre>
                    </div>
                )}
                </div>
            </div>
        </div>
    );
}
