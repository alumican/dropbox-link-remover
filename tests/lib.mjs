// Shared helpers for the tests and the screenshot script: a static server for the mock page and
// headless Chrome driven over the DevTools protocol. No dependencies (Node 22+).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
export const RUN_TIMEOUT_MS = 60000;
const EVALUATE_TIMEOUT_MS = 10000; // a blocked page (e.g. a native dialog) fails the test instead of hanging
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Static server ----------
// content.js only activates under /share/links, so the mock page is served there.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
export function startServer() {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const file = pathname === '/share/links/mock' ? join(ROOT, 'tests/fixtures/mock-dropbox.html') : resolve(ROOT, `.${pathname}`);
    if (!file.startsWith(ROOT + sep) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---------- Chrome over CDP ----------
export async function launchChrome() {
  const binary = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!binary) throw new Error('Chrome not found; set CHROME_PATH');
  const profile = mkdtempSync(join(tmpdir(), 'dlr-test-'));
  const proc = spawn(binary, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const close = () => {
    ws.close();
    proc.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
  };
  return { send, close };
}

// A page with helpers for the panel inside the content script's shadow root
export async function openPage(chrome, origin, query, { width = 1200, height = 800, scale = 1, colorScheme = 'light' } = {}) {
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => chrome.send(method, params, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.enable');
  // Record page errors and auto-accept the "delete everything?" confirm()
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errors = [];
      addEventListener('error', (e) => __errors.push(e.message));
      addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason)));
      window.confirm = () => true;`,
  });
  await send('Page.navigate', { url: `${origin}/share/links/mock?${query}` });

  const evaluate = async (expression, { userGesture = false } = {}) => {
    const { result, exceptionDetails } = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }),
      sleep(EVALUATE_TIMEOUT_MS).then(() => { throw new Error(`page did not respond to: ${expression.slice(0, 80)}`); }),
    ]);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const shadow = `document.getElementById('dlr-host')?.shadowRoot`;
  const page = {
    send,
    evaluate,
    async waitUntil(expression, timeout = RUN_TIMEOUT_MS, what = expression) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (await evaluate(expression).catch(() => false)) return;
        await sleep(100);
      }
      throw new Error(`timed out waiting for: ${what}`);
    },
    log: () => evaluate(`[...(${shadow}?.getElementById('log')?.childNodes || [])].map((n) => n.textContent).join('\\n')`),
    async waitForLog(text, timeout) {
      await page.waitUntil(`(${shadow}?.getElementById('log')?.textContent || '').includes(${JSON.stringify(text)})`, timeout, `log "${text}"`);
    },
    click: (id) => evaluate(`${shadow}.getElementById(${JSON.stringify(id)}).click()`, { userGesture: true }),
    text: (selector) => evaluate(`[...${shadow}.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim())`),
    rect: (id) => evaluate(`JSON.parse(JSON.stringify(${shadow}.getElementById(${JSON.stringify(id)}).getBoundingClientRect()))`),
    // A real (trusted) wheel event, like a user scrolling
    wheel: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 120 }),
    links: () => evaluate('mock.links()'),
    danger: () => evaluate('mock.danger'),
    errors: () => evaluate('window.__errors'),
    close: () => chrome.send('Target.closeTarget', { targetId }),
  };
  await page.waitUntil(`!!${shadow}?.getElementById('start')`, 10000, 'panel');
  return page;
}
