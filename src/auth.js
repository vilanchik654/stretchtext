'use strict';

/* Pollinations device flow: request a code, send the reader to approve it,
 * then poll until the browser receives its own scoped key. No backend, no
 * client secret, and the key never leaves extension storage. */

const DEVICE_CODE_URL = 'https://enter.pollinations.ai/api/device/code';
const DEVICE_TOKEN_URL = 'https://enter.pollinations.ai/api/device/token';

const $ = (id) => document.getElementById(id);

let stopped = false;
let timer = 0;
let verificationUrl = '';
let device = null;

function setStatus(text, kind) {
  const status = $('status');
  const icon = status.querySelector('.spinner');
  const label = $('status-text');
  label.textContent = text;
  label.className = kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '';
  if (kind === 'err' || kind === 'ok') {
    if (icon) icon.remove();
  }
}

async function appKey() {
  try {
    const { appKey } = await chrome.storage.sync.get({ appKey: '' });
    return (appKey || '').trim();
  } catch {
    return '';
  }
}

async function requestCode() {
  const clientId = await appKey();
  const body = clientId ? { client_id: clientId } : {};
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Could not start the sign-in (' + res.status + '). ' + text.slice(0, 160));
  }
  return res.json();
}

async function poll(d) {
  if (stopped) return;
  const interval = Math.max(3, Number(d.interval) || 5) * 1000;
  let res;
  try {
    res = await fetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: d.device_code }),
    });
  } catch (err) {
    setStatus('Network hiccup — retrying…', '');
    timer = setTimeout(() => poll(d), Math.max(interval, 5000));
    return;
  }

  if (res.ok) {
    const token = await res.json().catch(() => null);
    if (token && token.access_token) {
      await save(token);
      return;
    }
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const code = payload && (payload.error || payload.code);
  const detail = (payload && (payload.error_description || payload.message)) || '';

  if (code === 'authorization_pending' || code === 'slow_down' || res.status === 428) {
    timer = setTimeout(() => poll(d), code === 'slow_down' ? interval + 3000 : interval);
    return;
  }
  if (code === 'access_denied') {
    setStatus('Access was denied on Pollinations. You can try again.', 'err');
    $('approve').textContent = 'Try again';
    return;
  }
  if (code === 'expired_token') {
    setStatus('The code expired. Start again.', 'err');
    $('approve').textContent = 'Get a new code';
    return;
  }
  setStatus('Sign-in failed' + (detail ? ': ' + detail : '.') + ' You can try again.', 'err');
  $('approve').textContent = 'Try again';
}

async function save(token) {
  const expiresIn = Number(token.expires_in) || 7 * 24 * 3600;
  await chrome.storage.session.set({
    auth: {
      token: token.access_token,
      mode: 'device',
      scope: token.scope || '',
      expiresAt: Date.now() + expiresIn * 1000,
      savedAt: Date.now(),
    },
  });
  $('panel-connect').hidden = true;
  $('panel-done').hidden = false;
  $('done-text').textContent =
    'StretchText will now spend your own Pollen. The key expires in ' +
    Math.round(expiresIn / 86400) +
    ' days and you can revoke it any time. You can close this tab.';
  setTimeout(() => {
    chrome.tabs.getCurrent((tab) => {
      if (tab && tab.id) chrome.tabs.remove(tab.id).catch(() => {});
    });
  }, 2600);
}

async function openApproval() {
  if (verificationUrl) {
    chrome.tabs.create({ url: verificationUrl, active: true });
    return;
  }
  await start();
}

async function start() {
  stopped = false;
  clearTimeout(timer);
  $('approve').disabled = true;
  setStatus('Requesting a code…');
  try {
    const d = await requestCode();
    if (!d || !d.device_code || !d.user_code) throw new Error('The device endpoint returned an unexpected answer.');
    device = d;
    $('code').textContent = d.user_code;
    verificationUrl = d.verification_uri_complete || d.verification_uri;
    setStatus('Waiting for approval on Pollinations…');
    $('approve').disabled = false;
    $('approve').textContent = 'Open Pollinations';
    chrome.tabs.create({ url: verificationUrl, active: true });
    timer = setTimeout(() => poll(d), (Number(d.interval) || 5) * 1000);
  } catch (err) {
    setStatus(err.message || String(err), 'err');
    $('approve').disabled = false;
    $('approve').textContent = 'Try again';
  }
}

$('approve').addEventListener('click', () => {
  if (verificationUrl && device) chrome.tabs.create({ url: verificationUrl, active: true });
  else start();
});

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('code').textContent.trim());
    $('copy').textContent = 'Copied';
    setTimeout(() => ($('copy').textContent = 'Copy code'), 1600);
  } catch {
    $('copy').textContent = 'Select and copy manually';
  }
});

window.addEventListener('beforeunload', () => {
  stopped = true;
  clearTimeout(timer);
});

start();
