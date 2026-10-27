// Captures the README hero image: the extension's panel mid-run, with its shadow, on a transparent background.
//   node tools/screenshots.mjs        -> docs/hero.png
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, launchChrome, openPage, ROOT } from '../tests/lib.mjs';

const OUT = join(ROOT, 'docs/hero.png');
const VIEWPORT = { width: 1400, height: 820, scale: 2 };
const PANEL_INSET = 80; // keeps the panel away from the viewport edge so its shadow is not cut off
const SHADOW_MARGIN = { x: 48, top: 32, bottom: 64 }; // room for --shadow-panel (0 16px 40px)

const server = await startServer();
const chrome = await launchChrome();
try {
  const page = await openPage(chrome, `http://127.0.0.1:${server.address().port}`, 'ui=en&rows=demo&demo=hero', VIEWPORT);
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  // Page styles beat :host rules, so this overrides the panel's inset token
  await page.evaluate(`document.getElementById('dlr-host').style.setProperty('--panel-inset', '${PANEL_INSET}px')`);
  await page.evaluate('document.fonts.ready');
  await page.click('start');
  // Mid-run: a few links deleted, no menu or dialog open
  await page.waitUntil(
    `document.getElementById('dlr-host').shadowRoot.getElementById('log').textContent.includes('✓ Link deleted (#4') &&
     !document.querySelector('.overlay')`,
    30000,
    'mid-run state'
  );
  const r = await page.rect('panel');
  const clip = {
    x: r.x - SHADOW_MARGIN.x,
    y: r.y - SHADOW_MARGIN.top,
    width: r.width + 2 * SHADOW_MARGIN.x,
    height: r.height + SHADOW_MARGIN.top + SHADOW_MARGIN.bottom,
    scale: 1,
  };
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip });
  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(OUT, Buffer.from(data, 'base64'));
  console.log(`wrote ${OUT}`);
} finally {
  chrome.close();
  server.close();
}
