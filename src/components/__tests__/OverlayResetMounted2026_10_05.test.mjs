import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';


const root = fileURLToPath(new URL('../../../', import.meta.url));
// Use Playwright's browser when installed; local Chrome is a fallback for
// development installs that omit the optional Playwright browser download.
const browserPath = [chromium.executablePath(), ...(process.platform === 'win32'
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium'])].find(existsSync);

const server = await createServer({
  root,
  configFile: false,
  plugins: [{
    name: 'reset-test-page',
    configureServer(vite) {
      vite.middlewares.use('/__overlay_reset_test.html', async (_req, res, next) => {
        try {
          const html = await vite.transformIndexHtml('/__overlay_reset_test.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/components/__tests__/overlayResetHarness.tsx"></script></body></html>');
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        } catch (error) { next(error); }
      });
    },
  }],
  optimizeDeps: { entries: ['src/components/__tests__/overlayResetHarness.tsx'] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**/natively-browser/**'] } },
});
await server.listen();
const port = server.httpServer.address().port;
const browser = browserPath ? await chromium.launch({ headless: true, executablePath: browserPath }) : null;

async function mounted(platform) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/__overlay_reset_test.html?platform=${platform}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await page.waitForFunction(() => window.__resetHarness?.mounted || window.__resetHarness?.error, null, { timeout: 90000 });
  } catch (error) {
    throw new Error(`Mounted renderer did not load: ${errors.join(' | ')}; ${await page.locator('body').innerText()}`, { cause: error });
  }
  assert.equal(await page.evaluate(() => window.__resetHarness.error), undefined, errors.join('\n'));
  try { await page.getByTestId('overlay-chat-input').waitFor({ timeout: 4000 }); }
  catch (error) { throw new Error(`No overlay chat input: ${errors.join(' | ')}; ${await page.locator('body').innerText()}`, { cause: error }); }
  return page;
}

for (const platform of ['win32', 'darwin']) {
  test(`mounted overlay ${platform}: shortcut clears visible chat and next prompt context`, { skip: !browser && 'No Chromium/Chrome binary installed' }, async () => {
    const page = await mounted(platform);
    try {
      const input = page.getByTestId('overlay-chat-input');
      await input.fill('Earlier private question');
      await input.press('Enter');
      await page.waitForFunction(() => window.__resetHarness.calls.questions.length === 1);
      assert.match(await page.locator('body').innerText(), /Earlier private question/);
      const before = await page.evaluate(() => window.__resetHarness.calls);
      assert.equal(before.resets, 0);

      await input.press(platform === 'darwin' ? 'Meta+r' : 'Control+r');
      await page.waitForFunction(() => window.__resetHarness.calls.resets === 1);
      assert.ok(await page.evaluate(() => window.__resetHarness.calls.cancels >= 1), 'reset cancels the pending stream too');
      assert.doesNotMatch(await page.locator('body').innerText(), /Earlier private question/);
      await input.fill('Fresh question');
      await input.press('Enter');
      await page.waitForFunction(() => window.__resetHarness.calls.questions.length === 2);
      assert.doesNotMatch((await page.evaluate(() => window.__resetHarness.calls.questions[1].context)), /Earlier private question/);
      const resetFlag = platform === 'darwin' ? 1 << 20 : 1 << 18;
      await page.evaluate(flag => window.__resetHarness.emit('onStealthKeyCaptured', { keyCode: 15, chars: '', flags: flag, isKeyDown: true }), resetFlag);
      assert.equal(await page.evaluate(() => window.__resetHarness.calls.resets), 1, 'disengaged tap cannot reset');
      await page.evaluate(() => window.__resetHarness.emit('onStealthTapState', { active: true }));
      await page.evaluate(flag => window.__resetHarness.emit('onStealthKeyCaptured', { keyCode: 15, chars: '', flags: flag | (1 << 17), isKeyDown: true }), resetFlag);
      await page.evaluate(flag => window.__resetHarness.emit('onStealthKeyCaptured', { keyCode: 15, chars: '', flags: flag, isKeyDown: false }), resetFlag);
      assert.equal(await page.evaluate(() => window.__resetHarness.calls.resets), 1, 'shifted or key-up is not reset');
      await page.evaluate(flag => window.__resetHarness.emit('onStealthKeyCaptured', { keyCode: 15, chars: '', flags: flag, isKeyDown: true }), resetFlag);
      await page.waitForFunction(() => window.__resetHarness.calls.resets === 2);
      assert.doesNotMatch(await page.locator('body').innerText(), /Fresh question/);
      await page.evaluate(() => window.__resetHarness.emit('onStealthKeyCaptured', { keyCode: 0, chars: 'Another fresh question', flags: 0, isKeyDown: true }));
      await page.waitForFunction(() => document.querySelector('[data-testid="overlay-chat-input"]')?.value === 'Another fresh question');
      await page.evaluate(() => window.__resetHarness.emit('onStealthKeyCaptured', { keyCode: 36, chars: '', flags: 0, isKeyDown: true }));
      await page.waitForFunction(() => window.__resetHarness.calls.questions.length === 3);
      assert.doesNotMatch((await page.evaluate(() => window.__resetHarness.calls.questions[2].context)), /Fresh question|Earlier private question/);
      await page.evaluate(() => window.__resetHarness.emit('onStealthTapState', { active: false }));
      await page.evaluate(flag => window.__resetHarness.emit('onStealthKeyCaptured', { keyCode: 15, chars: '', flags: flag, isKeyDown: true }), resetFlag);
      assert.equal(await page.evaluate(() => window.__resetHarness.calls.resets), 2, 'stopped tap must not reset');

      await page.evaluate(() => window.__resetHarness.emit('onKeybindsUpdate', [
        { id: 'general:reset-cancel', accelerator: 'CommandOrControl+K' },
      ]));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => !document.querySelector('[data-testid="overlay-chat-input"]')?.readOnly);
      await input.fill('Rebound private question');
      await input.press('Enter');
      await page.waitForFunction(() => window.__resetHarness.calls.questions.length === 4);
      await input.press(platform === 'darwin' ? 'Meta+r' : 'Control+r');
      assert.equal(await page.evaluate(() => window.__resetHarness.calls.resets), 2, 'focused old R no longer resets after a rebind');
      assert.match(await page.locator('body').innerText(), /Rebound private question/);
      await input.press(platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.waitForFunction(() => window.__resetHarness.calls.resets === 3);
      assert.doesNotMatch(await page.locator('body').innerText(), /Rebound private question/);
      await input.fill('Question after rebind');
      await input.press('Enter');
      await page.waitForFunction(() => window.__resetHarness.calls.questions.length === 5);
      assert.doesNotMatch((await page.evaluate(() => window.__resetHarness.calls.questions[4].context)), /Rebound private question/);
    } finally { await page.close(); }
  });
}

test.after(async () => { await browser?.close(); await server.close(); });
