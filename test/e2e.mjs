/**
 * End-to-end test: real Chrome, real extension, real protocol.
 *
 *   node test/e2e.mjs            # headless
 *   HEADFUL=1 node test/e2e.mjs  # watch it happen
 *
 * Pollinations itself is replaced by test/mock-api.mjs so the suite needs no
 * account, no Pollen and no network. Everything else is production code: the
 * service worker, the content script, the popup, the streaming parser and the
 * DOM surgery on a real article page.
 *
 * Chrome for Testing is required, because branded Chrome builds ignore
 * --load-extension. tools/get-chrome.mjs fetches it; CHROME_PATH overrides.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockApi } from './mock-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const artifacts = path.join(here, '.artifacts');
const profile = path.join(artifacts, 'profile');
const extDir = path.join(artifacts, 'extension');
const CHROME = process.env.CHROME_PATH || defaultChrome();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function defaultChrome() {
  const candidates = [
    path.join(here, '.artifacts', 'chrome', 'chrome-win64', 'chrome.exe'),
    process.env['PROGRAMFILES'] + '\\Google\\Chrome for Testing\\Application\\chrome.exe',
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error('Chrome for Testing not found — run node tools/get-chrome.mjs or set CHROME_PATH');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, timeout = 45000, interval = 200) {
  const started = Date.now();
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() - started > timeout) {
      throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
    }
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function serveFixture() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = url.pathname === '/' ? 'test/fixture/article.html' : url.pathname.replace(/^\//, '');
    const full = path.join(root, decodeURIComponent(file));
    if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Copy the extension and let it talk to the mock on loopback. */
