import { chromium } from 'playwright-core';

const url = process.argv[2] || 'https://perdido101.github.io/bloomc/';
const shots = '/tmp/claude-0/-home-user-bloomc/a2cfc189-cc00-52ee-9185-2dabd207137f/scratchpad';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, ignoreHTTPSErrors: true });
page.on('console', (msg) => console.log(`[${msg.type()}]`, msg.text().slice(0, 300)));
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 600)));
page.on('requestfailed', (req) => console.log('[reqfail]', req.url().slice(0, 120), req.failure()?.errorText));
await page.goto(url, { waitUntil: 'load', timeout: 45000 });
await page.waitForTimeout(12000);
await page.screenshot({ path: shots + '/live.png' });
const state = await page.evaluate(() => JSON.stringify(window.__vortika ?? null));
console.log('state:', state && state.slice(0, 200));
await browser.close();
