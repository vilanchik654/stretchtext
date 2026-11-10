/*!
 * StretchText — service worker.
 *
 * Owns every network call so the page never sees the reader's key, caches
 * kernels for the session, and streams text back to the content script over a
 * long-lived port.
 */
importScripts('core.js');

const C = self.StretchCore;

const API = 'https://gen.pollinations.ai';
const DEVICE_URL = 'https://enter.pollinations.ai/api/device/code';
const TOKEN_URL = 'https://enter.pollinations.ai/api/device/token';

const DEFAULT_SETTINGS = {
  model: 'openai/gpt-5.4-nano',
  ratio: 16,
  language: 'auto',
  appKey: '',
  // Test hook: the end-to-end suite points this at a local mock. Empty means
  // the real API, and the popup never exposes it.
  apiBase: '',
};

const MAX_CACHE = 120;
const cache = new Map();

/* ------------------------------------------------------------------ *
 * Settings and auth
 * ------------------------------------------------------------------ */

let settingsPromise = null;

async function getSettings() {
  if (!settingsPromise) {
    settingsPromise = chrome.storage.sync.get(DEFAULT_SETTINGS).then((s) => ({ ...DEFAULT_SETTINGS, ...s }));
    settingsPromise.catch(() => {
      settingsPromise = null;
    });
  }
  return settingsPromise;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') settingsPromise = null;
});

async function getAuth() {
  const { auth } = await chrome.storage.session.get('auth');
  if (!auth || !auth.token) return null;
  if (auth.expiresAt && Date.now() > Number(auth.expiresAt)) {
    await chrome.storage.session.remove('auth');
    return null;
  }
  return auth;
}

async function clearAuth() {
  await chrome.storage.session.remove('auth');
}

/* ------------------------------------------------------------------ *
 * API access
 * ------------------------------------------------------------------ */

function apiError(status, body) {
  const err = new Error(C.errorMessage(body, status));
  err.status = status;
  if (status === 401 || status === 403) err.code = 'UNAUTHORIZED';
  else if (status === 402) err.code = 'PAYMENT_REQUIRED';
  else if (status === 429) err.code = 'RATE_LIMIT';
  else if (status >= 500) err.code = 'SERVER';
  else err.code = 'HTTP';
  return err;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(abortError());
        },
        { once: true }
      );
    }
  });

function abortError() {
  const e = new Error('Aborted');
  e.code = 'ABORTED';
  return e;
}

async function fetchWithRetry(url, init, signal) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal && signal.aborted) throw abortError();
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.status === 429 || res.status >= 500) {
        lastError = apiError(res.status, await res.text().catch(() => ''));
        if (attempt < 2) {
          await sleep(600 * Math.pow(2, attempt), signal);
          continue;
        }
        throw lastError;
      }
      return res;
    } catch (err) {
      if (err && err.code === 'ABORTED') throw err;
      if (err && err.status) throw err;
      lastError = err;
      if (attempt < 2) {
        await sleep(700 * Math.pow(2, attempt), signal);
        continue;
      }
    }
  }
  const e = new Error((lastError && lastError.message) || 'Network error');
  e.code = 'NETWORK';
  throw e;
}

/**
 * Stream a completion as text chunks. StretchText is a bring-your-own-Pollen
 * app: without a reader key there is nothing to bill, so we stop early and let
 * the UI open the sign-in page.
 */
async function* generate({ messages, model, signal }) {
  const settings = await getSettings();
  const auth = await getAuth();
  if (!auth || !auth.token) {
    const err = new Error('Connect your Pollen to stretch.');
    err.code = 'NO_KEY';
    throw err;
  }

  const base = (settings.apiBase || API).replace(/\/+$/, '');
  const body = C.buildChatBody({ model, messages, stream: true });

  const res = await fetchWithRetry(
    base + '/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
      body: JSON.stringify(body),
    },
    signal
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) await clearAuth();
    throw apiError(res.status, text);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const json = await res.json().catch(() => null);
    const text = C.extractText(json);
    if (!text) throw apiError(200, 'The model returned an empty answer. Try again.');
    yield text;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sentAny = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = C.parseSSE(buffer);
    buffer = rest;
    for (const ev of events) {
      if (ev.error) throw apiError(200, ev.error);
      if (ev.done) continue;
      if (ev.text) {
        sentAny = true;
        yield ev.text;
      }
    }
  }
  if (!sentAny) {
    // Some models answer without SSE framing; fall back to the buffer.
    const tail = C.cleanModelText(buffer);
    if (tail) yield tail;
    else throw apiError(200, 'The model returned an empty answer. Try again.');
  }
}

/* ------------------------------------------------------------------ *
 * Cached kernels
 * ------------------------------------------------------------------ */

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

