// Browser and API checks against a running Liyaqa (local dev server or the live URL).
// Usage: node e2e/e2e.mjs https://your-deploy.vercel.app   (needs Chrome at /usr/bin/google-chrome)
import puppeteer from 'puppeteer-core';
const U = (process.argv[2] || 'http://localhost:3100').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
const errs = [], dialogs = [];
async function newPage(w = 1280, h = 900) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: w, height: h });
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
  p.on('dialog', (d) => { dialogs.push(d.type() + ':' + d.message()); d.accept(); }); return p;
}
async function login(p, pin, lang = 'en') {
  await p.goto(U + '/?lang=' + lang, { waitUntil: 'networkidle0' });
  await p.evaluate(() => localStorage.clear()); await p.goto(U + '/?lang=' + lang, { waitUntil: 'networkidle0' });
  await p.type('#pin', pin); await p.keyboard.press('Enter'); await p.waitForSelector('.top', { timeout: 15000 }); await sleep(300);
}
const go = async (p, r) => { await p.evaluate((r) => (location.hash = '#/' + r), r); await sleep(350); };
const body = (p) => p.evaluate(() => document.body.innerText);
const toastText = (p) => p.evaluate(() => document.querySelector('#toast')?.innerText || '');
const click = async (p, sel) => { await p.waitForSelector(sel, { timeout: 8000 }); await p.click(sel); await sleep(450); };
async function api(token, method, bodyObj, raw) {
  const r = await fetch(U + '/api/data', { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: raw ?? (bodyObj ? JSON.stringify(bodyObj) : undefined) });
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, j };
}
async function tokenFor(pin) { return (await api(null, 'POST', { op: { type: 'login', pin } })).j.token; }
const T = { owner: await tokenFor('1111'), desk: await tokenFor('2222'), trainer: await tokenFor('3333'), member: await tokenFor('4444') };
const post = (role, op) => api(T[role], 'POST', { op });
const view = async (role) => (await api(T[role], 'GET')).j;

// ---------- API security ----------
ok((await api(null, 'GET')).status === 401, 'no token: 401');
ok((await api('garbage', 'GET')).status === 401, 'garbage token: 401');
const tam = T.member.split('.'); const forged = Buffer.from('u-owner.' + (Date.now() + 1e7)).toString('base64url') + '.' + tam[1];
ok((await api(forged, 'GET')).status === 401, 'forged token for another user: 401');
ok((await api(null, 'POST', { op: { type: 'login', pin: '0000' } })).status === 401, 'wrong PIN: 401');
ok((await api(T.owner, 'POST', null, '{not json')).status === 400, 'malformed JSON: 400');
ok((await api(T.owner, 'POST', { op: { type: 'setNote', memberId: 'm1', note: 'x'.repeat(30000) } })).status === 413, 'oversized body: 413');
ok((await api(T.owner, 'PUT', {})).status === 405, 'PUT: 405');
ok((await post('owner', { type: 'nope' })).status === 400, 'unknown operation: 400');
const dv = await view('desk'), ov = await view('owner'), tv = await view('trainer'), mv = await view('member');
ok(!JSON.stringify(dv).includes('"pin"') && !JSON.stringify(ov).includes('"pin"') && !JSON.stringify(mv).includes('"pin"') && !JSON.stringify(tv).includes('"pin"'), 'PINs are never sent to the browser');
ok(tv.payments === undefined && tv.reports === undefined && tv.members.every((x) => !('phone' in x)), 'trainer view: no payments, no reports, no phone numbers');
ok(mv.members === undefined && mv.payments.every((p) => p.memberId === mv.member.id) && !JSON.stringify(mv).includes(ov.members[7].phone), 'member view: own data only');
ok(dv.audit === undefined && ov.audit.length > 0, 'audit trail is owner only');
ok((await post('desk', { type: 'setPlanPrice', planId: 'pl1', price: 99900 })).status === 403, 'desk cannot change prices (403)');
ok((await post('desk', { type: 'cancelMembership', memberId: 'm2', reason: 'test' })).status === 403, 'desk cannot cancel a membership (403)');
ok((await post('desk', { type: 'reset' })).status === 403, 'desk cannot reset (403)');
ok((await post('trainer', { type: 'sellPlan', memberId: 'm2', planId: 'pl1', method: 'cash' })).status === 403, 'trainer cannot sell (403)');
ok((await post('trainer', { type: 'checkIn', memberId: 'm2' })).status === 403, 'trainer cannot check in (403)');
ok((await post('member', { type: 'checkIn', memberId: 'm1' })).status === 403, 'member cannot check in (403)');
ok((await post('member', { type: 'sellPlan', memberId: 'm1', planId: 'pl1', method: 'cash' })).status === 403, 'member cannot sell (403)');
ok((await post('member', { type: 'addMember', name: 'Hack Attempt', phone: '01099999999' })).status === 403, 'member cannot add members (403)');
const otherBk = ov.bookings.find((x) => x.status === 'booked' && x.memberId !== mv.member.id && x.date > ov.today);
ok(otherBk && (await post('member', { type: 'cancelBooking', bookingId: otherBk.id })).status === 403, "member cannot cancel someone else's booking (403)");
const otherClass = ov.classes.find((c) => c.trainerId !== 'u-t1');
ok((await post('trainer', { type: 'markClass', classId: otherClass.id, date: ov.today, marks: {} })).status === 403, "trainer cannot mark another trainer's class (403)");

