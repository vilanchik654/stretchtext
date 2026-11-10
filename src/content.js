/*!
 * StretchText — content script.
 *
 * Turns a selection into stretchtext in place: the selected text is swapped
 * for a short kernel, phrases in that kernel grow the cut detail back on
 * click, and a small control puts the original nodes back.
 */
(() => {
  'use strict';

  const C = globalThis.StretchCore;
  if (!C || globalThis.__stretchTextLoaded) return;
  globalThis.__stretchTextLoaded = true;

  // Visible from the page world on purpose: it tells the end-to-end test (and
  // the service worker, after a re-injection) that this build is in place.
  try {
    document.documentElement.setAttribute('data-stretchtext', chrome.runtime.getManifest().version);
  } catch {
    /* older page contexts */
  }

  const MIN_CHARS = 20;
  const MAX_CHARS = 6000;
  const MAX_BLOCKS = 6;
  const HL = 'st-pending';
  const SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION|CODE|KBD|SAMP|SVG|CANVAS|VIDEO|AUDIO)$/;

  const settings = { model: 'openai/gpt-5.4-nano', ratio: 16, language: 'auto' };
  const roots = [];
  let seq = 0;
  let busy = false;
  let ui = null;

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  try {
    chrome.storage.sync
      .get(settings)
      .then((s) => Object.assign(settings, s))
      .catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of Object.keys(changes)) {
        if (key in settings) settings[key] = changes[key].newValue;
      }
    });
  } catch {
    /* extension context invalidated (page kept open after reload) */
  }

  /* ------------------------------------------------------------------ *
   * Small UI: bubble + toast, isolated in a shadow root
   * ------------------------------------------------------------------ */

  function mountUi() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.id = 'stretchtext-host';
    host.style.cssText =
      'all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important;';
    // Open on purpose: the bubble has nothing secret in it, and an open root keeps
    // the UI inspectable for screenshots and end-to-end tests.
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bubble, .toast {
          position: fixed; font: 500 13px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #f7f5ff; background: #1b1630; border: 1px solid rgba(255,255,255,.14);
          border-radius: 999px; box-shadow: 0 8px 26px rgba(10, 4, 40, .38), 0 1px 0 rgba(255,255,255,.08) inset;
          display: flex; align-items: center; gap: 8px; padding: 6px; white-space: nowrap;
          animation: st-pop .12s ease-out; user-select: none;
        }
        .bubble { z-index: 2; }
        .toast { z-index: 1; bottom: 22px; left: 50%; transform: translateX(-50%); padding: 9px 14px; max-width: 78vw; white-space: normal; border-radius: 12px; }
        button {
          all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 12px; border-radius: 999px; color: inherit; font: inherit;
        }
        button:hover { background: rgba(255,255,255,.10); }
        button:focus-visible { outline: 2px solid #b9a4ff; outline-offset: 2px; }
        .primary { background: linear-gradient(135deg, #6d4aff, #9e5cff); padding: 6px 13px; }
        .primary:hover { filter: brightness(1.08); background: linear-gradient(135deg, #6d4aff, #9e5cff); }
        .hint { color: #cbc3ea; font-weight: 400; padding-right: 8px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #b9a4ff; animation: st-pulse 1s infinite ease-in-out; }
        .kbd { font: 500 11px/1 ui-monospace, monospace; color: #cbc3ea; border: 1px solid rgba(255,255,255,.18); border-radius: 5px; padding: 2px 5px; }
        @keyframes st-pop { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
        @keyframes st-pulse { 0%,100% { opacity: .35; transform: scale(.85) } 50% { opacity: 1; transform: scale(1) } }
        @media (prefers-reduced-motion: reduce) { .bubble, .toast, .dot { animation: none } }
        [hidden] { display: none !important; }
      </style>
      <div class="bubble" part="bubble" hidden></div>
      <div class="toast" part="toast" hidden></div>
    `;
    (document.documentElement || document.body).appendChild(host);

    ui = {
      host,
      shadow,
      bubble: shadow.querySelector('.bubble'),
      toast: shadow.querySelector('.toast'),
      hideBubble() {
        this.bubble.hidden = true;
      },
      showBubble(rect) {
        const b = this.bubble;
        b.hidden = false;
        b.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'primary';
        btn.dataset.testid = 'stretch';
        btn.type = 'button';
        btn.innerHTML = '<span aria-hidden="true">✧</span> Stretch';
        btn.title = 'Replace the selection with a short version (Alt+S)';
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.hideBubble();
          stretchSelection();
        });
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.innerHTML = '<span class="kbd">Alt</span>+<span class="kbd">S</span>';
        b.append(btn, hint);

        const pad = 8;
        const w = b.getBoundingClientRect().width || 150;
        const left = Math.max(pad, Math.min(window.innerWidth - w - pad, rect.left));
        const top = Math.min(window.innerHeight - 48, rect.bottom + 10);
        b.style.left = left + 'px';
        b.style.top = top + 'px';
      },
      toastTimer: 0,
      showToast(html, ms = 4200, spinner = false) {
        const t = this.toast;
        t.hidden = false;
        t.innerHTML = (spinner ? '<span class="dot"></span>' : '') + '<span>' + html + '</span>';
        clearTimeout(this.toastTimer);
        if (ms) this.toastTimer = setTimeout(() => (t.hidden = true), ms);
      },
      hideToast() {
        this.toast.hidden = true;
        clearTimeout(this.toastTimer);
      },
    };
    return ui;
  }

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */

  function isBlock(el) {
    const d = getComputedStyle(el).display;
    return d === 'block' || d === 'list-item' || d === 'table-cell' || d === 'table-caption' || d === 'flow-root';
  }

  function blockOf(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.nodeType === 1) {
        if (SKIP_TAGS.test(el.tagName)) return null;
        if (el.isContentEditable) return null;
        if (isBlock(el)) return el;
      }
      el = el.parentElement;
    }
    return document.body;
  }

  function isOurs(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(el && el.closest('.st-root, #stretchtext-host'));
  }

  function textNodesInRange(range) {
    const root = range.commonAncestorContainer;
    const container = root.nodeType === 3 ? root.parentElement : root;
    if (!container) return [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.test(node.parentElement ? node.parentElement.tagName : '')) return NodeFilter.FILTER_REJECT;
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function selectionRanges() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return [];
    const range = sel.getRangeAt(0);
    if (isOurs(range.startContainer) || isOurs(range.endContainer)) return [];

    if (range.collapsed) {
      const block = blockOf(range.startContainer);
      if (!block || !block.textContent || block.textContent.trim().length < MIN_CHARS) return [];
      const r = document.createRange();
      r.selectNodeContents(block);
      return [{ range: r, block }];
    }

    const nodes = textNodesInRange(range).filter((n) => !isOurs(n));
    if (!nodes.length) return [];

    const groups = new Map();
    for (const node of nodes) {
      const block = blockOf(node);
      if (!block) continue;
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(node);
    }

    const out = [];
    for (const [block, list] of groups) {
      const first = list[0];
      const last = list[list.length - 1];
      const r = document.createRange();
      const startOffset = first === range.startContainer ? range.startOffset : 0;
      const endOffset = last === range.endContainer ? range.endOffset : last.nodeValue.length;
      try {
        r.setStart(first, startOffset);
        r.setEnd(last, endOffset);
      } catch {
        continue;
      }
      if (r.toString().trim().length >= MIN_CHARS) out.push({ range: r, block });
    }
    return out;
  }

  function markSpan() {
    const s = document.createElement('span');
    s.className = 'st-mark';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function clearHighlight() {
    try {
      if (window.CSS && CSS.highlights) CSS.highlights.delete(HL);
    } catch {
      /* ignore */
    }
  }

  function highlight(range) {
    try {
      if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
        CSS.highlights.set(HL, new Highlight(range));
      }
    } catch {
      /* highlight support is a nicety, not a requirement */
    }
  }

  /* ------------------------------------------------------------------ *
   * Requests
   * ------------------------------------------------------------------ */

  function request(payload, handlers) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'stretch' });
      } catch (err) {
        reject(Object.assign(new Error('The extension was reloaded. Refresh this page.'), { code: 'CONTEXT' }));
        return;
      }
      const id = ++seq;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        fn(value);
      };
      port.onMessage.addListener((msg) => {
        if (!msg || msg.id !== id) return;
        if (msg.type === 'meta') handlers && handlers.onMeta && handlers.onMeta(msg);
        else if (msg.type === 'chunk') handlers && handlers.onChunk && handlers.onChunk(msg.text);
        else if (msg.type === 'done') finish(resolve, msg.text || '');
        else if (msg.type === 'error')
          finish(reject, Object.assign(new Error(msg.message || 'Request failed'), { code: msg.code }));
      });
      port.onDisconnect.addListener(() => {
        if (!settled) finish(reject, Object.assign(new Error('Lost the connection to the extension.'), { code: 'DISCONNECTED' }));
      });
      try {
        port.postMessage({ ...payload, id, model: settings.model, language: settings.language });
      } catch (err) {
        finish(reject, Object.assign(new Error('The extension was reloaded. Refresh this page.'), { code: 'CONTEXT' }));
      }
    });
  }

  let authAskedAt = 0;
  function askForAuth() {
    if (Date.now() - authAskedAt < 60000) return;
    authAskedAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'need-auth' });
    } catch {
      /* extension reloaded */
    }
  }

  function friendlyError(err) {
    const code = err && err.code;
    if (code === 'NO_KEY') return 'Connect your Pollen first — opening the sign-in page…';
    if (code === 'UNAUTHORIZED') return 'Your Pollen key expired — sign in again to keep stretching.';
    if (code === 'PAYMENT_REQUIRED') return 'Not enough Pollen for that request.';
    if (code === 'RATE_LIMIT') return 'Pollinations is rate limiting — try again in a moment.';
    if (code === 'NETWORK') return 'Network hiccup — check your connection and try again.';
    if (code === 'CONTEXT') return 'StretchText was reloaded — refresh this page.';
    return (err && err.message) || 'Something went wrong.';
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function segmentNodes(raw, state) {
    const frag = document.createDocumentFragment();
    const segments = C.parseSegments(raw);
    for (const seg of segments) {
      if (seg.type === 'text') {
        frag.appendChild(document.createTextNode(seg.text));
        continue;
      }
      if (seg.type === 'pending') continue;
      const id = seg.id;
      if (!state.phrases.has(id)) state.phrases.set(id, { id, label: seg.label, el: null, detailEl: null, text: '' });
      const rec = state.phrases.get(id);
      rec.label = seg.label;
      const el = document.createElement('span');
      el.className = 'st-phrase';
      el.dataset.stId = String(id);
      el.textContent = seg.label;
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.setAttribute('aria-expanded', 'false');
      el.title = 'Grow the detail that was cut here';
      rec.el = el;
      frag.appendChild(el);
    }
    return frag;
  }

  function renderKernel(state) {
    const root = state.root;
    const frag = document.createDocumentFragment();
    if (state.lead) frag.appendChild(document.createTextNode(state.lead));
    frag.appendChild(segmentNodes(state.raw, state));
    if (state.trail) frag.appendChild(document.createTextNode(state.trail));

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'st-restore';
    restore.title = 'Restore the original text';
    restore.setAttribute('aria-label', 'Restore the original text');
    restore.textContent = '↺';
    restore.addEventListener('mousedown', (e) => e.preventDefault());
    restore.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      restoreRoot(state);
    });
    frag.appendChild(restore);

    root.replaceChildren(frag);
    state.kernel = C.stripMarkers(state.raw);
  }

  function restoreRoot(state) {
    if (state.restored) return;
    state.restored = true;
    const index = roots.indexOf(state);
    if (index !== -1) roots.splice(index, 1);
    try {
      state.root.replaceWith(state.frag);
    } catch {
      /* the page replaced our node; nothing to restore */
    }
  }

  function restoreAll() {
    let count = 0;
    for (const state of [...roots].reverse()) {
      restoreRoot(state);
      count++;
    }
    if (ui) {
      if (count) ui.showToast('Restored ' + count + (count === 1 ? ' passage' : ' passages') + '.', 2600);
      else ui.showToast('Nothing to restore on this page.', 2600);
    }
  }

  /* ------------------------------------------------------------------ *
   * Expand / collapse
   * ------------------------------------------------------------------ */

  function shrink(state, rec) {
    if (!rec.detailEl) return;
    rec.detailEl.remove();
    rec.detailEl = null;
    rec.textEl = null;
    if (rec.el) {
      rec.el.classList.remove('st-phrase-open');
      rec.el.setAttribute('aria-expanded', 'false');
    }
  }

  async function expand(state, rec) {
    if (rec.detailEl) {
      shrink(state, rec);
      return;
    }
    if (rec.loading) return;

    const detail = document.createElement('span');
    detail.className = 'st-detail';
    detail.dataset.stId = String(rec.id);
    detail.dataset.stState = 'streaming';
    const textEl = document.createElement('span');
    textEl.className = 'st-detail-text';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'st-shrink';
    btn.title = 'Shrink back';
    btn.setAttribute('aria-label', 'Shrink back');
    btn.textContent = '−';
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      shrink(state, rec);
    });
    detail.append(textEl, btn);

    rec.el.after(detail);
    rec.el.classList.add('st-phrase-open');
    rec.el.setAttribute('aria-expanded', 'true');
    rec.detailEl = detail;
    rec.textEl = textEl;

    if (rec.text) {
      textEl.textContent = rec.text;
      detail.dataset.stState = 'done';
      return;
    }

    rec.loading = true;
    textEl.innerHTML = '<span class="st-typing" aria-live="polite">…</span>';
    try {
      let raw = '';
      const done = await request(
        {
          cmd: 'detail',
          original: state.text,
          kernel: state.kernel || '',
          phrase: rec.label,
        },
        {
          onChunk(piece) {
            raw += piece;
            textEl.textContent = C.normalizeDetail(raw);
          },
        }
      );
      const final = C.normalizeDetail(done || raw);
      rec.text = final;
      textEl.textContent = final;
      detail.dataset.stState = 'done';
    } catch (err) {
      shrink(state, rec);
      if (err && (err.code === 'NO_KEY' || err.code === 'UNAUTHORIZED')) askForAuth();
      if (ui) {
        if (/no extra detail/i.test(err.message || '')) ui.showToast('The model had nothing more to add there.', 3200);
        else ui.showToast(esc(friendlyError(err)), 5200);
      }
    } finally {
      rec.loading = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Stretching a range
   * ------------------------------------------------------------------ */

  async function stretchRange({ range }) {
    const raw = range.toString();
    const text = raw.trim();
    if (text.length < MIN_CHARS) return { skipped: 'short' };
    if (text.length > MAX_CHARS) return { skipped: 'long' };

    const lead = (raw.match(/^\s*/) || [''])[0];
    const trail = (raw.match(/\s*$/) || [''])[0];

    const startMark = markSpan();
    const endMark = markSpan();
    try {
      const endRange = range.cloneRange();
      endRange.collapse(false);
      endRange.insertNode(endMark);
      const startRange = range.cloneRange();
      startRange.collapse(true);
      startRange.insertNode(startMark);
    } catch {
      startMark.remove();
      endMark.remove();
      return { skipped: 'dom' };
    }

    const live = document.createRange();
    live.setStartAfter(startMark);
    live.setEndBefore(endMark);
    highlight(live);

    const state = {
      id: ++seq,
      text,
      lead,
      trail,
      raw: '',
      kernel: '',
      root: null,
      frag: null,
      phrases: new Map(),
      restored: false,
    };

    const fail = (err) => {
      clearHighlight();
      startMark.remove();
      endMark.remove();
      if (state.root) restoreRoot(state);
      return { ok: false, error: err };
    };

    try {
      let first = true;
      const done = await request(
        { cmd: 'compress', text, ratio: settings.ratio },
        {
          onChunk(piece) {
            if (first) {
              first = false;
              makeRoot();
            }
            state.raw += piece;
            renderKernel(state);
          },
        }
      );

      makeRoot();
      state.raw = done || state.raw;
      renderKernel(state);
      state.root.dataset.stState = 'done';
      if (!state.kernel) return fail(new Error('The model returned an empty short version.'));

      if (!state.phrases.size && ui) {
        ui.showToast('Stretched. Nothing highlighted — the model kept it all in one piece.', 3200);
      }
      return { ok: true, state };
    } catch (err) {
      return fail(err);
    }

    function makeRoot() {
      if (state.root) return;
      state.frag = live.extractContents();
      const root = document.createElement('span');
      root.className = 'st-root';
      root.dataset.stRoot = String(state.id);
      root.dataset.stState = 'streaming';
      live.insertNode(root);
      startMark.remove();
      endMark.remove();
      clearHighlight();
      state.root = root;
      roots.push(state);
    }
  }

  function selectionTooBig(ranges) {
    return ranges.length > MAX_BLOCKS;
  }

  async function stretchSelection() {
    if (busy) {
      if (ui) ui.showToast('Still stretching the previous selection…', 2400);
      return;
    }
    const uiRef = mountUi();
    const ranges = selectionRanges();

    if (!ranges.length) {
      uiRef.showToast('Select a sentence or a paragraph first, then press <b>Alt+S</b>.', 4200);
      return;
    }
    if (selectionTooBig(ranges)) {
      uiRef.showToast('That is ' + ranges.length + ' blocks. Select at most ' + MAX_BLOCKS + '.', 4200);
      return;
    }

    busy = true;
    let ok = 0;
    let lastError = null;
    try {
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.length > 1) {
          uiRef.showToast('Stretching ' + (i + 1) + ' of ' + ranges.length + '…', 0, true);
        } else {
          uiRef.showToast('Stretching…', 0, true);
        }
        const res = await stretchRange(ranges[i]);
        if (res && res.ok) ok++;
        else if (res && res.error) lastError = res.error;
        else if (res && res.skipped === 'long') lastError = new Error('That block is too long. Select less text.');
        else if (res && res.skipped === 'short') lastError = new Error('Select a bit more text.');
      }
    } finally {
      busy = false;
    }

    if (ok) {
      uiRef.hideToast();
      uiRef.showToast(
        ok === 1
          ? 'Stretched. Click a <b>dotted phrase</b> to grow the detail back.'
          : 'Stretched ' + ok + ' passages. Click a <b>dotted phrase</b> to grow it back.',
        5200
      );
    } else if (lastError) {
      if (lastError.code === 'NO_KEY' || lastError.code === 'UNAUTHORIZED') askForAuth();
      uiRef.showToast(esc(friendlyError(lastError)), 5600);
    }
  }

  async function stretchPage() {
    if (busy) return;
    const host = document.querySelector('article, main, [role="main"]') || document.body;
    const blocks = [...host.querySelectorAll('p, li, blockquote')]
      .filter((el) => {
        const text = el.textContent.trim();
        return text.length >= 160 && text.length <= MAX_CHARS && !isOurs(el) && !el.closest('.st-root');
      })
      .slice(0, 3);

    if (!blocks.length) {
      mountUi().showToast('No long paragraphs found on this page.', 3400);
      return;
    }

    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    busy = true;
    try {
      for (const block of blocks) {
        const range = document.createRange();
        range.selectNodeContents(block);
        await stretchRange({ range, block });
      }
    } finally {
      busy = false;
    }
    mountUi().showToast('Stretched ' + blocks.length + ' paragraphs.', 3600);
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  let bubbleTimer = 0;

  function scheduleBubble() {
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      const uiRef = mountUi();
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        uiRef.hideBubble();
        return;
      }
      if (!String(sel).trim()) {
        uiRef.hideBubble();
        return;
      }
      const range = sel.getRangeAt(0);
      if (isOurs(range.startContainer) || isOurs(range.endContainer)) {
        uiRef.hideBubble();
        return;
      }
      const rects = range.getClientRects();
      const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) {
        uiRef.hideBubble();
        return;
      }
      uiRef.showBubble(rect);
    }, 60);
  }

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (ui && ui.host.contains(e.target)) return;
    scheduleBubble();
  });

  document.addEventListener('mousedown', (e) => {
    if (ui && (e.composedPath().includes(ui.host) || e.target === ui.host)) return;
    if (ui) ui.hideBubble();
  });

  window.addEventListener('scroll', () => ui && ui.hideBubble(), { passive: true, capture: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui) {
      ui.hideBubble();
      ui.hideToast();
    }
  });

  document.addEventListener(
    'click',
    (e) => {
      const phrase = e.target && e.target.closest ? e.target.closest('.st-phrase') : null;
      if (!phrase) return;
      const rootEl = phrase.closest('.st-root');
      if (!rootEl) return;
      const state = roots.find((r) => r.root === rootEl);
      if (!state) return;
      const rec = state.phrases.get(Number(phrase.dataset.stId));
      if (!rec) return;
      e.preventDefault();
      e.stopPropagation();
      // A phrase is only a promise once the kernel has stopped changing.
      if (rootEl.dataset.stState !== 'done') return;
      expand(state, rec);
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const phrase = e.target && e.target.classList && e.target.classList.contains('st-phrase') ? e.target : null;
      if (!phrase) return;
      const rootEl = phrase.closest('.st-root');
      const state = rootEl && roots.find((r) => r.root === rootEl);
      const rec = state && state.phrases.get(Number(phrase.dataset.stId));
      if (!rec) return;
      e.preventDefault();
      if (rootEl.dataset.stState !== 'done') return;
      expand(state, rec);
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'stretch') {
      stretchSelection();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'stretch-page') {
      stretchPage();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'restore') {
      restoreAll();
      sendResponse({ ok: true });
    }
  });
})();



