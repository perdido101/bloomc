import { chromium } from 'playwright-core';
const url = process.argv[2] || 'http://localhost:4173/';
const shots = '/tmp/claude-0/-home-user-bloomc/a2cfc189-cc00-52ee-9185-2dabd207137f/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
await page.addInitScript(() => localStorage.setItem('bloom_settings_v1', JSON.stringify({ ink: true, sound: true, music: true, reduceFlash: false })));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url);
await page.waitForTimeout(4000);
await page.screenshot({ path: shots + '/ink-splash.png' });
await page.click('#splash');
await page.waitForTimeout(300);
await page.click('#btnPlay');
await page.waitForTimeout(3000);
for (let i = 0; i < 4; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(700); }
await page.screenshot({ path: shots + '/ink-run.png' });
await browser.close();
