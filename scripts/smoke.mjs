import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://localhost:4173/';
const shots = process.argv[3] || '/tmp/claude-0/-home-user-bloomc/a2cfc189-cc00-52ee-9185-2dabd207137f/scratchpad';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`[${msg.type()}] ${msg.text().slice(0, 500)}`);
  else console.log('[console]', msg.text().slice(0, 200));
});
page.on('pageerror', (err) => errors.push('[pageerror] ' + String(err).slice(0, 800)));

await page.goto(url);
await page.waitForTimeout(3500);
await page.screenshot({ path: shots + '/1-title.png' });

// start a run (tap center of title panel)
await page.mouse.click(400, 300);
await page.waitForTimeout(1200);
await page.screenshot({ path: shots + '/2-run.png' });

// jump a few times
for (let i = 0; i < 6; i++) {
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
}
await page.screenshot({ path: shots + '/3-jumping.png' });

// hold right + jump
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(900);
await page.keyboard.up('ArrowRight');
await page.keyboard.press('Space');
await page.waitForTimeout(600);
await page.screenshot({ path: shots + '/4-move.png' });

const state = await page.evaluate(() => (window).__vortika ?? null);
console.log('state:', JSON.stringify(state));
console.log('---ERRORS---');
console.log(errors.slice(0, 20).join('\n') || '(none)');
await browser.close();
