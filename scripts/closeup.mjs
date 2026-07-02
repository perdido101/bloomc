import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://localhost:4173/';
const shots = '/tmp/claude-0/-home-user-bloomc/a2cfc189-cc00-52ee-9185-2dabd207137f/scratchpad';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)));
await page.goto(url);
await page.waitForTimeout(2500);
await page.click('#splash');
await page.waitForTimeout(300);
await page.click('#btnPlay');
await page.waitForTimeout(600);

const dbg = () => page.evaluate(() => {
  const d = window.__vortika;
  return { px: d.px, py: d.py, state: d.poseState, onRing: d.onRing, grabbing: d.grabbing, ring: d.ringK, score: d.score };
});

async function snap(name) {
  const d = await dbg();
  const x = Math.max(0, Math.min(700 - 220, d.px - 110));
  const y = Math.max(0, Math.min(700 - 220, d.py - 110));
  await page.screenshot({ path: `${shots}/${name}.png`, clip: { x, y, width: 220, height: 220 } });
  console.log(name, JSON.stringify(d));
}

await page.waitForTimeout(1500);
await snap('c1-run');

// jump and catch the rise
await page.keyboard.press('Space');
await page.waitForTimeout(350);
await snap('c2-rise');
await page.waitForTimeout(1600);
await snap('c3-late');

// hunt for a grab: keep jumping, poll fast
let grabShot = false;
for (let i = 0; i < 40 && !grabShot; i++) {
  await page.keyboard.press('Space');
  for (let j = 0; j < 14; j++) {
    await page.waitForTimeout(90);
    const d = await dbg();
    if (d.state === 'grab') {
      await snap('c4-grab');
      grabShot = true;
      break;
    }
  }
}
console.log('grab captured:', grabShot);
await snap('c5-final');
await page.screenshot({ path: `${shots}/c6-full.png` });
await browser.close();
