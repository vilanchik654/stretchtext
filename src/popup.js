'use strict';

const $ = (id) => document.getElementById(id);
const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(res || { ok: false, error: 'No response' });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });

let status = null;

function ratioLabel(ratio) {
  const r = Math.max(1, Math.round(100 / ratio));
  return '1/' + r;
}

function relative(ts) {
  if (!ts) return '';
  const days = Math.max(0, Math.ceil((ts - Date.now()) / 86400000));
  if (days <= 0) return 'expired';
  return 'expires in ' + days + (days === 1 ? ' day' : ' days');
}

function note(text, kind) {
  const el = $('note');
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.style.background = kind === 'ok' ? 'color-mix(in srgb, var(--ok) 14%, transparent)' : '';
  el.style.borderColor = kind === 'ok' ? 'color-mix(in srgb, var(--ok) 34%, transparent)' : '';
}

function render() {
  if (!status) return;
  const { signedIn, mode, maskedKey, expiresAt, settings } = status;

  $('mode').textContent = signedIn
    ? mode === 'key'
      ? 'Signed in with an API key'
      : 'Signed in with Pollinations'
    : 'Not connected — sign in to spend your Pollen';

  $('pollen-dot').className = 'dot ' + (signedIn ? 'on' : 'warn');

  if (signedIn) {
    $('pollen-text').textContent = 'Each stretch spends your own Pollen.';
    $('guest-actions').hidden = true;
    $('signed-in').hidden = false;
    $('key-line').textContent = maskedKey + (expiresAt ? ' · ' + relative(expiresAt) : ' · no expiry');
  } else {
    $('pollen-text').textContent = 'StretchText bills your own Pollen. Connect once — your password never leaves Pollinations.';
    $('guest-actions').hidden = false;
    $('signed-in').hidden = true;
  }

  const model = settings.model || 'openai/gpt-5.4-nano';
  const select = $('model');
  if (![...select.options].some((o) => o.value === model)) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    select.append(opt);
  }
  select.value = model;

  $('ratio').value = String(settings.ratio || 16);
  $('ratio-out').textContent = ratioLabel(Number(settings.ratio) || 16);
  $('language').value = settings.language || 'auto';
  $('appkey').value = settings.appKey || '';

  const v = chrome.runtime.getManifest().version;
  $('version').textContent = 'v' + v;
}

async function refresh() {
  const res = await send({ type: 'status' });
  if (res && res.ok) {
    status = res.data;
    render();
  }
}

async function saveSettings(patch) {
  const settings = { ...(status && status.settings), ...patch };
  const res = await send({ type: 'save-settings', settings });
  if (res && res.ok) {
    status = res.data;
    render();
  }
  return res;
}

async function tabAction(type) {
  const res = await send({ type });
  const data = (res && res.data) || {};
  if (res && res.ok && data.ok) {
    note('');
    window.close();
    return;
  }
  if (data.reason === 'restricted' || data.reason === 'no-tab') {
    note('This page does not allow extensions (browser pages, the Web Store, PDFs). Try a normal web page.');
    return;
  }
  if (res && res.error) note(res.error);
  else note('Could not reach the page. Reload it and try again.');
}

/* ---------------------------------------------------------------- */

$('stretch').addEventListener('click', () => tabAction('stretch'));
$('restore').addEventListener('click', () => tabAction('restore'));

$('settings-toggle').addEventListener('click', () => {
  const panel = $('settings');
  panel.hidden = !panel.hidden;
  $('settings-toggle').setAttribute('aria-expanded', String(!panel.hidden));
});

$('signin').addEventListener('click', async () => {
  const res = await send({ type: 'open-auth' });
  if (!res.ok) note(res.error || 'Could not open the sign-in page.');
  else window.close();
});

$('show-key').addEventListener('click', () => {
  $('key-panel').hidden = false;
  $('key').focus();
});

$('cancel-key').addEventListener('click', () => {
  $('key-panel').hidden = true;
  $('key').value = '';
});

$('save-key').addEventListener('click', async () => {
  const key = $('key').value.trim();
  if (!key) return;
  const res = await send({ type: 'set-key', key });
  if (res && res.ok) {
    status = res.data;
    $('key').value = '';
    $('key-panel').hidden = true;
    render();
    note('Key saved for this browser session.', 'ok');
  } else {
    note((res && res.error) || 'Could not save that key.');
  }
});

$('key').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('save-key').click();
});

$('signout').addEventListener('click', async () => {
  const res = await send({ type: 'sign-out' });
  if (res && res.ok) {
    status = res.data;
    render();
    note('Signed out. Your key is gone from this browser.', 'ok');
  }
});

$('model').addEventListener('change', (e) => saveSettings({ model: e.target.value }));

$('ratio').addEventListener('input', (e) => {
  $('ratio-out').textContent = ratioLabel(Number(e.target.value));
});
$('ratio').addEventListener('change', (e) => saveSettings({ ratio: Number(e.target.value) }));

$('language').addEventListener('change', (e) => saveSettings({ language: e.target.value }));

let appKeyTimer = 0;
$('appkey').addEventListener('input', (e) => {
  clearTimeout(appKeyTimer);
  const value = e.target.value.trim();
  appKeyTimer = setTimeout(() => saveSettings({ appKey: value }), 400);
});

refresh();
setInterval(refresh, 2000);

