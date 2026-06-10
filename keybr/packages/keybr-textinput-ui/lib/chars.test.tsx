import { test } from "node:test";
import { Language } from "@keybr/keyboard";
import { Attr, textDisplaySettings } from "@keybr/textinput";
import { deepEqual } from "rich-assert";
import { renderChars } from "./chars.tsx";

test("render empty chars", () => {
  deepEqual(renderChars(textDisplaySettings, []), []);
});

test("render simple chars", () => {
  deepEqual(
    renderChars(textDisplaySettings, [
      { codePoint: /* "a" */ 0x0061, attrs: Attr.Hit },
      { codePoint: /* "b" */ 0x0062, attrs: Attr.Miss },
      { codePoint: /* "c" */ 0x0063, attrs: Attr.Hit },
      { codePoint: /* " " */ 0x0020, attrs: Attr.Hit },
      { codePoint: /* "x" */ 0x0078, attrs: Attr.Cursor },
      { codePoint: /* "y" */ 0x0079, attrs: Attr.Normal },
      { codePoint: /* "z" */ 0x007a, attrs: Attr.Normal },
    ]),
    [
      <span
        key={0}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--hit__color)" }}
      >
        a
      </span>,
      <span
        key={1}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--miss__color)" }}
      >
        b
      </span>,
      <span
        key={2}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--hit__color)" }}
      >
        c
      </span>,
      <span
        key={3}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--hit__color)" }}
      >
        {"\uE000"}
      </span>,
      <span
        key={4}
        className="cursor"
        data-cursor-offset={0}
        style={{ color: "var(--textinput__color)" }}
      >
        xyz
      </span>,
    ],
  );
});

test("render styled chars", () => {
  deepEqual(
    renderChars(textDisplaySettings, [
      { codePoint: /* "a" */ 0x0061, attrs: Attr.Hit, cls: "keyword" },
      { codePoint: /* "b" */ 0x0062, attrs: Attr.Miss, cls: "keyword" },
      { codePoint: /* "c" */ 0x0063, attrs: Attr.Hit, cls: "keyword" },
      { codePoint: /* " " */ 0x0020, attrs: Attr.Hit, cls: "keyword" },
      { codePoint: /* "x" */ 0x0078, attrs: Attr.Cursor, cls: "keyword" },
      { codePoint: /* "y" */ 0x0079, attrs: Attr.Normal, cls: "keyword" },
      { codePoint: /* "z" */ 0x007a, attrs: Attr.Normal, cls: "keyword" },
    ]),
    [
      <span
        key={0}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--hit__color)" }}
      >
        a
      </span>,
      <span
        key={1}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--miss__color)" }}
      >
        b
      </span>,
      <span
        key={2}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--hit__color)" }}
      >
        c
      </span>,
      <span
        key={3}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--hit__color)" }}
      >
        {"\uE000"}
      </span>,
      <span
        key={4}
        className="cursor"
        data-cursor-offset={0}
        style={{ color: "var(--syntax-keyword)" }}
      >
        xyz
      </span>,
    ],
  );
});

test("connected-script run is a single span carrying per-char attrs", () => {
  // For Arabic the renderer collapses the run into a single span to
  // preserve text shaping, and exposes per-character Attr values on
  // `data-cs-attrs` for HighlightLayer to bind into CSS.highlights.
  // Each hex digit is the Attr value for the matching UTF-16 unit:
  // Hit=1, Miss=2, Cursor=8, Normal=0.
  const arabicSettings = { ...textDisplaySettings, language: Language.AR };
  deepEqual(
    renderChars(arabicSettings, [
      { codePoint: /* ARABIC LETTER ALEF */ 0x0627, attrs: Attr.Hit, cls: "keyword" },
      { codePoint: /* ARABIC LETTER BEH */ 0x0628, attrs: Attr.Miss },
      { codePoint: /* ARABIC LETTER JEEM */ 0x062c, attrs: Attr.Cursor, cls: "string" },
      { codePoint: /* ARABIC LETTER DAL */ 0x062f, attrs: Attr.Normal },
    ]),
    [
      <span
        key={0}
        className="cursor"
        data-cursor-offset={2}
        data-cs-attrs="1280"
      >
        ابجد
      </span>,
    ],
  );
});

test("connected-script inserts ZWNJ between ل and ا to break the ligature", () => {
  // Safari paints CSS Custom Highlights whole-glyph on the lam-alef
  // ligature, so per-character Hit/Miss colors merge into one color.
  // We insert a ZWNJ (U+200C) between ل and {ا أ إ آ} only — the rest
  // of the Arabic run stays joined. The ZWNJ gets a "0" attr digit
  // (Normal, no highlight). Cursor offset shifts to account for it:
  // ا in "لا" lives at text index 2 (ل=0, ZWNJ=1, ا=2).
  const arabicSettings = { ...textDisplaySettings, language: Language.AR };
  deepEqual(
    renderChars(arabicSettings, [
      { codePoint: /* ARABIC LETTER LAM */ 0x0644, attrs: Attr.Hit },
      { codePoint: /* ARABIC LETTER ALEF */ 0x0627, attrs: Attr.Cursor },
      { codePoint: /* ARABIC LETTER REH */ 0x0631, attrs: Attr.Normal },
      { codePoint: /* ARABIC LETTER ALEF */ 0x0627, attrs: Attr.Normal },
    ]),
    [
      <span
        key={0}
        className="cursor"
        data-cursor-offset={2}
        data-cs-attrs="10800"
      >
        ل‌ارا
      </span>,
    ],
  );
});

test("render special chars", () => {
  deepEqual(
    renderChars(textDisplaySettings, [
      { codePoint: 0x0000, attrs: Attr.Normal },
      { codePoint: 0x0009, attrs: Attr.Normal },
      { codePoint: 0x000a, attrs: Attr.Normal },
      { codePoint: 0x0020, attrs: Attr.Normal },
    ]),
    [
      <span
        key={0}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--special__color)" }}
      >
        U+0000
      </span>,
      <span
        key={1}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--special__color)" }}
      >
        {"\uE002"}
      </span>,
      <span
        key={2}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--special__color)" }}
      >
        {"\uE003"}
      </span>,
      <span
        key={3}
        className={undefined}
        data-cursor-offset={undefined}
        style={{ color: "var(--textinput--special__color)" }}
      >
        {"\uE000"}
      </span>,
    ],
  );
});
