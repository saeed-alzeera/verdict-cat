import {
  Attr,
  type Char,
  type TextDisplaySettings,
  WhitespaceStyle,
} from "@keybr/textinput";
import { type CodePoint } from "@keybr/unicode";
import { type ReactNode } from "react";
import * as styles from "./chars.module.less";
import { getTextStyle } from "./styles.ts";

// Inline element boundaries terminate text-shaping runs. For Latin and
// other non-cursive scripts this only matters at the cursor, where we
// group Attr.Cursor with Attr.Normal so the cursor does not break
// joining at its position.
//
// For connected scripts (Arabic, Persian, ...) every per-character
// boundary breaks letter joining and the surrounding glyphs snap to
// their isolated forms. As the user types, Hit/Miss attribute changes
// and per-key cls changes would otherwise cause letters to visibly
// "connect" and "disconnect" on every keystroke. We collapse the whole
// run into a single span there. Per-character color comes back via the
// CSS Custom Highlight API: HighlightLayer reads `data-cs-attrs` (one
// hex digit per UTF-16 unit, encoding the Attr value) and binds a Range
// per attribute group into CSS.highlights. The text node stays intact,
// so letter joining is preserved.
export function renderChars(
  settings: TextDisplaySettings,
  chars: readonly Char[],
): ReactNode[] {
  const connectedScript = settings.language.script === "arabic";
  if (connectedScript) {
    return renderConnectedRun(settings, chars);
  }
  const nodes: ReactNode[] = [];
  type Span = {
    chars: CodePoint[];
    attrs: number;
    cls: string | null;
    cursorOffset: number;
  };
  let span: Span = { chars: [], attrs: 0, cls: null, cursorOffset: -1 };
  const pushSpan = (nextSpan: Span) => {
    if (span.chars.length > 0) {
      const hasCursor = span.cursorOffset >= 0;
      nodes.push(
        <span
          key={nodes.length}
          className={hasCursor ? styles.cursor : undefined}
          data-cursor-offset={hasCursor ? span.cursorOffset : undefined}
          style={getTextStyle(span, /* special= */ false)}
        >
          {String.fromCodePoint(...span.chars)}
        </span>,
      );
    }
    span = nextSpan;
  };
  for (let i = 0; i < chars.length; i++) {
    const { codePoint, attrs, cls = null } = chars[i];
    if (codePoint > 0x0020) {
      const groupedSpan = span.attrs === Attr.Cursor ? Attr.Normal : span.attrs;
      const grouped = attrs === Attr.Cursor ? Attr.Normal : attrs;
      if (groupedSpan !== grouped || span.cls !== cls) {
        pushSpan({ chars: [], attrs, cls, cursorOffset: -1 });
      }
      if (attrs === Attr.Cursor) {
        span.cursorOffset = span.chars.length;
      }
      span.chars.push(codePoint);
    } else {
      pushSpan({ chars: [], attrs, cls, cursorOffset: -1 });
      nodes.push(
        <span
          key={nodes.length}
          className={attrs === Attr.Cursor ? styles.cursor : undefined}
          data-cursor-offset={attrs === Attr.Cursor ? 0 : undefined}
          style={getTextStyle({ attrs, cls }, /* special= */ true)}
        >
          {specialChar(settings.whitespaceStyle, codePoint)}
        </span>,
      );
    }
  }
  pushSpan({ chars: [], attrs: 0, cls: null, cursorOffset: -1 });
  return nodes;
}

// Marker attribute name used by HighlightLayer to locate connected-script
// spans and decode their per-unit Attr values.
export const CS_ATTRS_DATASET_KEY = "csAttrs";
export const CS_ATTRS_DATA_ATTRIBUTE = "data-cs-attrs";

// Lam (ل) followed by an alef variant {ا أ إ آ} forms the mandatory
// lam-alef ligature. Safari (18.6 as of writing) paints CSS Custom
// Highlights whole-glyph on ligatures, so the per-character Hit/Miss
// colors collapse to one color across the pair. We insert a ZWNJ
// (U+200C) between the two so the shaper renders them as separate
// glyphs that can be highlighted and measured independently. ZWNJ is
// scoped to this one pair — every other Arabic letter joining is
// preserved.
const LAM = 0x0644;
const ALEFS = new Set([0x0627, 0x0623, 0x0625, 0x0622]);
const ZWNJ = "‌";

function renderConnectedRun(
  settings: TextDisplaySettings,
  chars: readonly Char[],
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let text = "";
  let csAttrs = "";
  let cursorOffset = -1;
  const flush = () => {
    if (text.length > 0) {
      const hasCursor = cursorOffset >= 0;
      nodes.push(
        <span
          key={nodes.length}
          className={hasCursor ? styles.cursor : undefined}
          data-cursor-offset={hasCursor ? cursorOffset : undefined}
          data-cs-attrs={csAttrs}
        >
          {text}
        </span>,
      );
      text = "";
      csAttrs = "";
      cursorOffset = -1;
    }
  };
  for (let i = 0; i < chars.length; i++) {
    const { codePoint, attrs, cls = null } = chars[i];
    if (codePoint > 0x0020) {
      const piece = String.fromCodePoint(codePoint);
      if (attrs === Attr.Cursor && cursorOffset < 0) {
        cursorOffset = text.length;
      }
      const digit = attrs.toString(16);
      for (let k = 0; k < piece.length; k++) {
        csAttrs += digit;
      }
      text += piece;
      // Break the lam-alef ligature only — insert a ZWNJ when this
      // codepoint is ل and the next is an alef variant. The "0" attr
      // digit keeps the ZWNJ invisible to HighlightLayer.
      const next = chars[i + 1];
      if (codePoint === LAM && next != null && ALEFS.has(next.codePoint)) {
        text += ZWNJ;
        csAttrs += "0";
      }
    } else {
      flush();
      nodes.push(
        <span
          key={nodes.length}
          className={attrs === Attr.Cursor ? styles.cursor : undefined}
          data-cursor-offset={attrs === Attr.Cursor ? 0 : undefined}
          style={getTextStyle({ attrs, cls }, /* special= */ true)}
        >
          {specialChar(settings.whitespaceStyle, codePoint)}
        </span>,
      );
    }
  }
  flush();
  return nodes;
}

function specialChar(whitespaceStyle: WhitespaceStyle, codePoint: CodePoint) {
  switch (codePoint) {
    case 0x0009:
      return "";
    case 0x000a:
      return "";
    case 0x0020:
      switch (whitespaceStyle) {
        case WhitespaceStyle.Bar:
          return "";
        case WhitespaceStyle.Bullet:
          return "";
        default:
          return " ";
      }
    default:
      return `U+${codePoint.toString(16).padStart(4, "0")}`;
  }
}

const cursorSelector = `.${styles.cursor}`;

export function findCursor(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(cursorSelector) ?? null;
}