// ---------- owner: check-in desk ----------
const o = await newPage(); await login(o, '1111');
ok((await body(o)).includes('Active members') && (await o.$('.kpis')) !== null, 'owner dashboard shows KPIs');
const stale = (m) => !m.lastVisit || m.lastVisit < ov.now - 3 * 36e5;
const good = ov.members.find((m) => m.status === 'active' && m.visitsLeft == null && stale(m));
const dead = ov.members.find((m) => m.status === 'expired' && m.visitsLeft == null);
const frz = ov.members.find((m) => m.status === 'frozen');
await go(o, 'checkin'); await o.type('#ci-q', good.code); await sleep(250);
ok((await o.$$eval('#ci-res .mrow', (r) => r.length)) >= 1, 'check-in search finds the member by code');
await o.keyboard.press('Enter'); await sleep(600);
ok((await o.$('.ci.ok')) !== null && (await body(o)).includes(good.name), 'check-in: active member is let in (green card)');
await o.type('#ci-q', good.code.toLowerCase()); await o.keyboard.press('Enter'); await sleep(600);
ok((await o.$('.ci.dup')) !== null, 'check-in: second scan is flagged as already checked in');
await o.type('#ci-q', dead.code); await o.keyboard.press('Enter'); await sleep(600);
ok((await o.$('.ci.no')) !== null && (await body(o)).includes('Membership expired'), 'check-in: expired member is turned away with the reason');
ok((await o.$('.ci [data-act=sell]')) !== null, 'check-in: denied card offers Renew');
await o.type('#ci-q', frz.code); await o.keyboard.press('Enter'); await sleep(600);
ok((await body(o)).includes('Membership is frozen'), 'check-in: frozen member is turned away');
await o.type('#ci-q', 'zzzz'); await sleep(200); await o.keyboard.press('Enter'); await sleep(300);
ok((await toastText(o)).length > 0 || (await body(o)).includes('No match'), 'check-in: unknown search gives feedback');

