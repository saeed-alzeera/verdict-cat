import "./highlights.less";
import { Attr } from "@keybr/textinput";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { CS_ATTRS_DATA_ATTRIBUTE, CS_ATTRS_DATASET_KEY } from "./chars.tsx";

// Stable highlight names. Repointing `CSS.highlights.set(name, ...)`
// on every render lets the browser repaint a few Ranges instead of
// reconciling DOM, which is the whole point of using the API.
//
// Cursor rendering is intentionally NOT done via highlights — the
// existing absolute-overlay cursor in Cursor.tsx works for every
// caret shape (Block / Box / Line / Underline), positions itself
// via a DOM Range against the joined text node (so shaping is
// unaffected), and is the user-trusted visual. Highlights are
// limited here to hit / miss / garbage colors.
export const HIGHLIGHT_NAMES = {
  hit: "keybr-textinput-hit",
  miss: "keybr-textinput-miss",
  garbage: "keybr-textinput-garbage",
} as const;

type HighlightName = (typeof HIGHLIGHT_NAMES)[keyof typeof HIGHLIGHT_NAMES];

const ALL_HIGHLIGHT_NAMES: HighlightName[] = [
  HIGHLIGHT_NAMES.hit,
  HIGHLIGHT_NAMES.miss,
  HIGHLIGHT_NAMES.garbage,
];

export function hasHighlightApi(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof (globalThis as { Highlight?: unknown }).Highlight === "function"
  );
}

export function HighlightLayer({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (root == null || !hasHighlightApi()) {
      return;
    }
    syncHighlights(root);
  });
  // `display: contents` keeps the wrapper invisible to layout so the
  // surrounding flex/inline-block flow of TextLines is unaffected.
  return (
    <div ref={ref} style={contentsStyle}>
      {children}
    </div>
  );
}

const contentsStyle = { display: "contents" } as const;

export function syncHighlights(
  root: ParentNode,
): Record<HighlightName, Range[]> {
  const buckets: Record<HighlightName, Range[]> = {
    [HIGHLIGHT_NAMES.hit]: [],
    [HIGHLIGHT_NAMES.miss]: [],
    [HIGHLIGHT_NAMES.garbage]: [],
  };
  const spans = root.querySelectorAll<HTMLElement>(
    `[${CS_ATTRS_DATA_ATTRIBUTE}]`,
  );
  for (const span of spans) {
    const code = span.dataset[CS_ATTRS_DATASET_KEY] ?? "";
    const textNode = span.firstChild;
    if (
      code.length === 0 ||
      textNode == null ||
      textNode.nodeType !== Node.TEXT_NODE
    ) {
      continue;
    }
    appendRangesForSpan(textNode as Text, code, buckets);
  }
  applyHighlights(buckets);
  return buckets;
}

function appendRangesForSpan(
  textNode: Text,
  code: string,
  buckets: Record<HighlightName, Range[]>,
): void {
  // Walk runs of identical digits; one Range per run keeps the highlight
  // count tiny even on long lines.
  let i = 0;
  while (i < code.length) {
    const digit = code.charCodeAt(i);
    let j = i + 1;
    while (j < code.length && code.charCodeAt(j) === digit) {
      j++;
    }
    const attr = parseInt(code[i], 16) as Attr;
    const name = attrToHighlightName(attr);
    if (name != null) {
      const range = document.createRange();
      range.setStart(textNode, i);
      range.setEnd(textNode, j);
      buckets[name].push(range);
    }
    i = j;
  }
}

function attrToHighlightName(attr: Attr): HighlightName | null {
  switch (attr) {
    case Attr.Hit:
      return HIGHLIGHT_NAMES.hit;
    case Attr.Miss:
      return HIGHLIGHT_NAMES.miss;
    case Attr.Garbage:
      return HIGHLIGHT_NAMES.garbage;
    default:
      // Attr.Normal (no highlight) and Attr.Cursor (overlay in
      // Cursor.tsx handles every caret shape) intentionally fall
      // through.
      return null;
  }
}

function applyHighlights(buckets: Record<HighlightName, Range[]>): void {
  const HighlightCtor = (
    globalThis as { Highlight?: new (...r: Range[]) => unknown }
  ).Highlight!;
  const registry = (CSS as unknown as { highlights: Map<string, unknown> })
    .highlights;
  for (const name of ALL_HIGHLIGHT_NAMES) {
    const ranges = buckets[name];
    if (ranges.length > 0) {
      registry.set(name, new HighlightCtor(...ranges));
    } else {
      registry.delete(name);
    }
  }
}
