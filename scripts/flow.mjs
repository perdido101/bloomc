import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://localhost:4173/';
const shots = '/tmp/claude-0/-home-user-bloomc/a2cfc189-cc00-52ee-9185-2dabd207137f/scratchpad';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 480 } });
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)));
await page.goto(url);
await page.waitForTimeout(2500);

const state = () => page.evaluate(() => JSON.stringify(window.__vortika, (k, v) => typeof v === 'function' ? undefined : v));

await page.click('#splash');
await page.waitForTimeout(300);
await page.click('#btnPlay');
await page.waitForTimeout(800);
console.log('after start:', await state());

// warp to bloom
await page.evaluate(() => window.__vortika.warpToBloom());
await page.waitForTimeout(700);
console.log('bloom start:', await state());
await page.screenshot({ path: shots + '/f1-bloom-mid.png' });
await page.waitForTimeout(9000);
console.log('bloom end:', await state());
await page.screenshot({ path: shots + '/f2-bloom-after.png' });

// second bloom (into INFERNA)
await page.evaluate(() => window.__vortika.warpToBloom());
await page.waitForTimeout(6000);
await page.evaluate(() => window.__vortika.warpToBloom());
await page.waitForTimeout(6000);
console.log('after 3 blooms:', await state());
await page.screenshot({ path: shots + '/f3-inferna.png' });

// death
await page.evaluate(() => window.__vortika.kill());
await page.waitForTimeout(1500);
await page.screenshot({ path: shots + '/f4-death.png' });
await page.waitForTimeout(4000);
console.log('after death:', await state());
await page.screenshot({ path: shots + '/f5-gameover.png' });

// restart from game over
await page.mouse.click(240, 240);
await page.waitForTimeout(1000);
console.log('after restart:', await state());

// pause
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.screenshot({ path: shots + '/f6-pause.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
console.log('after pause toggle:', await state());

// localStorage highscores
console.log('scores:', await page.evaluate(() => localStorage.getItem('vortika_scores_v1')));
await browser.close();
