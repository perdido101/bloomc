import { chromium } from 'playwright-core';
const url = process.argv[2] || 'http://localhost:4173/';
const shots = '/tmp/claude-0/-home-user-bloomc/a2cfc189-cc00-52ee-9185-2dabd207137f/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 420, height: 780 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url);
await page.waitForTimeout(2600); // boot + early unfurl
await page.screenshot({ path: shots + '/m1-unfurl.png' });
await page.waitForTimeout(9000); // formed + breathing
await page.screenshot({ path: shots + '/m2-menu.png' });
await page.click('#btnHow');
await page.waitForTimeout(400);
await page.screenshot({ path: shots + '/m3-howto.png' });
await page.click('#btnHowBack');
await page.click('#btnBoard');
await page.waitForTimeout(400);
await page.screenshot({ path: shots + '/m4-board.png' });
await page.click('#btnBoardBack');
await page.click('#btnSettings');
await page.waitForTimeout(400);
await page.screenshot({ path: shots + '/m5-settings.png' });
await page.click('#btnSettingsBack');
await page.click('#btnPlay');
await page.waitForTimeout(1500);
const st = await page.evaluate(() => JSON.stringify({ state: window.__vortika.state, score: window.__vortika.score }));
console.log('after play:', st);
await page.screenshot({ path: shots + '/m6-run.png' });
await browser.close();
