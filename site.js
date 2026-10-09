/* Shared interaction layer: springs, sheets, toasts, modals.
   No dependencies. Exposes window.VC. See site.css for the matching styles. */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // iOS only applies :active to non-links once a touch listener exists.
  document.addEventListener('touchstart', function () {}, { passive: true });

  // Scroll-edge effect: the divider under .vc-sticky only shows once content is underneath.
  var scrollTick = false;
  function markScrolled() {
    scrollTick = false;
    if ((window.scrollY || document.documentElement.scrollTop) > 4) {
      document.documentElement.setAttribute('data-scrolled', '');
    } else {
      document.documentElement.removeAttribute('data-scrolled');
    }
  }
  window.addEventListener('scroll', function () {
    if (!scrollTick) { scrollTick = true; requestAnimationFrame(markScrolled); }
  }, { passive: true });

  // ── Spring ───────────────────────────────────────────────────────────────
  // Apple-style parameters: `damping` (1 = no overshoot) and `response`
  // (seconds to reach the target; not a fixed duration).
  function spring(o) {
    var w = (2 * Math.PI) / (o.response || 0.4);
    var k = w * w;
    var c = 2 * (o.damping == null ? 1 : o.damping) * w;
    var x = o.from, v = o.velocity || 0, to = o.to;
    var last = null, raf = 0, stopped = false;
    var eps = o.precision || 0.4;

    function frame(t) {
      if (stopped) return;
      if (last == null) last = t;
      var dt = Math.min((t - last) / 1000, 1 / 30);
      last = t;
      var steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      var h = dt / steps;
      for (var i = 0; i < steps; i++) {
        var a = -k * (x - to) - c * v;
        v += a * h;
        x += v * h;
      }
      if (Math.abs(x - to) < eps && Math.abs(v) < eps * 8) {
        x = to; v = 0; stopped = true;
        o.onUpdate && o.onUpdate(x);
        o.onDone && o.onDone();
        return;
      }
      o.onUpdate && o.onUpdate(x);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return {
      stop: function () { stopped = true; cancelAnimationFrame(raf); },
      get value() { return x; },
      get velocity() { return v; }
    };
  }

  // Where a flick with this release velocity (px/s) would come to rest.
  function project(velocity, rate) {
    rate = rate || 0.998;
    return (velocity / 1000) * rate / (1 - rate);
  }

  // Progressive resistance past a boundary.
  function rubberband(overshoot, dimension, c) {
    c = c || 0.55;
    return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
  }

  // ── Animated show/hide for existing overlay markup ──────────────────────
  // Works on a `.vc-overlay` element; its first child is the box.
  function show(overlay, origin) {
    clearTimeout(overlay._vcHide);
    overlay.classList.add('vc-overlay');
    if (origin && origin.getBoundingClientRect) {
      var r = origin.getBoundingClientRect();
      overlay.style.setProperty('--vc-ox', (r.left + r.width / 2) + 'px');
      overlay.style.setProperty('--vc-oy', (r.top + r.height / 2) + 'px');
    } else {
      overlay.style.removeProperty('--vc-ox');
      overlay.style.removeProperty('--vc-oy');
    }
    overlay.style.display = 'flex';
    void overlay.offsetWidth; // commit the start state
    overlay.classList.add('vc-in');
  }
  function hide(overlay) {
    overlay.classList.remove('vc-in');
    var ms = reduceMotion.matches ? 0 : 320;
    overlay._vcHide = setTimeout(function () { overlay.style.display = 'none'; }, ms);
  }

  // ── Toast ────────────────────────────────────────────────────────────────
  var toastRegion, toastTimer, currentToast, currentExpire;
  function toast(message, opts) {
    opts = opts || {};
    if (!toastRegion) {
      toastRegion = document.createElement('div');
      toastRegion.id = 'vc-toast-region';
      toastRegion.setAttribute('role', 'status');
      toastRegion.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastRegion);
    }
    clearTimeout(toastTimer);
    if (currentToast) {
      var old = currentToast, oldExpire = currentExpire;
      old.classList.remove('vc-in');
      setTimeout(function () { old.remove(); }, 300);
      currentExpire = null;
      oldExpire && oldExpire(); // replaced = window closed: commit any pending undoable
    }

    var el = document.createElement('div');
    el.className = 'vc-toast vc-glass';
    var span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    function dismiss() {
      clearTimeout(toastTimer);
      el.classList.remove('vc-in');
      setTimeout(function () { el.remove(); }, 300);
      if (currentToast === el) { currentToast = null; currentExpire = null; }
    }
    if (opts.action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = opts.action.label;
      b.addEventListener('click', function () { dismiss(); opts.action.onClick(); });
      el.appendChild(b);
    }
    toastRegion.appendChild(el);
    currentToast = el;
    currentExpire = opts.onExpire || null;
    void el.offsetWidth;
    el.classList.add('vc-in');
    var d = opts.duration != null ? opts.duration : (opts.action ? 6000 : 2600);
    toastTimer = setTimeout(function () {
      dismiss();
      opts.onExpire && opts.onExpire();
    }, d);
    return { dismiss: dismiss };
  }

  // ── Sheet: bottom sheet on phones (draggable, springs), modal elsewhere ──
  var isPhone = window.matchMedia('(max-width: 639px)');

  function sheet(o) {
    o = o || {};
    var overlay = document.createElement('div');
    overlay.className = 'vc-overlay vc-sheet-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var box = document.createElement('div');
    box.className = 'vc-sheet';
    var handle = document.createElement('div');
    handle.className = 'vc-sheet-handle';
    box.appendChild(handle);
    var body = document.createElement('div');
    body.className = 'vc-sheet-body';
    if (o.title) {
      var h = document.createElement('h2');
      h.textContent = o.title;
      body.appendChild(h);
      overlay.setAttribute('aria-label', o.title);
    }
    if (typeof o.content === 'string') { var p = document.createElement('p'); p.textContent = o.content; body.appendChild(p); }
    else if (o.content) body.appendChild(o.content);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    var phone = isPhone.matches;
    var animate = phone && !reduceMotion.matches;
    var height = 0, y = 0, anim = null, closed = false;
    var prevFocus = document.activeElement;

    function setY(v) {
      y = v;
      box.style.transform = 'translate3d(0,' + v + 'px,0)';
      var p = height ? Math.max(0, Math.min(1, 1 - v / height)) : 1;
      overlay.style.background = 'rgba(0,0,0,' + (0.55 * p) + ')';
      overlay.style.backdropFilter = overlay.style.webkitBackdropFilter = 'blur(' + (6 * p) + 'px)';
    }

    overlay.style.display = 'flex';
    if (phone) {
      height = box.offsetHeight;
      if (animate) {
        setY(height);
        anim = spring({ from: height, to: 0, response: 0.4, damping: 1, onUpdate: setY });
      } else {
        box.style.transform = 'none';
        overlay.classList.add('vc-in');
      }
    } else {
      void overlay.offsetWidth;
      overlay.classList.add('vc-in');
    }

    function finish(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      var done = function () {
        overlay.remove();
        if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) {}
        o.onClose && o.onClose(result);
      };
      if (phone && animate) {
        anim && anim.stop();
        anim = spring({ from: y, to: height, velocity: arguments[1] || 0, response: 0.35, damping: 1, precision: 1, onUpdate: setY, onDone: done });
      } else {
        overlay.classList.remove('vc-in');
        setTimeout(done, reduceMotion.matches ? 0 : 280);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', function (e) { if (e.target === overlay) finish(null); });

    // Drag by the grabber: 1:1 tracking from the grab point, interruptible,
    // rubber-band upward, momentum-projected snap on release.
    if (phone && animate) {
      var track = null;
      handle.addEventListener('pointerdown', function (e) {
        anim && anim.stop();               // grab it mid-flight
        handle.setPointerCapture(e.pointerId);
        track = { startY: e.clientY, startPos: y, samples: [{ t: e.timeStamp, y: e.clientY }] };
        box.classList.add('vc-dragging');
      });
      handle.addEventListener('pointermove', function (e) {
        if (!track) return;
        var dy = e.clientY - track.startY;
        var pos = track.startPos + dy;
        setY(pos < 0 ? -rubberband(-pos, height) : pos);
        track.samples.push({ t: e.timeStamp, y: e.clientY });
        if (track.samples.length > 6) track.samples.shift();
      });
      var release = function (e) {
        if (!track) return;
        box.classList.remove('vc-dragging');
        var s = track.samples, a = s[0], b = s[s.length - 1];
        var v = b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0; // px/s, + = down
        track = null;
        var landing = y + project(v, 0.99);
        if (landing > height * 0.5) {
          finish(null, v);
        } else {
          anim = spring({ from: y, to: 0, velocity: v, response: 0.3, damping: Math.abs(v) > 500 ? 0.8 : 1, onUpdate: setY });
        }
      };
      handle.addEventListener('pointerup', release);
      handle.addEventListener('pointercancel', release);
    }

    // Focus the first field (or the box) once it's on screen.
    setTimeout(function () {
      var f = o.initialFocus || box.querySelector('input,textarea,button:not(.vc-sheet-handle)') || box;
      if (f.focus) f.focus({ preventScroll: true });
    }, animate ? 120 : 30);

    return { el: box, body: body, close: function (r) { finish(r == null ? null : r); } };
  }

  function actionsRow(buttons) {
    var row = document.createElement('div');
    row.className = 'vc-actions';
    buttons.forEach(function (b) { row.appendChild(b); });
    return row;
  }
  function button(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'vc-btn ' + (cls || '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // Promise<boolean>. Use sparingly: only for irreversible actions.
  function confirmSheet(o) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      var msg = document.createElement('p');
      msg.textContent = o.message || '';
      wrap.appendChild(msg);
      var s;
      var ok = button(o.confirmLabel || 'Continue', o.danger ? 'vc-danger' : 'vc-primary', function () { resolve(true); s.close(true); });
      var cancel = button(o.cancelLabel || 'Cancel', '', function () { s.close(null); });
      wrap.appendChild(actionsRow([ok, cancel]));
      // Destructive prompts default to the safe choice.
      s = sheet({ title: o.title, content: wrap, initialFocus: o.danger ? cancel : null, onClose: function (r) { resolve(r === true); } });
    });
  }

  // Promise<string|null>.
  function promptSheet(o) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      if (o.message) { var m = document.createElement('p'); m.textContent = o.message; wrap.appendChild(m); }
      var input = document.createElement('input');
      input.type = o.type || 'text';
      input.placeholder = o.placeholder || '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      wrap.appendChild(input);
      var s, submitted = false;
      function submit() { submitted = true; var v = input.value.trim(); s.close(v); }
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      wrap.appendChild(actionsRow([
        button(o.confirmLabel || 'Save', 'vc-primary', submit),
        button('Cancel', '', function () { s.close(null); })
      ]));
      s = sheet({ title: o.title, content: wrap, onClose: function (r) { resolve(submitted && r ? r : null); } });
    });
  }

  // Remove-with-undo: hides immediately, commits after the undo window.
  // `commit` always runs (also on page hide) unless the user undoes.
  function undoable(o) {
    var done = false, undone = false;
    function commit() { if (done || undone) return; done = true; o.commit && o.commit(); }
    o.hide && o.hide();
    var t = toast(o.message, {
      action: { label: 'Undo', onClick: function () { undone = true; o.restore && o.restore(); } },
      duration: o.duration || 6000,
      onExpire: commit
    });
    window.addEventListener('pagehide', commit, { once: true });
    return t;
  }

  window.VC = {
    spring: spring, project: project, rubberband: rubberband,
    show: show, hide: hide,
    toast: toast, sheet: sheet, confirm: confirmSheet, prompt: promptSheet, undoable: undoable,
    reducedMotion: function () { return reduceMotion.matches; }
  };
})();