function prepareExtension() {
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.mkdirSync(extDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(extDir, 'manifest.json'));
  fs.cpSync(path.join(root, 'src'), path.join(extDir, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'icons'), path.join(extDir, 'icons'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*'];
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

/* ------------------------------------------------------------------ *
 * Minimal CDP client
 * ------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new CDP(ws)));
    ws.addEventListener('error', () => reject(new Error('Could not connect to ' + url)));
  });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✔ ' + name);
  } else {
    failures++;
    console.log('  ✖ ' + name + (detail ? ' — ' + detail : ''));
  }
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  fs.rmSync(profile, { recursive: true, force: true });

  const mock = await startMockApi();
  const server = await serveFixture();
  const pageUrl = 'http://127.0.0.1:' + server.address().port + '/';
  prepareExtension();

  console.log('• page   ' + pageUrl);
  console.log('• mock   ' + mock.url);

  const args = [
    ...(process.env.HEADFUL ? [] : ['--headless=new']),
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--user-data-dir=' + profile,
    '--load-extension=' + extDir,
    '--disable-extensions-except=' + extDir,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--window-size=1600,900',
    '--hide-scrollbars',
    pageUrl,
  ];

  const chrome = spawn(CHROME, args, { stdio: 'ignore', windowsHide: true });
  const cleanup = () => {
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
    server.close();
    mock.close();
  };
  process.on('exit', cleanup);

  const devtoolsFile = path.join(profile, 'DevToolsActivePort');
  await waitFor(
    'Chrome DevTools port',
    () => fs.existsSync(devtoolsFile) && fs.readFileSync(devtoolsFile, 'utf8').split('\n')[0].trim(),
    25000
  );
  const devtoolsPort = fs.readFileSync(devtoolsFile, 'utf8').split('\n')[0].trim();
  const listTargets = async () => (await fetch('http://127.0.0.1:' + devtoolsPort + '/json/list')).json();

  const target = await waitFor(
    'page target',
    async () => (await listTargets()).find((t) => t.type === 'page' && t.url.startsWith(pageUrl)),
    25000
  );
  const cdp = await connect(target.webSocketDebuggerUrl);
  const exceptions = [];
  cdp.on('Runtime.exceptionThrown', (p) => exceptions.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error('page threw: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  };

  const worker = await waitFor(
    'extension service worker',
    async () => (await listTargets()).find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js')),
    25000
  );
  const extId = String(worker.url).split('/')[2];
  check('the extension loads', Boolean(extId), 'id=' + extId);
  console.log('• ext    ' + extId);

  await waitFor('document ready', () => evaluate('document.readyState === "complete"'), 20000);
  await waitFor('content script', () => evaluate('Boolean(document.documentElement.dataset.stretchtext)'), 20000);

  console.log('\n• connecting a reader key (no UI needed for the rest)');
  await cdp.send('Page.navigate', { url: 'chrome-extension://' + extId + '/src/popup.html' });
  await waitFor('popup ready', () => evaluate("Boolean(document.getElementById('mode'))"), 15000);
  const guestMode = await waitFor(
    'popup status',
    () => evaluate("document.getElementById('mode').textContent !== 'Checking…' ? document.getElementById('mode').textContent : null"),
    10000
  );
  check('popup asks for a connection before any key is set', /Not connected/.test(guestMode), JSON.stringify(guestMode));
  const seeded = await evaluate(`(async () => {
    await chrome.storage.sync.set({ apiBase: ${JSON.stringify(mock.url)}, model: 'openai/gpt-5.4-nano', ratio: 16, language: 'auto' });
    await chrome.storage.session.set({ auth: { token: 'sk_test_reader_key', mode: 'key', expiresAt: Date.now() + 3600000 } });
    return true;
  })()`);
  check('storage seeded', seeded === true);

  await cdp.send('Page.navigate', { url: pageUrl });
  await waitFor('content script again', () => evaluate('Boolean(document.documentElement.dataset.stretchtext)'), 20000);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const original = await evaluate("document.querySelector('#article p:nth-of-type(2)').textContent.trim()");

  console.log('\n• selecting a paragraph and pressing Stretch');
  await evaluate(`(() => {
    const p = document.querySelector('#article p:nth-of-type(2)');
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
    return true;
  })()`);

  await waitFor(
    'stretch bubble',
    () =>
      evaluate(
        "Boolean(document.getElementById('stretchtext-host')?.shadowRoot?.querySelector('button[data-testid=stretch]'))"
      ),
    5000
  );
  await evaluate(`(() => {
    document.getElementById('stretchtext-host').shadowRoot.querySelector('button[data-testid=stretch]').click();
    return true;
  })()`);

  const created = await waitFor('kernel', () => evaluate("document.querySelectorAll('.st-root').length"), 20000, 150);
  check('a kernel replaced the paragraph', created === 1, 'roots=' + created);
  await waitFor('kernel to finish streaming', () => evaluate("document.querySelector('.st-root')?.dataset.stState === 'done'"), 20000, 100);

  const rootText = `(() => {
    const root = document.querySelector('.st-root');
    if (!root) return '';
    const copy = root.cloneNode(true);
    copy.querySelectorAll('button').forEach((b) => b.remove());
    return copy.textContent.replace(/\\s+/g, ' ').trim();
  })()`;
  const kernel = await evaluate(rootText);
  const kernelWords = kernel.split(/\s+/).filter(Boolean).length;
  const originalWords = original.split(/\s+/).filter(Boolean).length;
  console.log('  ' + originalWords + ' words → ' + kernelWords + ' words');
  check('the kernel is much shorter', kernelWords > 0 && kernelWords < originalWords * 0.65, kernelWords + '/' + originalWords);
  check('markers never leak into the page', !kernel.includes('{{') && !kernel.includes('|1}}'), JSON.stringify(kernel));

  const phrases = await evaluate("document.querySelectorAll('.st-phrase').length");
  check('the kernel offers stretchable phrases', phrases >= 1, 'phrases=' + phrases);

  console.log('\n• growing a phrase');
  await evaluate("document.querySelector('.st-phrase').click(); true");
  const detailDiag = async () => {
    const state = await evaluate(`(() => {
      const host = document.getElementById('stretchtext-host');
      return {
        toast: host?.shadowRoot?.querySelector('.toast')?.textContent || '',
        details: document.querySelectorAll('.st-detail').length,
        phrases: document.querySelectorAll('.st-phrase').length,
        open: document.querySelectorAll('.st-phrase-open').length,
      };
    })()`);
    console.log('  diag: ' + JSON.stringify(state) + ' requests=' + mock.requests.length);
  };
  const detail = await waitFor(
    'detail text',
    () =>
      evaluate(`(() => {
        const el = document.querySelector('.st-detail[data-st-state="done"] .st-detail-text');
        return el ? el.textContent.trim() : '';
      })()`),
    20000,
    150
  ).catch(async (err) => {
    await detailDiag();
    throw err;
  });
  check('the phrase grew in place', detail.length > 3, JSON.stringify(detail));
  check('the detail reads as an insertion', /^[\s,;:—–-]/.test(detail), JSON.stringify(detail));

  const expandedText = await evaluate("document.querySelector('.st-root').textContent.replace(/\\s+/g, ' ').trim()");
  check('the expanded paragraph contains the detail', expandedText.includes(detail.trim()), JSON.stringify(expandedText.slice(0, 160)));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(artifacts, 'stretched.png'), Buffer.from(shot.data, 'base64'));

  console.log('\n• shrinking and restoring');
  await evaluate("document.querySelector('.st-shrink').click(); true");
  check('the phrase shrank back', (await evaluate("document.querySelectorAll('.st-detail').length")) === 0);

  await evaluate("document.querySelector('.st-restore').click(); true");
  check('the root is gone', (await evaluate("document.querySelectorAll('.st-root').length")) === 0);
  const restored = await evaluate("document.querySelector('#article p:nth-of-type(2)').textContent.trim()");
  check('the original text is back, unchanged', restored === original);

  console.log('\n• what the mock received');
  check('two requests, both authenticated', mock.requests.length === 2 && mock.requests.every((r) => /^Bearer sk_/.test(r.auth)), JSON.stringify(mock.requests.map((r) => [r.stream, r.auth])));
  check('the kernel request streamed', mock.requests[0] && mock.requests[0].stream === true);
  check('the kernel prompt carried the passage', /stretchtext writer/i.test(mock.requests[0]?.system || '') && /The idea failed/.test(mock.requests[0]?.user || ''));
  check('the detail prompt carried the clicked phrase', /expand one phrase/i.test(mock.requests[1]?.system || '') && /"stretchtext"/.test(mock.requests[1]?.user || ''));

  console.log('\n• popup reflects the connection');
  await cdp.send('Page.navigate', { url: 'chrome-extension://' + extId + '/src/popup.html' });
  const popupState = await waitFor(
    'popup text',
    () =>
      evaluate(`(() => {
        const mode = document.getElementById('mode');
        if (!mode || !mode.textContent || mode.textContent === 'Checking…') return null;
        return {
          mode: mode.textContent,
          pollen: document.getElementById('pollen-text').textContent,
          model: document.getElementById('model').value,
          version: document.getElementById('version').textContent,
        };
      })()`),
    15000
  );
  check('popup shows the connected state', /signed in/i.test(popupState.mode), JSON.stringify(popupState));
  check('popup shows the model and version', Boolean(popupState.model) && /v\d/.test(popupState.version), JSON.stringify(popupState));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 620, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  const popupShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(artifacts, 'popup.png'), Buffer.from(popupShot.data, 'base64'));

  check('no uncaught page exceptions', exceptions.length === 0, exceptions.join(' | '));
  cdp.close();

  console.log('\n• screenshot: ' + path.relative(root, path.join(artifacts, 'stretched.png')));
  cleanup();
  console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nE2E failed: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});



