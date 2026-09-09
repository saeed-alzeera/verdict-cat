// Client-side FB2 / non-DRM MOBI -> EPUB conversion, so library.html can
// accept those formats through the same upload flow as native epubs.
// Requires JSZip to already be loaded on the page.
(function(w) {
  'use strict';

  // ---------------------------------------------------------------------
  // Shared EPUB builder
  // ---------------------------------------------------------------------

  function escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  // chapters: [{ title, html }]  (html = inner XHTML body markup, already escaped/safe)
  // images:   [{ filename, mediaType, bytes(Uint8Array) }]
  // meta:     { title, author, coverFilename }
  async function buildEpub(meta, chapters, images) {
    var zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles>\n' +
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
      '  </rootfiles>\n' +
      '</container>\n');

    var manifestItems = [];
    var spineItems = [];
    chapters.forEach(function(ch, i) {
      var id = 'chap' + (i + 1);
      var href = 'text/' + id + '.xhtml';
      manifestItems.push('    <item id="' + id + '" href="' + href + '" media-type="application/xhtml+xml"/>');
      spineItems.push('    <itemref idref="' + id + '"/>');
      zip.file('OEBPS/' + href,
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>' + escapeXml(ch.title || meta.title || '') + '</title>' +
        '<meta charset="utf-8"/></head>\n<body>\n' + ch.html + '\n</body>\n</html>\n');
    });

    images.forEach(function(img, i) {
      manifestItems.push('    <item id="' + img.id + '" href="images/' + img.filename + '" media-type="' + img.mediaType + '"' +
        (img.isCover ? ' properties="cover-image"' : '') + '/>');
      zip.file('OEBPS/images/' + img.filename, img.bytes);
    });

    var navPoints = chapters.map(function(ch, i) {
      var id = 'chap' + (i + 1);
      return '    <navPoint id="navpoint-' + (i + 1) + '" playOrder="' + (i + 1) + '">\n' +
        '      <navLabel><text>' + escapeXml(ch.title || ('Chapter ' + (i + 1))) + '</text></navLabel>\n' +
        '      <content src="text/' + id + '.xhtml"/>\n' +
        '    </navPoint>';
    }).join('\n');

    zip.file('OEBPS/toc.ncx',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '  <head><meta name="dtb:uid" content="urn:uuid:' + (meta.uid || cryptoRandomId()) + '"/></head>\n' +
      '  <docTitle><text>' + escapeXml(meta.title || 'Untitled') + '</text></docTitle>\n' +
      '  <navMap>\n' + navPoints + '\n  </navMap>\n' +
      '</ncx>\n');

    var coverMeta = meta.coverId ? '\n    <meta name="cover" content="' + meta.coverId + '"/>' : '';
    zip.file('OEBPS/content.opf',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n' +
      '    <dc:identifier id="BookId">urn:uuid:' + (meta.uid || cryptoRandomId()) + '</dc:identifier>\n' +
      '    <dc:title>' + escapeXml(meta.title || 'Untitled') + '</dc:title>\n' +
      '    <dc:creator>' + escapeXml(meta.author || 'Unknown') + '</dc:creator>\n' +
      '    <dc:language>' + escapeXml(meta.language || 'en') + '</dc:language>' + coverMeta + '\n' +
      '  </metadata>\n' +
      '  <manifest>\n' +
      '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
      manifestItems.join('\n') + '\n' +
      '  </manifest>\n' +
      '  <spine toc="ncx">\n' + spineItems.join('\n') + '\n  </spine>\n' +
      '</package>\n');

    var blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
    return blob;
  }

  function cryptoRandomId() {
    var bytes = new Uint8Array(16);
    (w.crypto || w.msCrypto).getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  // ---------------------------------------------------------------------
  // FB2 -> EPUB
  // ---------------------------------------------------------------------

  function detectXmlEncoding(bytes) {
    var head = '';
    var n = Math.min(bytes.length, 200);
    for (var i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
    var m = head.match(/encoding=["']([\w-]+)["']/i);
    return m ? m[1].toLowerCase() : 'utf-8';
  }

  function localName(el) {
    return el.localName || el.nodeName.replace(/^.*:/, '');
  }

  function findFirst(root, name) {
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) if (localName(all[i]) === name) return all[i];
    return null;
  }

  function findAll(root, name, direct) {
    var out = [];
    var children = direct ? root.children : root.getElementsByTagName('*');
    for (var i = 0; i < children.length; i++) if (localName(children[i]) === name) out.push(children[i]);
    return out;
  }

  function hrefAttr(el) {
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (/href$/i.test(a.name)) return a.value.replace(/^#/, '');
    }
    return null;
  }

  function fb2InlineToXhtml(node, imageMap) {
    var out = '';
    var children = node.childNodes;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.nodeType === 3) { out += escapeXml(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      var name = localName(c);
      switch (name) {
        case 'emphasis': out += '<em>' + fb2InlineToXhtml(c, imageMap) + '</em>'; break;
        case 'strong': out += '<strong>' + fb2InlineToXhtml(c, imageMap) + '</strong>'; break;
        case 'strikethrough': out += '<s>' + fb2InlineToXhtml(c, imageMap) + '</s>'; break;
        case 'sub': out += '<sub>' + fb2InlineToXhtml(c, imageMap) + '</sub>'; break;
        case 'sup': out += '<sup>' + fb2InlineToXhtml(c, imageMap) + '</sup>'; break;
        case 'a': out += '<a href="#">' + fb2InlineToXhtml(c, imageMap) + '</a>'; break;
        case 'image': {
          var id = hrefAttr(c);
          var file = id && imageMap[id];
          if (file) out += '<img alt="" src="../images/' + file + '"/>';
          break;
        }
        default: out += fb2InlineToXhtml(c, imageMap);
      }
    }
    return out;
  }

  function fb2BlockToXhtml(node, imageMap) {
    var out = '';
    var children = node.children;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      var name = localName(c);
      switch (name) {
        case 'p': out += '<p>' + fb2InlineToXhtml(c, imageMap) + '</p>\n'; break;
        case 'title': out += '<h2>' + fb2InlineToXhtml(c, imageMap).replace(/<\/?p>/g, ' ') + '</h2>\n'; break;
        case 'subtitle': out += '<h3>' + fb2InlineToXhtml(c, imageMap) + '</h3>\n'; break;
        case 'empty-line': out += '<br/>\n'; break;
        case 'image': {
          var id = hrefAttr(c);
          var file = id && imageMap[id];
          if (file) out += '<p><img alt="" src="../images/' + file + '"/></p>\n';
          break;
        }
        case 'epigraph': out += '<div class="epigraph">' + fb2BlockToXhtml(c, imageMap) + '</div>\n'; break;
        case 'cite': out += '<blockquote>' + fb2BlockToXhtml(c, imageMap) + '</blockquote>\n'; break;
        case 'poem': out += '<div class="poem">' + fb2BlockToXhtml(c, imageMap) + '</div>\n'; break;
        case 'stanza': out += '<div class="stanza">' + fb2BlockToXhtml(c, imageMap) + '</div>\n'; break;
        case 'v': out += '<p class="verse">' + fb2InlineToXhtml(c, imageMap) + '</p>\n'; break;
        case 'text-author': out += '<p class="text-author">' + fb2InlineToXhtml(c, imageMap) + '</p>\n'; break;
        case 'section': out += fb2SectionToChapters.__inline ? '' : ''; break; // handled by caller for top-level
        default: break;
      }
    }
    return out;
  }

  // Recursively render a <section> (and any nested sections) into one chapter's HTML.
  function fb2SectionToXhtml(section, imageMap) {
    var html = fb2BlockToXhtml(section, imageMap);
    findAll(section, 'section', true).forEach(function(sub) {
      html += fb2SectionToXhtml(sub, imageMap);
    });
    return html;
  }

  function fb2SectionTitle(section) {
    var title = findAll(section, 'title', true)[0];
    return title ? title.textContent.trim().replace(/\s+/g, ' ') : null;
  }

  async function convertFb2(file) {
    var buf = new Uint8Array(await file.arrayBuffer());
    var encoding = detectXmlEncoding(buf);
    var text;
    try { text = new TextDecoder(encoding).decode(buf); }
    catch (e) { text = new TextDecoder('utf-8').decode(buf); }

    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('Could not parse this .fb2 file — it may be malformed or compressed (fb2.zip is not supported).');
    }

    var root = doc.documentElement;
    var titleInfo = findFirst(root, 'title-info');
    var bookTitle = titleInfo && findFirst(titleInfo, 'book-title');
    var title = bookTitle ? bookTitle.textContent.trim() : baseName(file.name);

    var author = '';
    if (titleInfo) {
      var authorEl = findAll(titleInfo, 'author', true)[0];
      if (authorEl) {
        var first = findFirst(authorEl, 'first-name');
        var last = findFirst(authorEl, 'last-name');
        var nick = findFirst(authorEl, 'nickname');
        author = [first && first.textContent, last && last.textContent].filter(Boolean).join(' ').trim();
        if (!author && nick) author = nick.textContent.trim();
      }
    }

    var lang = findFirst(root, 'lang');

    // Binaries -> image files.
    var binaries = findAll(root, 'binary', true).length ? findAll(root, 'binary', true) : Array.prototype.filter.call(
      root.getElementsByTagName('*'), function(el) { return localName(el) === 'binary'; }
    );
    var imageMap = {}; // fb2 id -> filename
    var images = [];
    binaries.forEach(function(bin, i) {
      var id = bin.getAttribute('id');
      var contentType = bin.getAttribute('content-type') || 'image/jpeg';
      var ext = /png/i.test(contentType) ? 'png' : /gif/i.test(contentType) ? 'gif' : 'jpg';
      var filename = 'img' + (i + 1) + '.' + ext;
      var b64 = (bin.textContent || '').replace(/\s+/g, '');
      var bin_ = atob(b64);
      var bytes = new Uint8Array(bin_.length);
      for (var j = 0; j < bin_.length; j++) bytes[j] = bin_.charCodeAt(j);
      imageMap[id] = filename;
      images.push({ id: 'img' + (i + 1), filename: filename, mediaType: contentType, bytes: bytes });
    });

    // Cover.
    var coverId = null;
    if (titleInfo) {
      var coverpage = findFirst(titleInfo, 'coverpage');
      var coverImg = coverpage && findFirst(coverpage, 'image');
      var href = coverImg && hrefAttr(coverImg);
      if (href && imageMap[href]) {
        coverId = 'img' + (Object.keys(imageMap).indexOf(href) + 1); // best-effort; matched below by filename instead
        var match = images.filter(function(im) { return im.filename === imageMap[href]; })[0];
        if (match) { match.isCover = true; coverId = match.id; }
      }
    }

    // Body -> chapters. Use the first body without a name attribute (footnote
    // bodies etc. are skipped to keep the conversion simple and predictable).
    var bodies = findAll(root, 'body', true);
    var mainBody = bodies.filter(function(b) { return !b.getAttribute('name'); })[0] || bodies[0];
    if (!mainBody) throw new Error('No readable content found in this .fb2 file.');

    var topSections = findAll(mainBody, 'section', true);
    var chapters = [];
    if (topSections.length) {
      topSections.forEach(function(sec) {
        chapters.push({ title: fb2SectionTitle(sec) || ('Chapter ' + (chapters.length + 1)), html: fb2SectionToXhtml(sec, imageMap) });
      });
    } else {
      chapters.push({ title: title, html: fb2BlockToXhtml(mainBody, imageMap) });
    }

    var blob = await buildEpub(
      { title: title, author: author, language: lang ? lang.textContent.trim() : 'en', coverId: coverId },
      chapters, images
    );
    return new File([blob], baseName(file.name) + '.epub', { type: 'application/epub+zip' });
  }

  // ---------------------------------------------------------------------
  // MOBI -> EPUB (non-DRM, classic/PalmDOC-or-uncompressed MOBI only)
  // ---------------------------------------------------------------------

  function palmDocDecompress(bytes) {
    var out = [];
    var i = 0, len = bytes.length;
    while (i < len) {
      var c = bytes[i++];
      if (c === 0) {
        out.push(c);
      } else if (c <= 8) {
        for (var j = 0; j < c && i < len; j++) out.push(bytes[i++]);
      } else if (c <= 0x7f) {
        out.push(c);
      } else if (c <= 0xbf) {
        var c2 = bytes[i++];
        var distance = (((c & 0x3f) << 8) | c2) >> 3;
        var lengthLZ = (c2 & 0x7) + 3;
        var start = out.length - distance;
        for (var k = 0; k < lengthLZ; k++) out.push(out[start + k]);
      } else {
        out.push(0x20);
        out.push(c ^ 0x80);
      }
    }
    return new Uint8Array(out);
  }

  function trailingSingleEntrySize(data, alreadyStripped) {
    var bitpos = 0, result = 0, pos = data.length - alreadyStripped - 1;
    while (pos >= 0) {
      var v = data[pos--];
      result |= (v & 0x7f) << bitpos;
      bitpos += 7;
      if (v & 0x80) break;
    }
    return result;
  }

  function trailingBytesSize(data, flags) {
    var num = 0;
    var testflags = flags >> 1;
    while (testflags) {
      if (testflags & 1) num += trailingSingleEntrySize(data, num);
      testflags >>= 1;
    }
    if (flags & 1) num += (data[data.length - num - 1] & 0x3) + 1;
    return num;
  }

  function ascii(u8, offset, length) {
    var s = '';
    for (var i = 0; i < length; i++) s += String.fromCharCode(u8[offset + i]);
    return s;
  }

  async function convertMobi(file) {
    var buf = new Uint8Array(await file.arrayBuffer());
    var dv = new DataView(buf.buffer);

    var numRecords = dv.getUint16(76);
    if (numRecords < 2) throw new Error('This .mobi file looks corrupted (no records found).');
    var recordOffsets = [];
    for (var i = 0; i < numRecords; i++) recordOffsets.push(dv.getUint32(78 + i * 8));

    function record(idx) {
      var start = recordOffsets[idx];
      var end = idx + 1 < recordOffsets.length ? recordOffsets[idx + 1] : buf.length;
      return buf.subarray(start, end);
    }

    var rec0 = record(0);
    var rdv = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength);
    var compression = rdv.getUint16(0);
    var textRecordCount = rdv.getUint16(8);
    var encryptionType = rdv.getUint16(12);
    if (encryptionType !== 0) {
      throw new Error('This .mobi file is DRM-protected and cannot be converted here — remove the DRM first (e.g. with Calibre + DeDRM) or use a different copy.');
    }
    if (compression !== 1 && compression !== 2) {
      throw new Error('This .mobi file uses an unsupported compression scheme (HUFF/CDIC), which this in-browser converter cannot decode. Try converting it with Calibre instead.');
    }
    if (ascii(rec0, 16, 4) !== 'MOBI') {
      throw new Error('This does not look like a valid MOBI file.');
    }

    var headerLength = rdv.getUint32(20);
    var textEncodingCode = rdv.getUint32(28);
    var fullNameOffset = rdv.getUint32(84);
    var fullNameLength = rdv.getUint32(88);
    var firstImageIndex = headerLength >= 108 - 16 + 4 ? rdv.getUint32(108) : 0xffffffff;
    var exthFlags = headerLength >= 128 - 16 + 4 ? rdv.getUint32(128) : 0;
    var extraFlags = headerLength >= 242 - 16 + 4 ? rdv.getUint16(242) : 0;

    var textDecoder;
    try { textDecoder = new TextDecoder(textEncodingCode === 65001 ? 'utf-8' : 'windows-1252'); }
    catch (e) { textDecoder = new TextDecoder('utf-8'); }

    var title = fullNameLength ? textDecoder.decode(rec0.subarray(fullNameOffset, fullNameOffset + fullNameLength)) : baseName(file.name);

    // EXTH metadata (author, etc).
    var author = '';
    var coverImageIndex = -1;
    if (exthFlags & 0x40) {
      var exthOffset = 16 + headerLength;
      if (ascii(rec0, exthOffset, 4) === 'EXTH') {
        var exthCount = rdv.getUint32(exthOffset + 8);
        var pos = exthOffset + 12;
        for (var e = 0; e < exthCount; e++) {
          var recType = rdv.getUint32(pos);
          var recLen = rdv.getUint32(pos + 4);
          var dataStart = pos + 8, dataLen = recLen - 8;
          if (recType === 100 && !author) {
            author = textDecoder.decode(rec0.subarray(dataStart, dataStart + dataLen));
          } else if (recType === 201 && dataLen >= 4) {
            coverImageIndex = new DataView(rec0.buffer, rec0.byteOffset + dataStart, 4).getUint32(0);
          }
          pos += recLen;
        }
      }
    }

    // Decompress text records.
    var rawChunks = [];
    for (var t = 1; t <= textRecordCount; t++) {
      var data = record(t);
      if (extraFlags) {
        var trail = trailingBytesSize(data, extraFlags);
        if (trail > 0 && trail < data.length) data = data.subarray(0, data.length - trail);
      }
      rawChunks.push(compression === 2 ? palmDocDecompress(data) : data);
    }
    var totalLen = rawChunks.reduce(function(n, c) { return n + c.length; }, 0);
    var rawText = new Uint8Array(totalLen);
    var off = 0;
    rawChunks.forEach(function(c) { rawText.set(c, off); off += c.length; });
    var html = textDecoder.decode(rawText);

    // Sanity check: KF8-only files (AZW3) or other unrecognized formats
    // decode to mostly-binary garbage rather than markup.
    var printableSample = html.slice(0, 2000);
    var printableRatio = (printableSample.match(/[\x20-\x7e\r\n\t]/g) || []).length / Math.max(1, printableSample.length);
    if (printableRatio < 0.85 && !/<html|<HTML|<body|<BODY/.test(printableSample)) {
      throw new Error('This file appears to be a KF8/AZW3-format book, which this converter does not support. Try converting it with Calibre instead.');
    }

    // Collect image records.
    var images = [];
    var imageList = []; // in-order recindex -> filename
    if (firstImageIndex !== 0xffffffff && firstImageIndex < numRecords) {
      for (var ii = firstImageIndex; ii < numRecords; ii++) {
        var idata = record(ii);
        if (idata.length < 4) continue;
        var mediaType = null, ext = null;
        if (idata[0] === 0xff && idata[1] === 0xd8) { mediaType = 'image/jpeg'; ext = 'jpg'; }
        else if (idata[0] === 0x89 && idata[1] === 0x50 && idata[2] === 0x4e && idata[3] === 0x47) { mediaType = 'image/png'; ext = 'png'; }
        else if (idata[0] === 0x47 && idata[1] === 0x49 && idata[2] === 0x46) { mediaType = 'image/gif'; ext = 'gif'; }
        if (!mediaType) continue;
        var filename = 'img' + (imageList.length + 1) + '.' + ext;
        var id = 'img' + (imageList.length + 1);
        var isCover = (ii === coverImageIndex) || (ii - firstImageIndex === coverImageIndex);
        images.push({ id: id, filename: filename, mediaType: mediaType, bytes: idata.slice(), isCover: isCover });
        imageList.push(filename);
      }
    }
    var coverId = null;
    images.forEach(function(im) { if (im.isCover) coverId = im.id; });

    // Strip proprietary Mobipocket markup, rewrite image refs.
    var body = html;
    var bodyMatch = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) body = bodyMatch[1];

    body = body.replace(/<mbp:pagebreak\s*\/?>/gi, ' PAGEBREAK ');
    body = body.replace(/<\/?mbp:[^>]*>/gi, '');
    body = body.replace(/<a([^>]*)\sfilepos="[^"]*"([^>]*)>/gi, '<a$1$2>');
    body = body.replace(/<img([^>]*)recindex="0*(\d+)"([^>]*?)\/?>/gi, function(_, pre, idxStr, post) {
      var idx = parseInt(idxStr, 10) - 1;
      var filename = imageList[idx];
      return filename ? '<img' + pre + 'src="../images/' + filename + '"' + post + '/>' : '';
    });
    body = body.replace(/<guide>[\s\S]*?<\/guide>/gi, '');

    var chapterHtmls = body.split(' PAGEBREAK ').map(function(s) { return s.trim(); }).filter(Boolean);
    var chapters = (chapterHtmls.length > 1 ? chapterHtmls : [body]).map(function(html, i) {
      return { title: 'Chapter ' + (i + 1), html: html };
    });
    if (!chapters.length) throw new Error('No readable text found in this .mobi file.');

    var blob = await buildEpub({ title: title, author: author, language: 'en', coverId: coverId }, chapters, images);
    return new File([blob], baseName(file.name) + '.epub', { type: 'application/epub+zip' });
  }

  // ---------------------------------------------------------------------

  w.EbookConvert = {
    supportedExtensions: ['epub', 'fb2', 'mobi'],
    needsConversion: function(filename) {
      var ext = (filename.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
      return ext === 'fb2' || ext === 'mobi';
    },
    isSupported: function(filename) {
      var ext = (filename.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
      return this.supportedExtensions.indexOf(ext) !== -1;
    },
    // Returns a Promise<File> containing a valid .epub, converting fb2/mobi as needed.
    convert: async function(file) {
      var ext = (file.name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
      if (ext === 'epub') return file;
      if (ext === 'fb2') return convertFb2(file);
      if (ext === 'mobi') return convertMobi(file);
      throw new Error('Unsupported file type: .' + ext + ' (only .epub, .fb2 and .mobi are supported — .azw3 cannot be converted in-browser).');
    }
  };
})(window);
