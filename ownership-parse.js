/*
 * Parses the "beneficial ownership" table out of an SEC proxy statement
 * (DEF 14A / DEFM14A / DEF 14C) HTML document and works out which page of the
 * filing each row sits on.
 *
 * Works in the browser (pass a Document from DOMParser) and in Node (pass a
 * linkedom/jsdom document). Nothing here fetches or invents data: every row
 * returned was read from a table row in the filing, and rows whose percentage
 * cannot be read are dropped rather than guessed.
 *
 * Pages: EDGAR HTML has no real pages, so we count the CSS page breaks the
 * filer put in the document (page-break-before/after: always, break-*: page).
 * That reproduces the filing's printed pages. When the footer of each page
 * carries a printed page number we use that instead, so the link text matches
 * what the reader sees at the bottom of the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OwnershipParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BREAK_BEFORE = /(?:page-)?break-before\s*:\s*(?:always|page|left|right)/i;
  var BREAK_AFTER = /(?:page-)?break-after\s*:\s*(?:always|page|left|right)/i;
  var HEADER_RE = /(percent|%\s*of|perc\.|\bpct\b)/i;
  var OWNER_RE = /(beneficial|ownership|owned)/i;
  var CLASS_LABEL_RE = /^(common|class\s+[a-z0-9]+|series\s+[a-z0-9]+|preferred|ordinary)(\s+(stock|shares|voting))*$/i;
  var PCT_RE = /^(\d{1,3}(?:\.\d+)?)\s*%?$/;
  var BLOCK_TAGS = { P: 1, DIV: 1, BR: 1, LI: 1, TR: 1 };

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[ ​‌‍⁠﻿]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Text of an element with spaces at block boundaries, so header cells made of
  // stacked <p> lines read "Percent of Common Stock" like they do on screen.
  function blockText(el) {
    var out = '';
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) {
          var blk = BLOCK_TAGS[c.nodeName.toUpperCase()];
          if (blk) out += ' ';
          walk(c);
          if (blk) out += ' ';
        }
      }
    })(el);
    return clean(out);
  }

  // Text of the first non-empty line of a cell (cells sometimes hold name + address).
  function firstLine(cell) {
    var lines = [];
    var cur = '';
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) cur += c.nodeValue;
        else if (c.nodeType === 1) {
          var tag = c.nodeName.toUpperCase();
          if (tag === 'SUP') continue;
          var blk = BLOCK_TAGS[tag];
          if (blk) { lines.push(cur); cur = ''; }
          walk(c);
          if (blk) { lines.push(cur); cur = ''; }
        }
      }
    })(cell);
    lines.push(cur);
    for (var i = 0; i < lines.length; i++) {
      var t = clean(lines[i]);
      if (t) return t;
    }
    return '';
  }

  function stripName(name) {
    return clean(
      name
        .replace(/[¹²³⁰-⁹]+/g, '')
        .replace(/\s*\(\s*\d{1,2}\s*\)(\s*\(\s*\d{1,2}\s*\))*\s*$/g, '')
        .replace(/([A-Za-z.)])\d{1,2}$/, '$1')
        .replace(/\s*\*+\s*$/, '')
        .replace(/[,;:]\s*$/, '')
    );
  }

  function parsePct(text) {
    var t = clean(text).replace(/\(\s*\d{1,2}\s*\)$/, '').trim();
    if (t === '*' || t === '**' || /^(less than|<)\s*1\s*%?$/i.test(t)) return { text: '<1%', value: null, small: true };
    var m = PCT_RE.exec(t);
    if (!m) return null;
    var v = parseFloat(m[1]);
    if (v > 100) return null;
    return { text: m[1] + '%', value: v };
  }

  function parseShares(text) {
    var t = clean(text).replace(/[\u00b9\u00b2\u00b3\u2070-\u2079]+/g, '').replace(/\(\s*\d{1,2}\s*\)$/, '').trim();
    t = t.replace(/^(\d{1,3}(?:,\d{3})+)\s+\d{1,2}$/, '$1');
    return /^\d{1,3}(?:,\d{3})+$|^\d{4,}$/.test(t) ? t : null;
  }

  function printedPageNumber(tail) {
    // tail = last few non-empty text strings of a page; look for a footer number.
    for (var i = tail.length - 1; i >= 0 && i >= tail.length - 3; i--) {
      var t = clean(tail[i]);
      if (!t || t.length > 90) continue;
      var m = /^(?:.*\|\s*)?(?:page\s*)?(\d{1,3})$/i.exec(t);
      if (m) return parseInt(m[1], 10);
      // "Apple Inc. | 2026 Proxy Statement | 45" style handled above; "45 | Apple Inc." style:
      m = /^(\d{1,3})\s*\|/.exec(t);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function words(s, n, fromEnd) {
    var w = clean(s).split(' ');
    return (fromEnd ? w.slice(-n) : w.slice(0, n)).join(' ');
  }
  function enc(s) {
    return encodeURIComponent(s).replace(/-/g, '%2D').replace(/'/g, '%27');
  }
  // First place in the visible text where `cand` appears as whole words,
  // as a browser's text-fragment search would find it.
  function firstMatch(flat, cand) {
    var re = new RegExp('(?<![A-Za-z0-9])' + esc(cand).replace(/\s+/g, '\\s+') + '(?![A-Za-z0-9])', 'i');
    var m = re.exec(flat);
    return m ? m.index : -1;
  }

  /*
   * parse(doc) -> { rows: [{name, pctText, pct, shares, group, page, pageSeq,
   *                         printedPage, fragment}], pages, usedPrintedNumbers,
   *                 tableFound, notes: [] }
   */
  function parse(doc) {
    var body = doc.body || doc.documentElement;
    var pages = [{ tail: [], has: false }];
    var tables = []; // {el, page, gapBefore}
    var gap = 1e9;
    var flat = ''; // visible text in document order, for checking where a link fragment lands
    var spans = []; // [trElement, start, end] offsets into flat

    function newPage() {
      if (pages[pages.length - 1].has) pages.push({ tail: [], has: false });
    }
    function cur() { return pages[pages.length - 1]; }

    (function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          var t = clean(c.nodeValue);
          if (t) {
            var p = cur();
            p.has = true;
            p.tail.push(t);
            if (p.tail.length > 6) p.tail.shift();
            gap += t.length;
            flat += ' ' + t;
          }
        } else if (c.nodeType === 1) {
          var tag = c.nodeName.toUpperCase();
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD') continue;
          var style = c.getAttribute && c.getAttribute('style');
          if (style && BREAK_BEFORE.test(style)) newPage();
          if (tag === 'TABLE') {
            tables.push({ el: c, page: pages.length - 1, gapBefore: gap, pageObj: cur() });
            // rows may straddle page breaks inside a table; record the page per row
            var rowPages = [];
            (function walkTable(n) {
              for (var k = n.firstChild; k; k = k.nextSibling) {
                if (k.nodeType === 3) {
                  var tt = clean(k.nodeValue);
                  if (tt) { cur().has = true; cur().tail.push(tt); if (cur().tail.length > 6) cur().tail.shift(); flat += ' ' + tt; }
                } else if (k.nodeType === 1) {
                  var ks = k.getAttribute && k.getAttribute('style');
                  if (ks && BREAK_BEFORE.test(ks)) newPage();
                  var isTr = k.nodeName.toUpperCase() === 'TR';
                  var spanStart = flat.length;
                  if (isTr) rowPages.push({ el: k, page: pages.length - 1 });
                  walkTable(k);
                  if (isTr) spans.push([k, spanStart, flat.length]);
                  if (ks && BREAK_AFTER.test(ks)) newPage();
                }
              }
            })(c);
            tables[tables.length - 1].rowPages = rowPages;
            gap = 0;
          } else {
            walk(c);
          }
          if (style && BREAK_AFTER.test(style)) newPage();
        }
      }
    })(body);

    // Printed page numbers. Footers are read per page; the filing's numbering
    // is trusted only when most detected footers agree on one constant offset
    // from the page-break count (cover pages are often unnumbered).
    var printed = pages.map(function (p) { return printedPageNumber(p.tail); });
    var offsets = {}, detected = 0;
    printed.forEach(function (n, idx) {
      if (n == null) return;
      detected++;
      offsets[n - idx] = (offsets[n - idx] || 0) + 1;
    });
    var bestOffset = null, bestCount = 0;
    Object.keys(offsets).forEach(function (o) {
      if (offsets[o] > bestCount) { bestCount = offsets[o]; bestOffset = parseInt(o, 10); }
    });
    var usePrinted = detected >= 6 && bestCount >= detected * 0.6 && bestCount >= 6;
    function labelFor(pageIdx) { return usePrinted ? pageIdx + bestOffset : pageIdx + 1; }

    // Candidate ownership tables.
    function rowCells(tr) {
      var out = [];
      for (var c = tr.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && /^T[DH]$/i.test(c.nodeName)) out.push(c);
      }
      return out;
    }

    function extract(t) {
      var rows = [];
      var headerSeen = false, headerText = '';
      var group = '';
      var prevCellText = '';
      for (var r = 0; r < t.rowPages.length; r++) {
        var tr = t.rowPages[r].el;
        var cells = rowCells(tr);
        var texts = cells.map(blockText).filter(Boolean);
        if (!texts.length) continue;
        var joined = texts.join(' ');
        if (!headerSeen && !texts.some(function (x) { return parsePct(x) || parseShares(x); })) {
          // Headers can span two rows ("Beneficial Ownership" over "Percent of ..."),
          // so accumulate text from the rows before the first data row.
          headerText += ' ' + joined;
          if (r > 6) headerText = '';
          if (HEADER_RE.test(headerText) && OWNER_RE.test(headerText)) headerSeen = true;
          prevCellText = texts[texts.length - 1];
          continue;
        }
        // find pct (last matching cell) and shares
        var pct = null, shares = null, nameCell = null, sharesIdx = -1;
        for (var i = 0; i < cells.length; i++) {
          var tx = clean(cells[i].textContent);
          if (!tx) continue;
          if (!nameCell && /[A-Za-z]{2}/.test(tx) && !parsePct(tx) && !parseShares(tx) && !CLASS_LABEL_RE.test(tx)) nameCell = cells[i];
        }
        for (var q = 0; q < cells.length; q++) {
          var s = parseShares(cells[q].textContent);
          if (s) { shares = s; sharesIdx = q; break; }
        }
        // Percent column: first explicit "x%" / "*" cell after the share count
        // (some tables have several number columns, e.g. a "total" column).
        var bare = null;
        for (var j = sharesIdx + 1; j < cells.length; j++) {
          var ctext = clean(cells[j].textContent);
          var p = parsePct(ctext);
          if (!p) continue;
          if (/%|^\*+$|less than/i.test(ctext)) { pct = p; break; }
          if (!bare && /\./.test(ctext)) bare = p;
        }
        if (!pct && bare) pct = bare;
        var pctCells = 0;
        for (var z = sharesIdx + 1; z < cells.length; z++) {
          var zt = clean(cells[z].textContent);
          if (parsePct(zt) && /%|^\*+$/.test(zt)) pctCells++;
        }
        if (!nameCell) { prevCellText = texts[texts.length - 1]; continue; }
        var name = stripName(firstLine(nameCell));
        var zeroShares = !shares && texts.some(function (x) { return /^(0|[\u2014\u2013-])$/.test(x); });
        if (name.charAt(0) === '*' || name.length > 120 || texts[0] === '*') { prevCellText = texts[texts.length - 1]; continue; }
        if (!pct || (!shares && !zeroShares && !(pct && !pct.small))) {
          // group label row ("5% Shareholders", "Directors and Named Executive Officers")
          if (!pct && texts.length <= 2 && name.length < 80 && !/\d/.test(name.replace(/5\s*%/, ''))) group = name;
          prevCellText = texts[texts.length - 1];
          continue;
        }
        var page = t.rowPages[r].page;
        rows.push({
          name: name,
          pctText: pct.text,
          pct: pct.value,
          multi: pctCells > 1,
          shares: shares,
          group: group,
          pageSeq: page + 1,
          printedPage: usePrinted ? labelFor(page) : null,
          page: labelFor(page),
          fragment: null,
          _tr: tr,
          _nameStart: words(name, 6, false),
        });
        prevCellText = texts[texts.length - 1];
      }
      return { rows: rows, headerSeen: headerSeen, headerText: clean(headerText) };
    }

    var extracted = tables.map(extract);
    var best = -1, bestN = 0;
    extracted.forEach(function (e, i) {
      if (e.headerSeen && e.rows.length > bestN) { best = i; bestN = e.rows.length; }
    });

    var notes = [];
    if (best < 0 || bestN < 2) {
      return { rows: [], pages: pages.length, usedPrintedNumbers: usePrinted, tableFound: false, notes: notes };
    }

    // Neighbouring tables: ownership tables are often split in two (5% holders,
    // then directors/officers) or continue on the next page. Take header-bearing
    // tables within eight tables of the best one (footnote tables sit between them), plus headerless tables that
    // follow with almost no text in between.
    var lo = best, hi = best;
    for (var b = best - 1; b >= 0 && b >= best - 8; b--) {
      if (extracted[b].headerSeen && extracted[b].rows.length) lo = b;
    }
    for (var k = best + 1; k < tables.length && k <= best + 8; k++) {
      var e = extracted[k];
      if (!e.rows.length) continue;
      if (e.headerSeen || tables[k].gapBefore <= 250) hi = k; else break;
    }
    var all = [];
    for (var m = lo; m <= hi; m++) all = all.concat(extracted[m].rows);

    // Dedupe exact repeats caused by a table appearing twice.
    var seen = {};
    all = all.filter(function (r) {
      var key = r.name + '|' + r.pctText + '|' + r.group;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });

    // Deep links. A browser's #:~:text= fragment jumps to the FIRST match in the
    // whole filing, so a name like "Tim Cook" would land in the compensation
    // section. For each row we check, against the document's own text, whether
    // the name (or else the share count) first appears inside this very row,
    // and only then emit a fragment that targets it.
    all.forEach(function (row) {
      var span = null;
      for (var i = 0; i < spans.length; i++) if (spans[i][0] === row._tr) { span = spans[i]; break; }
      var cands = [['name', row._nameStart]];
      if (row.shares) cands.push(['shares', row.shares]);
      for (var c = 0; span && c < cands.length; c++) {
        var at = firstMatch(flat, cands[c][1]);
        if (at >= span[1] && at < span[2]) {
          row.fragment = '#:~:text=' + encodeURIComponent(cands[c][1]).replace(/-/g, '%2D');
          row.anchor = cands[c][0];
          break;
        }
      }
      delete row._tr;
      delete row._nameStart;
    });
    // Rows whose name and share count also appear earlier in the filing get the
    // fragment of the closest row above (else below), so the link still lands
    // in the same table.
    all.forEach(function (row, i) {
      if (row.fragment) return;
      for (var d = 1; d < all.length; d++) {
        var cands = [all[i - d], all[i + d]];
        for (var ci = 0; ci < 2; ci++) {
          var cand = cands[ci];
          if (cand && cand.fragment && cand.anchor !== 'near' && cand.page === row.page) {
            row.fragment = cand.fragment; row.anchor = 'near';
            return;
          }
        }
      }
    });

    if (!usePrinted) notes.push('Could not read printed page numbers, so pages count page breaks from the start of the document.');
    return { rows: all, headerText: extracted[best].headerText, pages: pages.length, usedPrintedNumbers: usePrinted, tableFound: true, notes: notes };
  }

  return { parse: parse, clean: clean };
});
