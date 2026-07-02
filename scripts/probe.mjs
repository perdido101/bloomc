import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://localhost:4173/';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)));
await page.goto(url);
await page.waitForTimeout(3000);
await page.mouse.click(400, 300);

let prev = '';
const t0 = Date.now();
const poll = setInterval(async () => {
  try {
    const s = await page.evaluate(() => JSON.stringify(window.__vortika));
    const o = JSON.parse(s);
    const line = `${((Date.now() - t0) / 1000).toFixed(1)}s state=${o.state} score=${o.score} ring=${o.ringK} onRing=${o.onRing} alive=${o.alive} runTime=${o.runTime?.toFixed(1)}`;
    if (line.split(' score')[0] !== prev.split(' score')[0] || Math.random() < 0.15) console.log(line);
    prev = line;
  } catch {}
}, 300);

// jump periodically like a simple player
for (let i = 0; i < 25; i++) {
  await page.keyboard.press('Space');
  await page.waitForTimeout(650);
}
clearInterval(poll);
await page.screenshot({ path: process.env.SHOT || '/tmp/claude-0/-home-user-bloomc/a2cfc189-cc00-52ee-9185-2dabd207137f/scratchpad/probe.png' });
await browser.close();
