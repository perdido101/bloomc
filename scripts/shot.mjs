import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://localhost:4173/';
const shots = process.env.SHOTS ||
  '/tmp/claude-0/-home-user-bloomc/a2cfc189-cc00-52ee-9185-2dabd207137f/scratchpad';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 420, height: 760 } });
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 400)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300));
});
await page.goto(url);
await page.waitForTimeout(2600);
await page.screenshot({ path: `${shots}/r1-splash.png` });
await page.click('#splash');
await page.waitForTimeout(700);
await page.screenshot({ path: `${shots}/r2-menu.png` });
await page.click('#btnPlay');
await page.waitForTimeout(900);
await page.screenshot({ path: `${shots}/r3-run-start.png` });

const dbg = () => page.evaluate(() => {
  const d = window.__vortika;
  return { state: d.state, lane: d.lane, z: Math.round(d.depth), speed: +(+d.speed).toFixed(1),
    score: d.score, alive: d.alive, pose: d.poseState, px: Math.round(d.px), py: Math.round(d.py) };
});

console.log('start', JSON.stringify(await dbg()));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${shots}/r4-running.png` });
console.log('run  ', JSON.stringify(await dbg()));

// lane changes
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(350);
await page.screenshot({ path: `${shots}/r5-left.png` });
console.log('left ', JSON.stringify(await dbg()));
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(350);
await page.screenshot({ path: `${shots}/r6-right.png` });
console.log('right', JSON.stringify(await dbg()));

// jump
await page.keyboard.press('Space');
await page.waitForTimeout(280);
await page.screenshot({ path: `${shots}/r7-jump.png` });
console.log('jump ', JSON.stringify(await dbg()));

// roll
await page.waitForTimeout(600);
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/r8-roll.png` });
console.log('roll ', JSON.stringify(await dbg()));

// let it run a while — see obstacles arrive
await page.waitForTimeout(6000);
await page.screenshot({ path: `${shots}/r9-later.png` });
console.log('later', JSON.stringify(await dbg()));

await browser.close();
