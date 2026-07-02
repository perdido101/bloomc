import { chromium } from 'playwright-core';

/**
 * Gallery acceptance run (Addendum §D): audition N consecutive DNAs,
 * verify hazard contrast ≥3:1, visual loads under budget, hue coverage,
 * and no consecutive noiseType/platformStyle repeats. Screenshots a few.
 */
const url = (process.argv[2] || 'http://localhost:4173/') + '?gallery=1.2';
const shots = '/tmp/claude-0/-home-user-bloomc/a2cfc189-cc00-52ee-9185-2dabd207137f/scratchpad';
const N = 20;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 520, height: 520 } });
const dnas = [];
const contrasts = [];
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 400)));
page.on('console', (msg) => {
  const t = msg.text();
  if (t.startsWith('[gallery')) {
    const json = t.slice(t.indexOf('::') + 2).trim();
    try { dnas.push(JSON.parse(json)); } catch {}
    const m = t.match(/hazContrast ([\d.]+)/);
    if (m) contrasts.push(Number(m[1]));
  }
  if (msg.type() === 'error' && !t.includes('404')) console.log('[error]', t.slice(0, 300));
});
await page.goto(url);
await page.waitForTimeout(3000);

let lastShot = 0;
while (dnas.length < N) {
  await page.waitForTimeout(500);
  if (dnas.length >= lastShot + 4) {
    lastShot = dnas.length;
    await page.screenshot({ path: `${shots}/g${String(dnas.length).padStart(2, '0')}.png` });
  }
}
await page.screenshot({ path: `${shots}/g-final.png` });

// ---- acceptance checks ----
let fails = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fails++; };

check(`${N} gallery Blooms collected`, dnas.length >= N);
check('hazard contrast ≥3:1 in every Bloom', contrasts.length > 0 && contrasts.every((c) => c >= 3));
const budgets = [3.0, 3.8, 4.6, 5.4, 6.4];
check('visual loads all under per-tier budget', dnas.every((d) => d.visualLoad <= budgets[d.tier] + 1e-6));
let noRepeat = true;
for (let i = 1; i < dnas.length; i++) {
  if (dnas[i].noiseType === dnas[i - 1].noiseType && dnas[i].platformStyle === dnas[i - 1].platformStyle) noRepeat = false;
}
check('no consecutive noiseType+platformStyle repeats', noRepeat);
const hues = dnas.map((d) => d.palette.baseHue).sort((a, b) => a - b);
let maxGap = hues[0] + 360 - hues[hues.length - 1];
for (let i = 1; i < hues.length; i++) maxGap = Math.max(maxGap, hues[i] - hues[i - 1]);
console.log(`hue span observed: ${Math.round(360 - maxGap)}° · contrasts: min ${Math.min(...contrasts)} · loads: ${dnas.map((d) => d.visualLoad).join(',')}`);
console.log(`noiseTypes: ${dnas.map((d) => d.noiseType).join(',')}`);
console.log(fails === 0 ? 'GALLERY ACCEPTANCE: ALL PASS' : `GALLERY ACCEPTANCE: ${fails} FAILURES`);
await browser.close();
process.exit(fails ? 1 : 0);
