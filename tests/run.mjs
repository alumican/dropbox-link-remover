// End-to-end tests for content.js against a mock Dropbox page, driven through headless Chrome (CDP).
// No dependencies: Node 22+ (global WebSocket / fetch) and a local Chrome.
//
//   node tests/run.mjs            run every test
//   node tests/run.mjs safety     run tests whose name contains "safety"
//
// CHROME_PATH overrides the Chrome binary; TEST_CONCURRENCY sets how many tests run at once (default 4).
import { startServer, launchChrome, openPage, sleep } from './lib.mjs';

const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || 4);

// ---------- Assertions ----------
class AssertionError extends Error {}
const check = (ok, message) => { if (!ok) throw new AssertionError(message); };
const includes = (haystack, needle) => check(haystack.includes(needle), `expected log to contain "${needle}"`);
const excludes = (haystack, needle) => check(!haystack.includes(needle), `expected log not to contain "${needle}"`);
const same = (actual, expected, what) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const countLinks = (links) => links.flat().length;
const INITIAL_BASIC = [['view', 'edit'], ['view'], []];

async function runAll(page) {
  await page.click('start');
  await page.waitForLog('■ Finished');
  return page.log();
}

// ---------- Tests ----------
// Each test opens the mock page with `query` (see tests/fixtures/mock-dropbox.js) and runs `run`
const tests = [
  {
    name: 'deletes every link and skips rows without links (Japanese UI, English log)',
    query: 'lang=ja',
    run: async (page) => {
      const log = await runAll(page);
      same(await page.links(), [[], [], []], 'remaining links');
      includes(log, 'links deleted 3 / skipped 1 rows / failed 0 times');
      includes(log, 'Ready. Press “診断” first');
      excludes(log, 'すべてのファイル'); // sidebar rows are not list rows
      excludes(log, 'ストレージを追加'); // the header menubar is not a row menu
      same(await page.text('.label'), ['削除対象', 'テスト', 'すべて実行'], 'row labels');
      same(await page.text('.count'), ['3件のリンクを削除'], 'counter');
      same(await page.errors(), [], 'page errors');
    },
  },
  {
    name: 'falls back to English for an unsupported browser language',
    query: 'lang=fr',
    run: async (page) => {
      same(await page.text('.label'), ['Targets', 'Test', 'Run all'], 'row labels');
      same(await page.text('#diag, #one, #start, #stop'), ['Diagnose', 'Run 1', 'Start', 'Stop'], 'buttons');
      includes(await page.log(), 'Ready. Press “Diagnose” first');
    },
  },
  {
    name: 'Run 1 deletes exactly one link',
    query: 'lang=ja',
    run: async (page) => {
      await page.click('one');
      await page.waitForLog('■ Finished');
      check(countLinks(await page.links()) === countLinks(INITIAL_BASIC) - 1, 'expected exactly one link to be deleted');
      includes(await page.log(), 'links deleted 1 /');
    },
  },
  {
    name: 'Diagnose finds the menu item and deletes nothing',
    query: 'lang=ja',
    run: async (page) => {
      await page.click('diag');
      await page.waitForLog('Diagnose finished');
      const log = await page.log();
      includes(log, 'Menu item for the link deletion: “閲覧リンクを削除”');
      same(await page.links(), INITIAL_BASIC, 'links');
    },
  },
  {
    name: 'waits for a row that Dropbox removes late',
    query: 'lang=ja&linger=1200',
    run: async (page) => {
      const log = await runAll(page);
      same(await page.links(), [[], [], []], 'remaining links');
      excludes(log, 'ストレージを追加');
      excludes(log, 'No link to delete: Alpha');
      excludes(log, 'No link to delete: Beta');
    },
  },
  {
    name: 'started while the page loads: waits for the list, ignores the sidebar, handles same-name rows separately',
    query: 'lang=en&rows=duplicates&loadDelay=3000',
    run: async (page) => {
      const log = await runAll(page);
      same(await page.links(), [[], [], [], [], [], []], 'remaining links');
      includes(log, 'Waiting for the link list to load');
      includes(log, 'links deleted 5 / skipped 2 rows / failed 0 times');
      excludes(log, 'すべてのファイル');
      excludes(log, 'is still shown'); // same-name rows are different rows
    },
  },
  {
    name: 'Stop finishes the deletion in flight and counts it',
    query: 'lang=ja',
    run: async (page) => {
      await page.click('start');
      await page.waitForLog('Clicked “リンクを削除”');
      await page.click('stop');
      await page.waitForLog('■ Finished');
      const log = await page.log();
      includes(log, '(“停止” button)');
      includes(log, 'failed 0 times');
      const deletedLines = (log.match(/✓ Link deleted/g) || []).length;
      check(deletedLines === countLinks(INITIAL_BASIC) - countLinks(await page.links()), 'logged deletions must match actual deletions');
      check(deletedLines < countLinks(INITIAL_BASIC), 'expected the run to stop before deleting everything');
    },
  },
  {
    name: 'user activity outside the panel stops the run; inside the panel it does not',
    query: 'lang=ja',
    run: async (page) => {
      await page.click('start');
      await page.waitForLog('✓ Link deleted');
      const log = await page.rect('log');
      await page.wheel(log.x + log.width / 2, log.y + log.height / 2);
      await sleep(500);
      check(await page.evaluate(`document.getElementById('dlr-host').shadowRoot.getElementById('panel').classList.contains('running')`), 'scrolling the panel log must not stop the run');
      await page.wheel(100, 300);
      await page.waitForLog('■ Finished');
      const text = await page.log();
      includes(text, 'User activity detected (wheel)');
      check(await page.evaluate(`!document.getElementById('dlr-host').shadowRoot.getElementById('alert').hidden`), 'expected the red notice to be shown');
      check(countLinks(await page.links()) > 0, 'expected the run to stop before deleting everything');
    },
  },
  {
    name: 'safety: a submenu with the link delete item is used',
    query: 'lang=en&scenario=submenu-ok',
    run: async (page) => {
      await runAll(page);
      same(await page.danger(), [], 'dangerous actions');
      same(await page.links(), [[], [], []], 'remaining links');
    },
  },
  {
    name: 'safety: a submenu with only "削除" / "ファイルを削除" is never clicked',
    query: 'lang=en&scenario=submenu-danger',
    run: async (page) => {
      const log = await runAll(page);
      same(await page.danger(), [], 'dangerous actions');
      same(await page.links(), INITIAL_BASIC, 'links');
      includes(log, 'Not clicked (not a link deletion): "削除", "ファイルを削除"');
      includes(log, '(repeated failures)');
    },
  },
  {
    name: 'safety: a file-deletion confirmation is never accepted',
    query: 'lang=en&scenario=file-dialog',
    run: async (page) => {
      const log = await runAll(page);
      same(await page.danger(), [], 'dangerous actions');
      same(await page.links(), INITIAL_BASIC, 'links');
      includes(log, 'このファイルを削除しますか');
      includes(log, '(repeated failures)');
    },
  },
  {
    name: 'a confirmation without a delete button fails and logs the dialog',
    query: 'lang=en&scenario=no-confirm',
    run: async (page) => {
      const log = await runAll(page);
      same(await page.links(), INITIAL_BASIC, 'links');
      includes(log, 'Delete button in the confirmation dialog not found');
      includes(log, 'buttons: "キャンセル", "OK"');
    },
  },
  {
    name: 'an extension reload mid-run stops the run and removes the panel',
    query: 'lang=ja',
    run: async (page) => {
      await page.click('start');
      await page.waitForLog('✓ Link deleted');
      await page.evaluate('invalidateExtension()');
      await page.waitUntil(`!document.getElementById('dlr-host')`, 3000, 'panel removed');
      await sleep(1000); // a deletion whose confirm button was already pressed may still land
      const before = countLinks(await page.links());
      await sleep(2500);
      check(countLinks(await page.links()) === before, 'no new deletion may start after the reload');
      check(before > 0, 'expected the run to stop before deleting everything');
      check(await page.evaluate(`!document.getElementById('dlr-fonts')`), 'expected the fonts link to be removed');
      same(await page.errors(), [], 'page errors');
    },
  },
  {
    name: 'the copy icon copies the log',
    query: 'lang=en',
    run: async (page) => {
      await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
      await page.click('copy');
      await page.waitForLog('Log copied.');
      const copied = await page.evaluate('navigator.clipboard.readText()', { userGesture: true });
      includes(copied, 'Ready. Press');
      check(await page.evaluate(`document.getElementById('dlr-host').shadowRoot.getElementById('copy').innerHTML.includes('M20 6 9 17l-5-5')`), 'expected the check icon after copying');
    },
  },
  {
    name: 'English Dropbox UI: deletes every link',
    query: 'lang=en&ui=en',
    run: async (page) => {
      const log = await runAll(page);
      same(await page.links(), [[], [], []], 'remaining links');
      includes(log, 'Selected “Delete view link”');
      includes(log, 'Selected “Delete edit link”');
      includes(log, 'Clicked “Delete link” in the confirmation dialog');
      includes(log, 'links deleted 3 / skipped 1 rows / failed 0 times');
      excludes(log, 'Upgrade');
    },
  },
  {
    name: 'English Dropbox UI safety: a submenu with only "Delete" / "Delete file" is never clicked',
    query: 'lang=en&ui=en&scenario=submenu-danger',
    run: async (page) => {
      const log = await runAll(page);
      same(await page.danger(), [], 'dangerous actions');
      same(await page.links(), INITIAL_BASIC, 'links');
      includes(log, 'Not clicked (not a link deletion): "Delete", "Delete file"');
    },
  },
  {
    name: 'English Dropbox UI safety: a file-deletion confirmation is never accepted',
    query: 'lang=en&ui=en&scenario=file-dialog',
    run: async (page) => {
      await runAll(page);
      same(await page.danger(), [], 'dangerous actions');
      same(await page.links(), INITIAL_BASIC, 'links');
    },
  },
];

// ---------- Runner ----------
const filter = process.argv[2]?.toLowerCase();
const selected = tests.filter((t) => !filter || t.name.toLowerCase().includes(filter));
const server = await startServer();
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome();
const results = [];

async function runTest({ name, query, run }) {
  const t0 = Date.now();
  let page;
  try {
    page = await openPage(chrome, origin, query);
    await run(page);
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    const log = page ? await page.log().catch(() => '') : '';
    results.push({ name, ok: false, ms: Date.now() - t0 });
    console.log(`✗ ${name}\n    ${e.message}${log ? `\n    --- panel log ---\n${log.replace(/^/gm, '    ')}` : ''}`);
  } finally {
    await page?.close().catch(() => {});
  }
}

const queue = [...selected];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) await runTest(queue.shift());
}));

chrome.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
