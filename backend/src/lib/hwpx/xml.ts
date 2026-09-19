import { XMLParser } from "fast-xml-parser";

/**
 * A node from fast-xml-parser's `preserveOrder` output: one key naming the
 * element (or `#text`), plus `:@` holding its attributes.
 */
export type XNode = Record<string, unknown>;

const ATTRS_KEY = ":@";
const TEXT_KEY = "#text";

/**
 * Namespace prefixes are stripped so lookups don't depend on the `hp:`/`hh:`
 * prefixes a particular writer chose. Order and whitespace are preserved —
 * run text is mixed content and spaces inside <hp:t> are significant.
 */
export function parseXml(xml: string): XNode[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    preserveOrder: true,
    trimValues: false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: true,
    removeNSPrefix: true,
  });
  return parser.parse(xml) as XNode[];
}

export function elName(node: XNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ATTRS_KEY) return key;
  }
  return null;
}

export function isText(node: XNode): boolean {
  return elName(node) === TEXT_KEY;
}

export function textValue(node: XNode): string {
  const value = node[TEXT_KEY];
  return value == null ? "" : String(value);
}

export function children(node: XNode): XNode[] {
  const name = elName(node);
  if (!name || name === TEXT_KEY) return [];
  const value = node[name];
  return Array.isArray(value) ? (value as XNode[]) : [];
}

export function attr(node: XNode, name: string): string | undefined {
  const attrs = node[ATTRS_KEY] as Record<string, unknown> | undefined;
  const value = attrs?.[name];
  return value == null ? undefined : String(value);
}

export function numAttr(node: XNode, name: string): number | undefined {
  const raw = attr(node, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function child(node: XNode, name: string): XNode | undefined {
  return children(node).find((c) => elName(c) === name);
}

export function childrenNamed(node: XNode, name: string): XNode[] {
  return children(node).filter((c) => elName(c) === name);
}

/** Depth-first search for every descendant element with the given name. */
export function descendants(nodes: XNode[], name: string): XNode[] {
  const found: XNode[] = [];
  const visit = (list: XNode[]) => {
    for (const node of list) {
      if (elName(node) === name) found.push(node);
      visit(children(node));
    }
  };
  visit(nodes);
  return found;
}

/** Concatenated text content of a node, ignoring element structure. */
export function innerText(node: XNode): string {
  if (isText(node)) return textValue(node);
  return children(node).map(innerText).join("");
}
