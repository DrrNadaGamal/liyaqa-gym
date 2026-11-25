// Captures README and case-study screenshots from a running Liyaqa.
import puppeteer from 'puppeteer-core';
const U = (process.argv[2] || 'http://localhost:3100').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
async function shot(name, pin, route, lang, w, h, full = false) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await p.goto(U + '/?lang=' + lang, { waitUntil: 'networkidle0' });
  await p.type('#pin', pin); await p.keyboard.press('Enter'); await p.waitForSelector('.top', { timeout: 15000 }); await sleep(400);
  if (route) { await p.evaluate((r) => (location.hash = '#/' + r), route); await sleep(600); }
  await p.screenshot({ path: `docs/${name}.png`, fullPage: full }); await ctx.close(); console.log(name);
}
await shot('owner-dashboard-en', '1111', 'dashboard', 'en', 1440, 1000, true);
await shot('checkin-en', '2222', 'checkin', 'en', 1440, 800);
await shot('members-en', '2222', 'members', 'en', 1440, 900);
await shot('classes-en', '1111', 'classes', 'en', 1440, 900);
await shot('reports-en', '1111', 'reports', 'en', 1440, 1000, true);
await shot('owner-dashboard-ar', '1111', 'dashboard', 'ar', 1440, 1000, true);
await shot('member-portal-ar-mobile', '4444', 'dashboard', 'ar', 390, 844, true);
await shot('member-classes-ar-mobile', '4444', 'classes', 'ar', 390, 844, true);
await shot('trainer-en-mobile', '3333', 'dashboard', 'en', 390, 844, true);
await b.close();
