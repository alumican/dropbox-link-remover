// Captures the README hero image: the extension running on the styled mock page.
//   node tools/screenshots.mjs        -> docs/hero.png
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, launchChrome, openPage, ROOT } from '../tests/lib.mjs';

const OUT = join(ROOT, 'docs/hero.png');
const VIEWPORT = { width: 1280, height: 720, scale: 2 };

const server = await startServer();
const chrome = await launchChrome();
try {
  const page = await openPage(chrome, `http://127.0.0.1:${server.address().port}`, 'lang=en&ui=en&rows=demo&demo=1', VIEWPORT);
  await page.evaluate('document.fonts.ready');
  await page.click('start');
  // Mid-run: a few links deleted, Dropbox's toast showing, no menu or dialog open
  await page.waitUntil(
    `document.getElementById('dlr-host').shadowRoot.getElementById('log').textContent.includes('✓ Link deleted (#4') &&
     !document.querySelector('.overlay') && document.getElementById('status').textContent !== ''`,
    30000,
    'mid-run state'
  );
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(OUT, Buffer.from(data, 'base64'));
  console.log(`wrote ${OUT}`);
} finally {
  chrome.close();
  server.close();
}
