import { test } from "node:test";
import { deepEqual, equal } from "rich-assert";
import {
  hasHighlightApi,
  HIGHLIGHT_NAMES,
  syncHighlights,
} from "./HighlightLayer.tsx";

// jsdom does not ship the CSS Custom Highlight API, so we install a
// minimal stub that records what syncHighlights writes. The shape mirrors
// `Map<string, Highlight>` closely enough for the code under test.
type GlobalShape = {
  CSS?: { highlights: Map<string, unknown> };
  Highlight?: new (...ranges: Range[]) => { readonly ranges: Range[] };
};

function withHighlightStub<T>(fn: (calls: Map<string, Range[]>) => T): T {
  const calls = new Map<string, Range[]>();
  class HighlightStub {
    readonly ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  const g = globalThis as unknown as GlobalShape;
  const origCss = g.CSS;
  const origHighlight = g.Highlight;
  const registry = new Map<string, unknown>();
  const origSet = registry.set.bind(registry);
  registry.set = function (name: string, value: unknown) {
    calls.set(name, (value as HighlightStub).ranges);
    return origSet(name, value);
  } as typeof registry.set;
  g.CSS = { highlights: registry };
  g.Highlight = HighlightStub;
  try {
    return fn(calls);
  } finally {
    if (origCss === undefined) {
      delete g.CSS;
    } else {
      g.CSS = origCss;
    }
    if (origHighlight === undefined) {
      delete g.Highlight;
    } else {
      g.Highlight = origHighlight;
    }
  }
}

function makeSpan(text: string, attrsHex: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute("data-cs-attrs", attrsHex);
  span.textContent = text;
  document.body.append(span);
  return span;
}

test("hasHighlightApi detects the Custom Highlight API", () => {
  withHighlightStub(() => {
    equal(hasHighlightApi(), true);
  });
});

test("syncHighlights groups identical-attr runs into one Range each", () => {
  withHighlightStub((calls) => {
    const root = document.createElement("div");
    // "1" = Hit, "2" = Miss, "8" = Cursor (no highlight — cursor uses
    // the Cursor.tsx overlay), "0" = Normal (no highlight).
    const span = makeSpan("ابجد", "1280");
    root.append(span);
    document.body.append(root);
    syncHighlights(root);
    deepEqual(
      [...calls.keys()].sort(),
      [HIGHLIGHT_NAMES.hit, HIGHLIGHT_NAMES.miss].sort(),
    );
    const hitRanges = calls.get(HIGHLIGHT_NAMES.hit)!;
    equal(hitRanges.length, 1);
    equal(hitRanges[0].startOffset, 0);
    equal(hitRanges[0].endOffset, 1);
    const missRanges = calls.get(HIGHLIGHT_NAMES.miss)!;
    equal(missRanges.length, 1);
    equal(missRanges[0].startOffset, 1);
    equal(missRanges[0].endOffset, 2);
    root.remove();
  });
});

test("syncHighlights never registers a cursor highlight", () => {
  withHighlightStub((calls) => {
    const root = document.createElement("div");
    // Pure cursor span — Cursor.tsx's overlay handles painting it,
    // so no highlight should be registered.
    root.append(makeSpan("اب", "08"));
    document.body.append(root);
    syncHighlights(root);
    equal(calls.size, 0);
    root.remove();
  });
});

test("lam-alef halves keep independent attrs (browser clips highlight inside the ligature)", () => {
  withHighlightStub((calls) => {
    const root = document.createElement("div");
    // ل = Hit, ا = Miss. Even though the pair renders as one ligature
    // glyph, we emit two Ranges so the browser paints the leading half
    // Hit and the trailing half Miss within that glyph.
    root.append(makeSpan("لا", "12"));
    document.body.append(root);
    syncHighlights(root);
    const hitRanges = calls.get(HIGHLIGHT_NAMES.hit)!;
    equal(hitRanges.length, 1);
    equal(hitRanges[0].startOffset, 0);
    equal(hitRanges[0].endOffset, 1);
    const missRanges = calls.get(HIGHLIGHT_NAMES.miss)!;
    equal(missRanges.length, 1);
    equal(missRanges[0].startOffset, 1);
    equal(missRanges[0].endOffset, 2);
    root.remove();
  });
});

test("syncHighlights groups consecutive identical-attr units into one Range", () => {
  withHighlightStub((calls) => {
    const root = document.createElement("div");
    root.append(makeSpan("اببب", "1111"));
    document.body.append(root);
    syncHighlights(root);
    const hitRanges = calls.get(HIGHLIGHT_NAMES.hit)!;
    equal(hitRanges.length, 1);
    equal(hitRanges[0].startOffset, 0);
    equal(hitRanges[0].endOffset, 4);
    root.remove();
  });
});