// ---------- owner: add member, hostile text, renewal quote, household discount ----------
const phone1 = '0101' + String(Math.floor(Math.random() * 9e6) + 1e6), phone2 = '0102' + String(Math.floor(Math.random() * 9e6) + 1e6);
await go(o, 'members'); await click(o, '[data-act=add-member]');
await o.type('#n-name', '<img src=x onerror=alert(1)> Test'); await o.type('#n-phone', '123'); await click(o, '[data-act=member-go]');
ok((await toastText(o)).includes('Egyptian mobile'), 'add member: bad phone rejected with a clear message');
await o.$eval('#n-phone', (e) => (e.value = '')); await o.type('#n-phone', phone1); await o.select('#n-plan', 'pl1'); await click(o, '[data-act=member-go]');
await sleep(300);
const hash1 = await o.evaluate(() => location.hash); const mid1 = hash1.split('/')[2];
ok(/^#\/member\/m\d+$/.test(hash1), 'add member: lands on the new member page');
ok((await o.$('main img')) === null && (await o.evaluate(() => document.querySelector('main').innerHTML.includes('&lt;img'))), 'hostile name is shown as plain text, not HTML');
ok(!dialogs.some((d) => d.startsWith('alert')), 'no script ran from hostile text');
ok((await body(o)).includes('Active') && (await body(o)).includes('R-'), 'new member is active with a receipt');
const m1 = (await view('owner')).members.find((m) => m.id === mid1); const end1 = m1.end;
await click(o, '[data-act=sell]');
ok((await body(o)).includes('Starts after the current end date'), 'renew quote: continues after the current end date');
await o.select('#m-plan', 'pl2'); await sleep(300);
ok((await body(o)).includes('1,600 EGP'), 'renew quote: quarterly total is 1,600 EGP');
await click(o, '[data-act=sell-go]');
const m1b = (await view('owner')).members.find((m) => m.id === mid1);
ok(m1b.end === new Date(Date.parse(end1 + 'T00:00:00Z') + 90 * 864e5).toISOString().slice(0, 10), 'renewal added 90 days after the old end date');
// household discount
await go(o, 'members'); await click(o, '[data-act=add-member]');
await o.type('#n-name', 'E2E Household Mate'); await o.type('#n-phone', phone2); await o.type('#n-house', m1.code); await o.select('#n-plan', 'pl1'); await click(o, '[data-act=member-go]');
const mid2 = (await o.evaluate(() => location.hash)).split('/')[2];
const pay2 = (await view('owner')).payments.find((p) => p.memberId === mid2);
ok(pay2 && pay2.amount === 54000 && pay2.discount === 6000, 'household discount: 10% off the second person (540 EGP)');
// void (owner), then check status
await click(o, '[data-act=void]'); await o.type('#v-reason', 'e2e test'); await click(o, '[data-act=void-go]');
ok((await view('owner')).members.find((m) => m.id === mid2).status === 'none', 'void: membership restored to no plan');
// freeze / unfreeze
await go(o, 'member/' + mid1); await click(o, '[data-act=freeze]'); await o.$eval('#f-days', (e) => (e.value = '10')); await click(o, '[data-act=freeze-go]');
ok((await view('owner')).members.find((m) => m.id === mid1).status === 'frozen', 'freeze: member is frozen');
await click(o, '[data-act=unfreeze]');
const m1c = (await view('owner')).members.find((m) => m.id === mid1);
ok(m1c.status !== 'frozen' && m1c.end === m1b.end, 'unfreeze on the same day: end date unchanged');
// cancel membership
await click(o, '[data-act=cancel-m]'); await o.type('#c-reason', 'e2e test'); await click(o, '[data-act=cancelm-go]');
ok((await view('owner')).members.find((m) => m.id === mid1).status === 'cancelled', 'cancel membership: status cancelled');
await go(o, 'checkin'); await o.type('#ci-q', m1.code); await o.keyboard.press('Enter'); await sleep(500);
ok((await body(o)).includes('Membership is cancelled'), 'check-in: cancelled member is turned away');
// plans: price edit, then restore
await go(o, 'plans'); await click(o, '[data-act=price][data-id=pl1]'); await o.$eval('#p-price', (e) => (e.value = '700')); await click(o, '[data-act=price-go]');
ok((await body(o)).includes('700 EGP'), 'plan price edit shows 700 EGP');
await click(o, '[data-act=price][data-id=pl1]'); await o.$eval('#p-price', (e) => (e.value = '600')); await click(o, '[data-act=price-go]');
ok((await view('owner')).plans.find((p) => p.id === 'pl1').price === 60000, 'plan price restored to 600 EGP');
// pages render
for (const pg of ['dashboard', 'members', 'classes', 'payments', 'plans', 'reports', 'audit']) { await go(o, pg); const t = await body(o); ok(t.length > 200 && !/undefined|NaN|\[object/.test(t), 'owner page renders: ' + pg); }
await go(o, 'payments'); await click(o, '[data-act=receipt]');
ok((await o.$('.receipt')) !== null && (await body(o)).includes('Not a tax invoice'), 'receipt modal opens with the demo note');
await o.keyboard.press('Escape'); await sleep(200);
await go(o, 'members'); await o.select('[data-in=stF]', 'expired'); await sleep(300);
ok((await o.$$eval('tbody tr', (r) => r.length)) > 3 && (await o.$$eval('tbody .pill', (r) => r.every((x) => !x.classList.contains('x') && true))), 'members filter by status works');
await o.type('[data-in=q]', 'zzzzzzzz'); await sleep(300); ok((await body(o)).includes('Nothing here yet'), 'members search with no match shows the empty state');

// ---------- desk ----------
const d = await newPage(); await login(d, '2222');
const nav = await d.$$eval('.nav a', (a) => a.map((x) => x.textContent.trim()));
ok(!nav.includes('Plans') && !nav.includes('Reports') && !nav.includes('Audit trail') && nav.includes('Check-in'), 'desk nav has no Plans, Reports or Audit');
await go(d, 'reports'); ok((await body(d)).includes('Dashboard'), 'desk opening #/reports falls back to the dashboard');
await go(d, 'member/m6'); ok(!(await o.evaluate(() => 0)) && (await d.$('[data-act=cancel-m]')) === null, 'desk sees no Cancel membership button');
ok(!(await body(d)).includes('Revenue this month'), 'desk dashboard shows takings for today, not the monthly revenue');

// ---------- trainer ----------
const tr = await newPage(); await login(tr, '3333');
await go(tr, 'classes'); const names = await tr.$$eval('.cls-b .muted', (e) => e.map((x) => x.textContent));
ok(names.length > 0 && names.every((x) => x.includes('Omar Fathy')), "trainer sees only their own classes' schedule");
const otherC = tv.classes.find((c) => c.trainerId !== 'u-t1'); await go(tr, `class/${otherC.id}/${tv.today}`);
ok((await body(tr)).includes('Not found'), "trainer opening another trainer's roster gets Not found");
await go(tr, 'member/m1'); ok((await body(tr)).includes('Welcome'), 'trainer cannot open member pages (back to dashboard)');
const spin = tv.classes.find((c) => c.id === 'c1'); const todayD = tv.today;
let pastSat = todayD; for (let i = 1; i <= 7; i++) { const dd = new Date(Date.parse(todayD + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 10); if (new Date(dd + 'T00:00:00Z').getUTCDay() === spin.dow) { pastSat = dd; break; } }
await go(tr, `class/c1/${pastSat}`);
ok((await tr.$('[data-act=mark-save]')) !== null, 'trainer can mark attendance for their past class');
await click(tr, '[data-act=mark-all]'); await click(tr, '[data-act=mark-save]');
ok((await toastText(tr)).includes('Saved'), 'attendance saved');

// ---------- member ----------
const m = await newPage(390, 844); await login(m, '4444');
ok((await body(m)).includes('Hana') && (await m.$('.mcard')) !== null, 'member dashboard shows their membership card');
const mvv = await view('member');
await go(m, 'classes');
const free = mvv.occurrences.find((x) => x.startsAt > mvv.now + 4 * 36e5 && x.booked < mvv.classes.find((c) => c.id === x.classId).capacity && !mvv.bookings.some((bk) => bk.classId === x.classId && bk.date === x.date && bk.status !== 'cancelled'));
const clash = (x) => mvv.bookings.some((bk) => bk.status !== 'cancelled' && bk.date === x.date && mvv.classes.find((c) => c.id === bk.classId).time === mvv.classes.find((c) => c.id === x.classId).time);
const pick = mvv.occurrences.find((x) => x.startsAt > mvv.now + 4 * 36e5 && x.booked < mvv.classes.find((c) => c.id === x.classId).capacity && !clash(x));
await m.click(`[data-act=book-self][data-class=${pick.classId}][data-date="${pick.date}"]`); await sleep(600);
ok((await toastText(m)).includes('Booked'), 'member books a class');
ok((await view('member')).bookings.some((bk) => bk.classId === pick.classId && bk.date === pick.date && bk.status === 'booked'), 'booking is stored');
await m.click(`[data-act=cancel-booking]`); await sleep(500);
ok((await toastText(m)).includes('Cancelled'), 'member cancels more than 2 hours ahead without a penalty');
ok(!dialogs.some((x) => x.includes('late cancel')), 'no late-cancel warning for an early cancel');
const fullOcc = mvv.occurrences.find((x) => { const c = mvv.classes.find((k) => k.id === x.classId); return x.booked >= c.capacity && x.startsAt > mvv.now && !mvv.bookings.some((bk) => bk.classId === x.classId && bk.date === x.date && bk.status !== 'cancelled') && !clash(x); });
if (fullOcc) {
  await go(m, 'dashboard'); await go(m, 'classes');
  await m.click(`[data-act=book-self][data-class=${fullOcc.classId}][data-date="${fullOcc.date}"]`); await sleep(600);
  ok((await toastText(m)).includes('#'), 'full class: member joins the waitlist with a position');
  const wb = (await view('member')).bookings.find((bk) => bk.classId === fullOcc.classId && bk.date === fullOcc.date && bk.status === 'waitlist');
  ok(!!wb, 'waitlist booking is stored');
  if (wb) await post('member', { type: 'cancelBooking', bookingId: wb.id });
} else ok(true, 'no extra full class today (skipped)');
await go(m, 'history'); ok((await body(m)).includes('Recent visits'), 'member history page renders');
const w0 = await m.evaluate(() => document.documentElement.scrollWidth); ok(w0 <= 392, 'member pages fit a 390px phone');

// ---------- Arabic and mobile layout ----------
const a = await newPage(); await login(a, '1111', 'ar');
ok((await a.evaluate(() => document.documentElement.dir)) === 'rtl', 'Arabic UI is right-to-left');
for (const pg of ['dashboard', 'checkin', 'members', 'classes', 'payments', 'plans', 'reports', 'audit']) { await go(a, pg); const t = await body(a); ok(!/\b(nav|st|ci|kpi|pm|bs|role)\.[a-z]+/i.test(t) && /[\u0600-\u06FF]/.test(t), 'Arabic page has no raw keys: ' + pg); }
const ph = await newPage(390, 844); await login(ph, '1111');
for (const pg of ['dashboard', 'checkin', 'members', 'member/m1', 'classes', 'payments', 'plans', 'reports']) { await go(ph, pg); const w = await ph.evaluate(() => document.documentElement.scrollWidth); ok(w <= 392, `owner page fits 390px: ${pg} (${w}px)`); }
const pa = await newPage(390, 844); await login(pa, '4444', 'ar');
for (const pg of ['dashboard', 'classes', 'history']) { await go(pa, pg); const w = await pa.evaluate(() => document.documentElement.scrollWidth); ok(w <= 392, `Arabic member page fits 390px: ${pg}`); }

// ---------- reset and final state ----------
await go(o, 'dashboard'); await click(o, '[data-act=reset]'); await sleep(600);
const after = await view('owner');
ok(after.members.length === 96 && !after.members.some((x) => x.name.includes('E2E')), 'owner reset brings the demo back to its seed (96 members)');
ok(errs.length === 0, 'no page errors in any session' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail ? 1 : 0);