/* ------------------------------------------------------------------ *
 * Port: content script -> worker
 * ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'stretch') return;

  const controller = new AbortController();
  let closed = false;

  const post = (msg) => {
    if (closed) return;
    try {
      port.postMessage(msg);
    } catch {
      closed = true;
    }
  };

  port.onDisconnect.addListener(() => {
    closed = true;
    controller.abort();
  });

  port.onMessage.addListener(async (msg) => {
    const id = msg && msg.id;
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.cmd === 'cancel') {
        controller.abort();
        return;
      }

      const settings = await getSettings();
      const model = (msg.model || settings.model || DEFAULT_SETTINGS.model).trim();
      const language = msg.language || settings.language;

      if (msg.cmd === 'compress') {
        const text = C.splitLongText(msg.text || '', 6000)[0];
        if (!text.trim()) throw apiError(400, 'Nothing to stretch.');
        const ratio = Number(msg.ratio) || settings.ratio;
        const key = C.cacheKey(['kernel', C.PROMPT_VERSION, model, ratio, language, text]);

        const hit = cacheGet(key);
        if (hit) {
          post({ type: 'meta', id, cached: true });
          post({ type: 'chunk', id, text: hit });
          post({ type: 'done', id });
          return;
        }

        post({ type: 'meta', id, model });
        let out = '';
        for await (const piece of generate({
          messages: C.buildCompressMessages({ text, ratio, language }),
          model,
          signal: controller.signal,
        })) {
          out += piece;
          post({ type: 'chunk', id, text: piece });
        }
        const cleaned = C.cleanModelText(out);
        if (!cleaned) throw apiError(200, 'The model returned an empty answer. Try again.');
        cacheSet(key, cleaned);
        post({ type: 'done', id, text: cleaned });
        return;
      }

      if (msg.cmd === 'detail') {
        const original = String(msg.original || '');
        const kernel = String(msg.kernel || '');
        const phrase = String(msg.phrase || '');
        if (!phrase) throw apiError(400, 'Nothing to expand.');
        const key = C.cacheKey(['detail', C.PROMPT_VERSION, model, language, phrase, C.djb2(kernel), C.djb2(original)]);

        const hit = cacheGet(key);
        if (hit) {
          post({ type: 'chunk', id, text: hit });
          post({ type: 'done', id, text: hit });
          return;
        }

        post({ type: 'meta', id });
        let out = '';
        for await (const piece of generate({
          messages: C.buildDetailMessages({ original, kernel, phrase, language }),
          model,
          signal: controller.signal,
        })) {
          out += piece;
          post({ type: 'chunk', id, text: piece });
        }
        const cleaned = C.normalizeDetail(out);
        if (!cleaned) throw apiError(200, 'No extra detail at that phrase.');
        cacheSet(key, cleaned);
        post({ type: 'done', id, text: cleaned });
        return;
      }

      throw apiError(400, 'Unknown command');
    } catch (err) {
      if (!err || err.code === 'ABORTED' || controller.signal.aborted) return;
      post({
        type: 'error',
        id,
        code: err.code || 'ERROR',
        message: err.message || 'Something went wrong.',
      });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Tabs: inject on demand, forward actions
 * ------------------------------------------------------------------ */

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return true;
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/core.js', 'src/content.js'] });
    await sleep(120);
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return true;
  } catch {
    return false;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function sendAction(type) {
  const tab = await activeTab();
  if (!tab || !tab.id) return { ok: false, reason: 'no-tab' };
  const ready = await ensureContent(tab.id);
  if (!ready) return { ok: false, reason: 'restricted' };
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'restricted' };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'stretch-selection',
      title: 'Stretch with StretchText',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'stretch-page',
      title: 'Stretch this page with StretchText',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'restore-page',
      title: 'Restore original text',
      contexts: ['page', 'selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'stretch-selection') await sendAction('stretch');
  else if (info.menuItemId === 'stretch-page') await sendAction('stretch-page');
  else if (info.menuItemId === 'restore-page') await sendAction('restore');
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'stretch-selection') await sendAction('stretch');
  else if (command === 'restore-page') await sendAction('restore');
});

/* ------------------------------------------------------------------ *
 * Popup / auth page messages
 * ------------------------------------------------------------------ */

async function status() {
  const auth = await getAuth();
  const settings = await getSettings();
  return {
    signedIn: Boolean(auth),
    mode: auth ? auth.mode || 'device' : 'guest',
    maskedKey: auth && auth.token ? auth.token.slice(0, 6) + '…' + auth.token.slice(-4) : '',
    expiresAt: auth && auth.expiresAt ? auth.expiresAt : null,
    settings,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'status':
          sendResponse({ ok: true, data: await status() });
          break;
        case 'stretch':
          sendResponse({ ok: true, data: await sendAction('stretch') });
          break;
        case 'restore':
          sendResponse({ ok: true, data: await sendAction('restore') });
          break;
        case 'save-settings': {
          const next = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
          await chrome.storage.sync.set(next);
          settingsPromise = null;
          sendResponse({ ok: true, data: await status() });
          break;
        }
        case 'set-key': {
          const token = String(msg.key || '').trim();
          if (!/^[A-Za-z0-9_.-]{8,}$/.test(token)) {
            sendResponse({ ok: false, error: 'That does not look like a Pollinations key.' });
            break;
          }
          await chrome.storage.session.set({
            auth: { token, mode: 'key', expiresAt: null, savedAt: Date.now() },
          });
          sendResponse({ ok: true, data: await status() });
          break;
        }
        case 'sign-out':
          await clearAuth();
          sendResponse({ ok: true, data: await status() });
          break;
        case 'need-auth':
          await chrome.tabs.create({ url: chrome.runtime.getURL('src/auth.html') });
          sendResponse({ ok: true });
          break;
        case 'open-auth':
          await chrome.tabs.create({ url: chrome.runtime.getURL('src/auth.html') });
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();
  return true;
});

