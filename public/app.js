import * as L from './logic.js';
import { T } from './i18n.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('lq.' + k)) ?? d; } catch { return d; } }, set: (k, v) => localStorage.setItem('lq.' + k, JSON.stringify(v)), del: (k) => localStorage.removeItem('lq.' + k) };

const S = { lang: new URLSearchParams(location.search).get('lang') || LS.get('lang', 'en'), token: LS.get('token', null), me: LS.get('me', null), data: null, modal: null, busy: false, q: '', stF: '', planF: '', ci: null, ciq: '', marks: null, err: '' };
if (!T[S.lang]) S.lang = 'en';
const get = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
const t = (k) => get(T[S.lang], k) ?? get(T.en, k) ?? k;
const ar = () => S.lang === 'ar';
const nf = (n, d = 0) => Number(n).toLocaleString(ar() ? 'ar-EG' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (c) => `${nf(c / 100, c % 100 ? 2 : 0)} ${t('cur')}`;
const dt = (k) => (k ? new Date(k + 'T00:00:00Z').toLocaleDateString(ar() ? 'ar-EG' : 'en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : '');
const dts = (ts) => dt(L.dayKey(ts));
const dlong = (k) => new Date(k + 'T00:00:00Z').toLocaleDateString(ar() ? 'ar-EG' : 'en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' });
const tm = (ts) => new Date(ts).toLocaleTimeString(ar() ? 'ar-EG' : 'en-GB', { timeZone: L.TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const hm = (s) => (ar() ? s.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]) : s);
const nm = (o) => (ar() ? o.nameAr || o.name : o.name);
const D = () => S.data;
const me = () => S.data?.me || S.me;
const role = () => me()?.role;
const staff = () => role() === 'owner' || role() === 'desk';
const planOf = (id) => D().plans.find((p) => p.id === id);
const classOf = (id) => D().classes.find((c) => c.id === id);
const memOf = (id) => D().members?.find((m) => m.id === id);
const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const toCents = (s) => { const n = parseFloat(String(s ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
const toast = (m, bad) => { const el = $('#toast'); el.innerHTML = `<div class="${bad ? 'err' : ''}">${esc(m)}</div>`; clearTimeout(toast.h); toast.h = setTimeout(() => (el.innerHTML = ''), bad ? 5500 : 2600); };
// Server messages are English. Known ones are translated here; anything else is shown as sent.
const errText = (m) => { const d = T[S.lang].srv; if (d?.[m]) return d[m]; for (const [re, fn] of T[S.lang].srvRe || []) { const x = re.exec(m); if (x) return fn(...x.slice(1).map((n) => nf(n))); } return m; };

// ---------- network ----------
class NetError extends Error {}
async function call(method, body) {
  let r;
  try { r = await fetch('/api/data', { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); } catch { throw new NetError('offline'); }
  let j = {}; try { j = await r.json(); } catch { if (r.status >= 500) throw new NetError('server'); }
  if (r.status === 401 && S.token) { logout(); throw new Error(j.error || t('again')); }
  if (r.status >= 500) throw new NetError('server');
  if (!r.ok) throw new Error(j.error || 'Error');
  return j;
}
async function act(op, okMsg) {
  if (S.busy) return null; S.busy = true;
  try { const j = await call('POST', { op }); const { result, ...v } = j; S.data = v; if (okMsg) toast(okMsg); return result || {}; }
  catch (e) { toast(e instanceof NetError ? t(e.message === 'offline' ? 'offline' : 'err.server') : errText(e.message), true); return null; }
  finally { S.busy = false; }
}
async function refresh() { try { S.data = await call('GET'); S.err = ''; } catch (e) { S.err = e instanceof NetError ? t('offline') : errText(e.message); } }
async function login(pin) {
  try { const j = await call('POST', { op: { type: 'login', pin } }); S.token = j.token; S.me = j.me; LS.set('token', j.token); LS.set('me', j.me); S.err = ''; await refresh(); location.hash = '#/dashboard'; S.ci = null; render(); }
  catch (e) { S.err = errText(e.message); render(); }
}
function logout() { S.token = null; S.me = null; S.data = null; LS.del('token'); LS.del('me'); S.modal = null; S.ci = null; location.hash = ''; render(); }

// ---------- routing ----------
const route = () => { const [p, a, b] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/'); return { p, a, b }; };
const NAV = {
  owner: ['dashboard', 'checkin', 'members', 'classes', 'payments', 'plans', 'reports', 'audit'],
  desk: ['dashboard', 'checkin', 'members', 'classes', 'payments'],
  trainer: ['dashboard', 'classes'],
  member: ['dashboard', 'classes', 'history'],
};

// ---------- small views ----------
const pill = (cls, txt) => `<span class="pill ${cls}">${esc(txt)}</span>`;
const stCls = { active: '', expiring: 'off', grace: 'off', expired: 'bad', frozen: 'ice', cancelled: 'gray', none: 'gray' };
const stPill = (s) => pill(stCls[s] ?? 'gray', t('st.' + s));
const empty = (m) => `<p class="empty">${esc(m || t('none'))}</p>`;
const bar = (pct, cls = '') => `<div class="meter ${cls}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
const kpi = (n, l, cls = '', sub = '') => `<div class="card kpi ${cls}"><div class="n">${n}</div><div class="l">${esc(l)}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
const field = (id, label, inner, hint) => `<div class="f"><label for="${id}">${esc(label)}</label>${inner}${hint ? `<small class="muted">${esc(hint)}</small>` : ''}</div>`;
const val = (id) => $('#' + id)?.value ?? '';
const LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#14181f"/><path d="M9 19v10M14 15v18M34 15v18M39 19v10M14 24h20" stroke="#ff6b2c" stroke-width="3.6" stroke-linecap="round" fill="none"/></svg>';
const mlink = (m) => `<a href="#/member/${esc(m.id)}">${esc(nm(m))}</a> <small class="muted" dir="ltr">${esc(m.code)}</small>`;
const whenEnds = (m) => (m.end ? `${esc(dt(m.end))} <small class="muted">${m.status === 'frozen' ? '' : m.daysLeft >= 0 ? `${nf(m.daysLeft)} ${esc(t('daysShort'))}` : `${esc(t('ago'))} ${nf(-m.daysLeft)} ${esc(t('daysShort'))}`}</small>` : '-');

function peakChart(hours) {
  const max = Math.max(1, ...hours), from = 5, to = 23;
  return `<div class="charts" role="img" aria-label="${esc(t('peakHours'))}">${hours.slice(from, to + 1).map((n, i) => `<div class="col" title="${esc(hm(String(i + from).padStart(2, '0') + ':00') + ': ' + nf(n))}"><div class="b" style="height:${Math.round((n / max) * 100)}%"></div><small>${nf(i + from)}</small></div>`).join('')}</div>`;
}
function revChart(series) {
  const max = Math.max(1, ...series.map((x) => x.amount));
  return `<div class="charts" role="img" aria-label="${esc(t('rev14'))}">${series.map((x) => `<div class="col" title="${esc(dt(x.day) + ': ' + money(x.amount))}"><div class="b alt" style="height:${Math.round((x.amount / max) * 100)}%"></div><small>${nf(Number(x.day.slice(8)))}</small></div>`).join('')}</div>`;
}

// ---------- class occurrences ----------
function occRange(from, to) {
  const d = D(), out = [], mine = d.myClassIds;
  for (let day = from; day <= to; day = L.addDays(day, 1)) {
    for (const c of d.classes.filter((x) => x.dow === L.dow(day) && (!mine || mine.includes(x.id)))) {
      const list = d.bookings.filter((b) => b.classId === c.id && b.date === day);
      out.push({ classId: c.id, date: day, startsAt: L.startsAt(c, day), booked: list.filter((b) => ['booked', 'attended', 'noshow'].includes(b.status)).length, waitlist: list.filter((b) => b.status === 'waitlist').length });
    }
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}
const myBooking = (classId, date) => D().bookings.find((b) => b.memberId === D().member?.id && b.classId === classId && b.date === date && (b.status === 'booked' || b.status === 'waitlist'));
function occCard(o) {
  const c = classOf(o.classId), d = D(), full = o.booked >= c.capacity, past = o.startsAt <= d.now;
  const pct = Math.round((Math.min(o.booked, c.capacity) / c.capacity) * 100);
  let action = '';
  if (role() === 'member') {
    const b = myBooking(o.classId, o.date);
    if (past) action = '';
    else if (b) action = `${pill(b.status === 'booked' ? '' : 'off', b.status === 'booked' ? t('youBooked') : t('onWaitlist'))} <button class="btn sm danger" data-act="cancel-booking" data-id="${esc(b.id)}" data-late="${o.startsAt - d.now < L.LATE_CANCEL_MIN * 60000 && b.status === 'booked' ? 1 : 0}">${esc(t('cancel'))}</button>`;
    else action = `<button class="btn sm pri" data-act="book-self" data-class="${esc(c.id)}" data-date="${o.date}">${esc(full ? t('joinWaitlist') : t('book'))}</button>`;
  } else {
    action = `<a class="btn sm" href="#/class/${esc(c.id)}/${o.date}">${esc(t('roster'))}</a>${!past && staff() ? ` <button class="btn sm pri" data-act="book-for" data-class="${esc(c.id)}" data-date="${o.date}">${esc(t('book'))}</button>` : ''}`;
  }
  return `<article class="card cls ${past ? 'past' : ''}"><div class="cls-t" dir="ltr">${esc(hm(c.time))}</div><div class="cls-b"><b>${esc(nm(c))}</b><div class="muted small">${esc(ar() ? c.trainerNameAr || c.trainerName : c.trainerName)} · ${esc(c.room)}</div>${bar(pct, full ? 'bad' : pct > 75 ? 'off' : '')}<div class="small">${nf(Math.min(o.booked, c.capacity))}/${nf(c.capacity)}${o.waitlist ? ` · ${nf(o.waitlist)} ${esc(t('waiting'))}` : ''}${full ? ' ' + pill('bad', t('full')) : ''}</div></div><div class="cls-a">${action}</div></article>`;
}
function schedule(from, to, withPast) {
  const d = D(), occ = role() === 'member' ? d.occurrences : occRange(from, to);
  const days = [...new Set(occ.map((o) => o.date))];
  if (!days.length) return empty();
  return days.map((day) => `<h3 class="day">${esc(dlong(day))}${day === d.today ? ' ' + pill('', t('today')) : ''}</h3><div class="grid cls-grid">${occ.filter((o) => o.date === day).map(occCard).join('')}</div>`).join('');
}

// ---------- pages ----------
function loginPage() {
  return `<div class="login"><div class="logo">${LOGO}<div><h1>${esc(t('appName'))}</h1><p class="sub">${esc(t('appSub'))}</p></div><button class="btn sm" data-act="lang" style="margin-inline-start:auto">${esc(t('other'))}</button></div>
  <div class="card"><h2>${esc(t('signin'))}</h2><p class="muted">${esc(t('demoNote'))}</p>
  <div class="demo-users">${L.DEMO_USERS.map((u) => `<button class="btn" data-act="demo" data-pin="${u.pin}"><span>${esc(ar() ? u.labelAr : u.label)}</span><span class="pill gray" dir="ltr">${esc(t('role.' + u.role))} · ${u.pin}</span></button>`).join('')}</div>
  <form data-form="login" class="row"><input id="pin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="${esc(t('pin'))}" aria-label="${esc(t('pin'))}"><button class="btn pri" type="submit">${esc(t('signin'))}</button></form>
  ${S.err ? `<p class="notice bad" role="alert">${esc(S.err)}</p>` : ''}</div><p class="muted small">${esc(t('limits'))}</p></div>`;
}
function top() {
  const r = route(), items = NAV[role()];
  const on = (k) => r.p === k || (k === 'members' && r.p === 'member') || (k === 'classes' && r.p === 'class');
  return `<header class="top"><a class="brand" href="#/dashboard">${LOGO}<span>${esc(t('appName'))}<small>${esc(nm(D().gym))}</small></span></a>
  <nav class="nav" aria-label="Main">${items.map((k) => `<a href="#/${k}" class="${on(k) ? 'on' : ''}">${esc(t('nav.' + k))}</a>`).join('')}</nav>
  <div class="tools"><span class="who">${esc(nm(me()))} <span class="pill">${esc(t('role.' + role()))}</span></span><button class="btn ghost sm" data-act="lang">${esc(t('other'))}</button><button class="btn ghost sm" data-act="logout">${esc(t('logout'))}</button></div></header>`;
}

// ----- front desk check-in -----
const matches = (q) => {
  const s = q.trim().toLowerCase(); if (!s) return [];
  const digits = s.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  return D().members.filter((m) => m.code.toLowerCase().includes(s) || m.name.toLowerCase().includes(s) || (m.nameAr || '').includes(s) || m.phone.includes(digits)).slice(0, 8);
};
const resultsHtml = (q) => { const r = matches(q); return r.length ? r.map((m) => `<div class="mrow"><div>${mlink(m)}<div class="small muted">${esc(m.planName ? (ar() ? m.planNameAr : m.planName) : t('noPlan'))} · ${m.end ? esc(dt(m.end)) : ''}</div></div><div>${stPill(m.status)} <button class="btn sm pri" data-act="checkin" data-id="${esc(m.id)}">${esc(t('checkIn'))}</button></div></div>`).join('') : q.trim() ? empty(t('noMatch')) : ''; };
function ciCard() {
  const c = S.ci; if (!c) return '';
  const m = memOf(c.memberId) || {}, r = c.res;
  let cls = 'ok', head = t('ci.ok'), lines = [];
  if (r.duplicate) { cls = 'dup'; head = t('ci.dup'); lines.push(`${t('ci.dupAt')} ${tm(r.at)}`); }
  else if (!r.ok) { cls = 'no'; head = t('ci.no'); lines.push(t('ci.why.' + r.reason)); }
  else if (r.warn === 'grace') { cls = 'warn'; head = t('ci.grace'); lines.push(`${t('ci.graceMsg')} ${nf(-r.daysLeft)} ${t('daysShort')}`); }
  else if (r.warn === 'expiring') { cls = 'warn'; head = t('ci.ok'); lines.push(`${t('ci.expMsg')} ${nf(r.daysLeft)} ${t('daysShort')}`); }
  if (r.ok && !r.duplicate && r.visitsLeft != null) lines.push(`${t('visitsLeft')}: ${nf(r.visitsLeft)}`);
  const fix = !r.ok || r.warn ? `<div class="acts">${m.status === 'frozen' ? `<button class="btn sm" data-act="unfreeze" data-id="${esc(m.id)}">${esc(t('unfreeze'))}</button>` : `<button class="btn sm pri" data-act="sell" data-id="${esc(m.id)}">${esc(m.planId ? t('renew') : t('buyPlan'))}</button>`}</div>` : '';
  return `<section class="ci ${cls}" role="status" aria-live="polite"><div class="ci-h">${esc(head)}</div><div class="ci-n">${esc(nm(m))} <small dir="ltr">${esc(m.code || '')}</small></div>${lines.map((x) => `<p>${esc(x)}</p>`).join('')}<div>${stPill(m.status || 'none')}</div>${fix}</section>`;
}
function checkinPage() {
  const d = D(), recent = d.checkins.filter((k) => k.at >= L.localToEpoch(d.today, '00:00')).slice(0, 14);
  return `<h1>${esc(t('nav.checkin'))}</h1>
  <section class="card"><label for="ci-q">${esc(t('ci.find'))}</label><input id="ci-q" class="big" data-in="ciq" autocomplete="off" value="${esc(S.ciq)}" placeholder="${esc(t('ci.ph'))}"><div id="ci-res">${resultsHtml(S.ciq)}</div></section>
  ${ciCard()}
  <section class="card"><h2>${esc(t('todayScans'))}</h2>${recent.length ? `<div class="tw"><table><tbody>${recent.map((k) => { const m = memOf(k.memberId); return `<tr><td dir="ltr">${esc(tm(k.at))}</td><td>${m ? mlink(m) : ''}</td><td>${k.result === 'ok' ? pill(k.reason ? 'off' : '', k.reason ? t('ci.' + k.reason) : t('ci.okShort')) : pill('bad', t('ci.why.' + k.reason))}</td></tr>`; }).join('')}</tbody></table></div>` : empty()}</section>`;
}

// ----- dashboards -----
function followRow(m, win) {
  return `<tr><td>${mlink(m)}</td><td>${esc(ar() ? m.planNameAr || '' : m.planName || '')}</td><td>${whenEnds(m)}</td><td class="num">${nf(m.visits30)}</td><td dir="ltr" class="small">${esc(m.phone)}</td><td><button class="btn sm pri" data-act="sell" data-id="${esc(m.id)}">${esc(win ? t('winBack') : t('renew'))}</button></td></tr>`;
}
function followTable(list, win) {
  if (!list.length) return empty();
  return `<div class="tw"><table><thead><tr><th>${esc(t('member'))}</th><th>${esc(t('plan'))}</th><th>${esc(t('ends'))}</th><th class="num">${esc(t('visits30'))}</th><th>${esc(t('phone'))}</th><th></th></tr></thead><tbody>${list.map((m) => followRow(m, win)).join('')}</tbody></table></div>`;
}
function dashStaff() {
  const d = D(), r = d.reports, c = r.counts, ms = d.members;
  const exp = ms.filter((m) => m.status === 'expiring' || m.status === 'grace').sort((a, b) => a.end.localeCompare(b.end));
  const lapsed = ms.filter((m) => m.status === 'expired' && m.daysLeft >= -30 && m.visitsLeft == null).sort((a, b) => b.end.localeCompare(a.end));
  const soon = occRange(d.today, L.addDays(d.today, 1)).filter((o) => o.startsAt > d.now).slice(0, 4);
  return `<h1>${esc(t('nav.dashboard'))}</h1>
  <div class="grid kpis">${kpi(nf(c.active + c.expiring), t('kpi.active'), '', `${nf(c.frozen)} ${esc(t('st.frozen'))}`)}${kpi(nf(c.expiring + c.grace), t('kpi.expiring'), c.expiring + c.grace ? 'warn' : '')}${kpi(nf(r.checkinsToday), t('kpi.today'), 'good', r.deniedToday ? `${nf(r.deniedToday)} ${esc(t('kpi.denied'))}` : '')}${kpi(money(role() === 'owner' ? r.revenueMonth : r.revenueToday), role() === 'owner' ? t('kpi.revMonth') : t('kpi.revToday'))}</div>
  <div class="grid two" style="margin-top:1rem"><section class="card"><h2>${esc(t('peakHours'))}</h2>${peakChart(r.hours)}<p class="muted small">${esc(t('peakHelp'))}</p></section>
  <section class="card"><h2>${esc(t('rev14'))}</h2>${revChart(r.series)}<p class="muted small">${esc(t('retention'))}: ${r.retention.pct == null ? '-' : nf(r.retention.pct) + '%'} <span class="muted">(${esc(t('retentionHelp'))})</span></p></section></div>
  <section class="card" style="margin-top:1rem"><div class="bar"><h2>${esc(t('expiringTitle'))}</h2><span class="sp"></span><button class="btn sm" data-act="csv-follow">${esc(t('csv'))}</button></div>${followTable(exp, false)}</section>
  <section class="card" style="margin-top:1rem"><h2>${esc(t('winBackTitle'))}</h2><p class="muted small">${esc(t('winBackHelp'))}</p>${followTable(lapsed.slice(0, 8), true)}</section>
  <section class="card" style="margin-top:1rem"><h2>${esc(t('nextClasses'))}</h2><div class="grid cls-grid">${soon.map(occCard).join('') || empty()}</div></section>
  ${role() === 'owner' ? `<p class="foot"><button class="btn sm" data-act="reset">${esc(t('resetDemo'))}</button></p>` : ''}`;
}
function membershipCard(m, self) {
  const plan = planOf(m.planId), pct = m.planId && m.end && plan.visits == null ? Math.max(0, Math.min(100, (L.daysBetween(L.addDays(m.end, -plan.days + 1), D().today) / plan.days) * 100)) : 0;
  const frozen = m.status === 'frozen', canFreeze = (m.status === 'active' || m.status === 'expiring') && m.visitsLeft == null && m.freezeLeft >= L.FREEZE_MIN;
  return `<section class="card mcard st-${esc(m.status)}"><div class="mc-h"><div><h2>${esc(nm(m))}</h2><div class="muted" dir="ltr">${esc(m.code)}</div></div>${stPill(m.status)}</div>
  <dl class="dl"><dt>${esc(t('plan'))}</dt><dd>${esc(plan ? nm(plan) : t('noPlan'))}</dd>${m.end ? `<dt>${esc(t('period'))}</dt><dd>${esc(dt(m.start))} - ${esc(dt(m.end))}</dd><dt>${esc(t('daysLeft'))}</dt><dd>${frozen ? esc(t('pausedNow')) : m.daysLeft >= 0 ? nf(m.daysLeft) : `${esc(t('ago'))} ${nf(-m.daysLeft)}`}</dd>` : ''}${m.visitsLeft != null ? `<dt>${esc(t('visitsLeft'))}</dt><dd><b>${nf(m.visitsLeft)}</b></dd>` : ''}<dt>${esc(t('visits30'))}</dt><dd>${nf(m.visits30)}</dd>${m.strikes ? `<dt>${esc(t('strikes'))}</dt><dd>${pill(m.strikes >= L.STRIKES_BLOCK ? 'bad' : 'off', nf(m.strikes) + '/' + nf(L.STRIKES_BLOCK))}</dd>` : ''}${frozen ? `<dt>${esc(t('frozenUntil'))}</dt><dd>${esc(dt(L.addDays(m.frozenFrom, m.frozenDays - 1)))}</dd>` : ''}${m.planId && plan.visits == null ? `<dt>${esc(t('freezeLeft'))}</dt><dd>${nf(m.freezeLeft)} ${esc(t('daysShort'))}</dd>` : ''}</dl>
  ${m.planId && plan.visits == null && !frozen ? bar(pct, m.status === 'expiring' ? 'off' : '') : ''}
  ${m.status === 'grace' ? `<p class="notice">${esc(t('graceNote'))}</p>` : ''}${m.strikes >= L.STRIKES_BLOCK ? `<p class="notice bad">${esc(t('blockedNote'))}</p>` : ''}
  <div class="acts">${self ? '' : `<button class="btn sm pri" data-act="checkin-open" data-id="${esc(m.id)}">${esc(t('checkIn'))}</button>`}${frozen ? `<button class="btn sm" data-act="unfreeze" data-id="${esc(m.id)}">${esc(t('unfreeze'))}</button>` : self ? '' : `<button class="btn sm pri" data-act="sell" data-id="${esc(m.id)}">${esc(m.planId ? t('renew') : t('buyPlan'))}</button>`}${canFreeze ? `<button class="btn sm" data-act="freeze" data-id="${esc(m.id)}">${esc(t('freeze'))}</button>` : ''}${!self && role() === 'owner' && !m.cancelled ? `<button class="btn sm danger" data-act="cancel-m" data-id="${esc(m.id)}">${esc(t('cancelMembership'))}</button>` : ''}</div></section>`;
}
function dashMember() {
  const d = D(), m = d.member, mine = d.bookings.filter((b) => (b.status === 'booked' || b.status === 'waitlist') && b.date >= d.today).sort((a, b) => L.startsAt(classOf(a.classId), a.date) - L.startsAt(classOf(b.classId), b.date));
  return `<h1>${esc(t('welcomeBack'))} ${esc(nm(m).split(' ')[0])}</h1><div class="grid two">${membershipCard(m, true)}
  <section class="card"><h2>${esc(t('myBookings'))}</h2>${mine.length ? mine.map((b) => { const c = classOf(b.classId); return `<div class="mrow"><div><b>${esc(nm(c))}</b><div class="small muted">${esc(dlong(b.date))} · <span dir="ltr">${esc(hm(c.time))}</span></div></div><div>${pill(b.status === 'booked' ? '' : 'off', b.status === 'booked' ? t('youBooked') : t('onWaitlist'))} <button class="btn sm danger" data-act="cancel-booking" data-id="${esc(b.id)}" data-late="${L.startsAt(c, b.date) - d.now < L.LATE_CANCEL_MIN * 60000 && b.status === 'booked' ? 1 : 0}">${esc(t('cancel'))}</button></div></div>`; }).join('') : empty(t('noBookings'))}<p><a href="#/classes">${esc(t('nav.classes'))} →</a></p><p class="muted small">${esc(t('policy'))}</p></section></div>`;
}
function dashTrainer() {
  const d = D(), occ = occRange(L.addDays(d.today, -7), L.addDays(d.today, 7));
  const past = occ.filter((o) => o.startsAt <= d.now && d.bookings.some((b) => b.classId === o.classId && b.date === o.date && b.status === 'booked'));
  const next = occ.filter((o) => o.startsAt > d.now).slice(0, 6);
  return `<h1>${esc(t('welcomeBack'))} ${esc(nm(me()).split(' ')[0])}</h1>
  <section class="card"><h2>${esc(t('needMarks'))}</h2>${past.length ? past.map((o) => { const c = classOf(o.classId); return `<div class="mrow"><div><b>${esc(nm(c))}</b> <span class="muted small">${esc(dlong(o.date))}</span></div><a class="btn sm pri" href="#/class/${esc(c.id)}/${o.date}">${esc(t('markAtt'))}</a></div>`; }).join('') : empty(t('allMarked'))}</section>
  <section class="card" style="margin-top:1rem"><h2>${esc(t('nextClasses'))}</h2><div class="grid cls-grid">${next.map(occCard).join('') || empty()}</div></section>`;
}
const dashboard = () => (role() === 'member' ? dashMember() : role() === 'trainer' ? dashTrainer() : dashStaff());

// ----- members -----
function membersPage() {
  const d = D(), s = S.q.trim().toLowerCase(), digits = s.replace(/[٠-٩]/g, (x) => '٠١٢٣٤٥٦٧٨٩'.indexOf(x));
  let list = d.members.filter((m) => (!s || m.code.toLowerCase().includes(s) || m.name.toLowerCase().includes(s) || (m.nameAr || '').includes(s) || m.phone.includes(digits)) && (!S.stF || m.status === S.stF) && (!S.planF || m.planId === S.planF));
  const total = list.length; list = list.slice(0, 60);
  return `<div class="bar"><h1>${esc(t('nav.members'))}</h1><span class="sp"></span><button class="btn pri" data-act="add-member">${esc(t('addMember'))}</button></div>
  <div class="bar"><input data-in="q" value="${esc(S.q)}" placeholder="${esc(t('search'))}" aria-label="${esc(t('search'))}"><select data-in="stF" aria-label="${esc(t('status'))}"><option value="">${esc(t('allStatus'))}</option>${['active', 'expiring', 'grace', 'expired', 'frozen', 'cancelled', 'none'].map((x) => `<option value="${x}" ${S.stF === x ? 'selected' : ''}>${esc(t('st.' + x))}</option>`).join('')}</select><select data-in="planF" aria-label="${esc(t('plan'))}"><option value="">${esc(t('allPlans'))}</option>${d.plans.map((p) => `<option value="${p.id}" ${S.planF === p.id ? 'selected' : ''}>${esc(nm(p))}</option>`).join('')}</select><span class="muted small">${nf(total)} ${esc(t('nav.members'))}</span></div>
  <div class="tw"><table><thead><tr><th>${esc(t('member'))}</th><th>${esc(t('plan'))}</th><th>${esc(t('status'))}</th><th>${esc(t('ends'))}</th><th class="num">${esc(t('visits30'))}</th><th></th></tr></thead><tbody>${list.map((m) => `<tr><td>${mlink(m)}</td><td>${esc(m.planId ? nm(planOf(m.planId)) : '-')}${m.visitsLeft != null ? ` <small class="muted">(${nf(m.visitsLeft)})</small>` : ''}</td><td>${stPill(m.status)}</td><td>${whenEnds(m)}</td><td class="num">${nf(m.visits30)}</td><td><a class="btn sm" href="#/member/${esc(m.id)}">${esc(t('open'))}</a></td></tr>`).join('')}</tbody></table></div>${list.length ? '' : empty()}`;
}
function memberPage(id) {
  const d = D(), m = memOf(id); if (!m) return `<p class="notice bad">${esc(t('notFound'))}</p><p><a href="#/members">← ${esc(t('nav.members'))}</a></p>`;
  const pays = d.payments.filter((p) => p.memberId === m.id), lastLive = [...pays].filter((p) => !p.voided).sort((a, b) => b.at - a.at)[0];
  const ks = d.checkins.filter((k) => k.memberId === m.id), bks = d.bookings.filter((b) => b.memberId === m.id && b.status !== 'cancelled').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  return `<p><a href="#/members">← ${esc(t('nav.members'))}</a></p><div class="grid two">${membershipCard(m, false)}
  <section class="card"><h2>${esc(t('details'))}</h2><dl class="dl"><dt>${esc(t('phone'))}</dt><dd dir="ltr">${esc(m.phone)}</dd><dt>${esc(t('joined'))}</dt><dd>${esc(dt(m.joined))}</dd><dt>${esc(t('student'))}</dt><dd>${esc(m.student ? t('yes') : t('no'))}</dd><dt>${esc(t('household'))}</dt><dd>${m.householdId ? d.members.filter((o) => o.householdId === m.householdId && o.id !== m.id).map(mlink).join(', ') || '-' : '-'}</dd><dt>${esc(t('lastVisit'))}</dt><dd>${m.lastVisit ? esc(dts(m.lastVisit)) : '-'}</dd></dl>
  <div class="f"><label for="note">${esc(t('note'))}</label><textarea id="note" rows="2" maxlength="200">${esc(m.note)}</textarea></div><button class="btn sm" data-act="save-note" data-id="${esc(m.id)}">${esc(t('save'))}</button></section></div>
  <section class="card" style="margin-top:1rem"><h2>${esc(t('nav.payments'))}</h2>${pays.length ? `<div class="tw"><table><thead><tr><th>${esc(t('receipt'))}</th><th>${esc(t('date'))}</th><th>${esc(t('plan'))}</th><th class="num">${esc(t('amount'))}</th><th></th></tr></thead><tbody>${pays.map((p) => `<tr class="${p.voided ? 'void' : ''}"><td dir="ltr">${esc(p.no)}</td><td>${esc(dts(p.at))}</td><td>${esc(nm(planOf(p.planId)))} <small class="muted">${esc(dt(p.from))} - ${esc(dt(p.to))}</small></td><td class="num">${esc(money(p.amount))}${p.voided ? ' ' + pill('bad', t('voided')) : ''}</td><td><button class="btn sm" data-act="receipt" data-id="${esc(p.id)}">${esc(t('receipt'))}</button>${role() === 'owner' && lastLive && p.id === lastLive.id ? ` <button class="btn sm danger" data-act="void" data-id="${esc(p.id)}">${esc(t('void'))}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty()}</section>
  <div class="grid two" style="margin-top:1rem"><section class="card"><h2>${esc(t('recentVisits'))}</h2>${ks.length ? `<div class="tw"><table><tbody>${ks.slice(0, 8).map((k) => `<tr><td>${esc(dts(k.at))} <span dir="ltr">${esc(tm(k.at))}</span></td><td>${k.result === 'ok' ? pill('', t('ci.okShort')) : pill('bad', t('ci.why.' + k.reason))}</td></tr>`).join('')}</tbody></table></div>` : empty()}</section>
  <section class="card"><h2>${esc(t('classBookings'))}</h2>${bks.length ? `<div class="tw"><table><tbody>${bks.map((b) => `<tr><td>${esc(nm(classOf(b.classId)))}</td><td>${esc(dt(b.date))}</td><td>${pill(b.status === 'booked' ? '' : b.status === 'noshow' ? 'bad' : b.status === 'attended' ? 'ice' : 'off', t('bs.' + b.status))}</td></tr>`).join('')}</tbody></table></div>` : empty()}</section></div>`;
}

// ----- classes -----
function classesPage() {
  const d = D(), r = role(), from = r === 'member' ? d.today : L.addDays(d.today, -3), to = L.addDays(d.today, L.BOOK_AHEAD_DAYS);
  return `<h1>${esc(t('nav.classes'))}</h1><p class="muted">${esc(t('policy'))}</p>${schedule(from, to)}`;
}
function rosterPage(classId, date) {
  const d = D(), c = classOf(classId); if (!c || (d.myClassIds && !d.myClassIds.includes(classId)) || !date) return `<p class="notice bad">${esc(t('notFound'))}</p><p><a href="#/classes">← ${esc(t('nav.classes'))}</a></p>`;
  const list = d.bookings.filter((b) => b.classId === classId && b.date === date && b.status !== 'cancelled').sort((a, b) => a.at - b.at);
  const booked = list.filter((b) => b.status !== 'waitlist'), wait = list.filter((b) => b.status === 'waitlist');
  const started = L.startsAt(c, date) <= d.now, canMark = started && date <= d.today && date >= L.addDays(d.today, -7) && (role() === 'trainer' ? c.trainerId === me().id : true);
  if (canMark && (!S.marks || S.marks.key !== classId + date)) S.marks = { key: classId + date, v: Object.fromEntries(booked.map((b) => [b.id, b.status === 'booked' ? '' : b.status])) };
  const person = (b) => { const m = memOf(b.memberId) || { name: '?', code: '' }; return `${staff() ? mlink(m) : esc(nm(m)) + ` <small class="muted" dir="ltr">${esc(m.code)}</small>`}${m.note ? ` <small class="muted">· ${esc(m.note)}</small>` : ''}`; };
  return `<p><a href="#/classes">← ${esc(t('nav.classes'))}</a></p><div class="bar"><h1>${esc(nm(c))} · ${esc(dlong(date))} · <span dir="ltr">${esc(hm(c.time))}</span></h1></div><p class="muted">${esc(ar() ? c.trainerNameAr || c.trainerName : c.trainerName)} · ${esc(c.room)} · ${nf(booked.length)}/${nf(c.capacity)}${wait.length ? ` · ${nf(wait.length)} ${esc(t('waiting'))}` : ''}</p>
  <section class="card"><h2>${esc(t('booked'))}</h2>${booked.length ? booked.map((b) => `<div class="att-row"><div>${person(b)}</div><div>${canMark ? `<div class="seg" role="group"><button data-act="mark" data-id="${esc(b.id)}" data-m="attended" class="${S.marks.v[b.id] === 'attended' ? 'on P' : ''}">${esc(t('bs.attended'))}</button><button data-act="mark" data-id="${esc(b.id)}" data-m="noshow" class="${S.marks.v[b.id] === 'noshow' ? 'on A' : ''}">${esc(t('bs.noshow'))}</button></div>` : pill(b.status === 'booked' ? '' : b.status === 'noshow' ? 'bad' : 'ice', t('bs.' + b.status))}${staff() && b.status === 'booked' && !started ? ` <button class="btn sm danger" data-act="cancel-booking" data-id="${esc(b.id)}" data-late="0">${esc(t('cancel'))}</button>` : ''}</div></div>`).join('') : empty(t('noBookings'))}
  ${canMark ? `<div class="acts"><button class="btn sm" data-act="mark-all">${esc(t('allAttended'))}</button><button class="btn pri" data-act="mark-save" data-class="${esc(classId)}" data-date="${date}">${esc(t('saveAtt'))}</button></div><p class="muted small">${esc(t('markHelp'))}</p>` : ''}</section>
  ${wait.length ? `<section class="card" style="margin-top:1rem"><h2>${esc(t('waitlist'))}</h2>${wait.map((b, i) => `<div class="att-row"><div>${nf(i + 1)}. ${person(b)}</div>${staff() ? `<button class="btn sm danger" data-act="cancel-booking" data-id="${esc(b.id)}" data-late="0">${esc(t('cancel'))}</button>` : ''}</div>`).join('')}</section>` : ''}`;
}

// ----- payments, plans, reports, audit, history -----
function receiptHtml(p) {
  const d = D(), m = memOf(p.memberId) || d.member, plan = planOf(p.planId);
  return `<div class="receipt printable"><h3>${esc(nm(d.gym))}</h3><p class="c small">${esc(ar() ? d.gym.branchAr : d.gym.branch)}</p><p class="c">${esc(t('receipt'))} <span dir="ltr">${esc(p.no)}</span>${p.voided ? ' · ' + esc(t('voided')) : ''}</p><hr>
  <div class="r"><span>${esc(t('date'))}</span><span>${esc(dts(p.at))} <span dir="ltr">${esc(tm(p.at))}</span></span></div><div class="r"><span>${esc(t('member'))}</span><span>${esc(nm(m))}</span></div><div class="r"><span></span><span dir="ltr">${esc(m.code)}</span></div><hr>
  <div class="r"><span>${esc(nm(plan))}</span><span>${esc(money(p.amount + p.discount))}</span></div><div class="r"><span class="small muted">${esc(dt(p.from))} - ${esc(dt(p.to))}${p.visits ? ` · ${nf(p.visits)} ${esc(t('visitsWord'))}` : ''}</span><span></span></div>${p.discount ? `<div class="r"><span>${esc(t('householdDisc'))}</span><span>-${esc(money(p.discount))}</span></div>` : ''}<hr><div class="r tot"><span>${esc(t('total'))}</span><span>${esc(money(p.amount))}</span></div><div class="r"><span>${esc(t('method'))}</span><span>${esc(t('pm.' + p.method))}</span></div><p class="c small muted">${esc(t('receiptNote'))}</p></div>`;
}
function paymentsPage() {
  const d = D(), mine = d.payments, total = mine.filter((p) => !p.voided).reduce((s, p) => s + p.amount, 0);
  return `<div class="bar"><h1>${esc(t('nav.payments'))}</h1><span class="sp"></span><button class="btn sm" data-act="csv-pay">${esc(t('csv'))}</button></div><p class="muted">${esc(t('lastN'))} ${nf(mine.length)} · ${esc(t('total'))} ${esc(money(total))}</p>
  <div class="tw"><table><thead><tr><th>${esc(t('receipt'))}</th><th>${esc(t('date'))}</th><th>${esc(t('member'))}</th><th>${esc(t('plan'))}</th><th class="num">${esc(t('amount'))}</th><th>${esc(t('method'))}</th><th></th></tr></thead><tbody>${mine.slice(0, 80).map((p) => { const m = memOf(p.memberId); return `<tr class="${p.voided ? 'void' : ''}"><td dir="ltr">${esc(p.no)}</td><td>${esc(dts(p.at))}</td><td>${m ? mlink(m) : ''}</td><td>${esc(nm(planOf(p.planId)))}</td><td class="num">${esc(money(p.amount))}${p.voided ? ' ' + pill('bad', t('voided')) : ''}</td><td>${esc(t('pm.' + p.method))}</td><td><button class="btn sm" data-act="receipt" data-id="${esc(p.id)}">${esc(t('receipt'))}</button></td></tr>`; }).join('')}</tbody></table></div>`;
}
function plansPage() {
  const d = D();
  return `<h1>${esc(t('nav.plans'))}</h1><div class="tw"><table><thead><tr><th>${esc(t('plan'))}</th><th>${esc(t('length'))}</th><th>${esc(t('visits'))}</th><th class="num">${esc(t('price'))}</th><th></th></tr></thead><tbody>${d.plans.map((p) => `<tr><td>${esc(nm(p))}${p.studentOnly ? ' ' + pill('gray', t('studentOnly')) : ''}</td><td>${nf(p.days)} ${esc(t('daysShort'))}</td><td>${p.visits == null ? esc(t('unlimited')) : nf(p.visits)}</td><td class="num">${esc(money(p.price))}</td><td><button class="btn sm" data-act="price" data-id="${esc(p.id)}">${esc(t('editPrice'))}</button></td></tr>`).join('')}</tbody></table></div>
  <section class="card" style="margin-top:1rem"><h2>${esc(t('rulesTitle'))}</h2><ul class="rules">${['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((k) => `<li>${esc(t(k))}</li>`).join('')}</ul></section>`;
}
function reportsPage() {
  const d = D(), r = d.reports, c = r.counts, tot = Math.max(1, d.members.length), maxRev = Math.max(1, ...r.byPlan.map((x) => x.amount));
  return `<h1>${esc(t('nav.reports'))}</h1><div class="grid two"><section class="card"><h2>${esc(t('membersByStatus'))}</h2>${['active', 'expiring', 'grace', 'expired', 'frozen', 'cancelled', 'none'].map((s) => `<div class="agrow"><span>${stPill(s)}</span>${bar((c[s] / tot) * 100, stCls[s] === 'bad' ? 'bad' : stCls[s] === 'off' ? 'off' : '')}<b>${nf(c[s])}</b></div>`).join('')}</section>
  <section class="card"><h2>${esc(t('revByPlan'))} · ${esc(t('thisMonth'))}</h2>${r.byPlan.length ? r.byPlan.map((x) => `<div class="agrow"><span>${esc(nm(planOf(x.planId)))} <small class="muted">×${nf(x.count)}</small></span>${bar((x.amount / maxRev) * 100)}<b>${esc(money(x.amount))}</b></div>`).join('') : empty()}<p class="muted small">${Object.entries(r.byMethod).map(([k, v]) => `${esc(t('pm.' + k))} ${esc(money(v))}`).join(' · ')}</p></section></div>
  <div class="grid two" style="margin-top:1rem"><section class="card"><h2>${esc(t('peakHours'))}</h2>${peakChart(r.hours)}</section><section class="card"><h2>${esc(t('rev14'))}</h2>${revChart(r.series)}</section></div>
  <div class="grid two" style="margin-top:1rem"><section class="card"><h2>${esc(t('retention'))}</h2><p class="big-n">${r.retention.pct == null ? '-' : nf(r.retention.pct) + '%'}</p><p class="muted">${esc(t('retentionHelp'))}: ${nf(r.retention.renewed)}/${nf(r.retention.ended)}</p></section>
  <section class="card"><h2>${esc(t('fillRate'))}</h2>${[...new Map(r.fill.map((f) => [classOf(f.classId).name, f])).values()].length ? Object.values(r.fill.reduce((a, f) => { const c0 = classOf(f.classId); (a[c0.name] ||= { c: c0, v: [] }).v.push(f.fill); return a; }, {})).map((x) => { const avg = Math.round(x.v.reduce((s, y) => s + y, 0) / x.v.length); return `<div class="agrow"><span>${esc(nm(x.c))}</span>${bar(avg, avg >= 90 ? 'bad' : avg < 40 ? 'off' : '')}<b>${nf(avg)}%</b></div>`; }).join('') : ''}<p class="muted small">${esc(t('fillHelp'))}</p></section></div>`;
}
function auditPage() {
  return `<h1>${esc(t('nav.audit'))}</h1><div class="tw"><table><thead><tr><th>${esc(t('when'))}</th><th>${esc(t('who'))}</th><th>${esc(t('action'))}</th><th>${esc(t('detail'))}</th></tr></thead><tbody>${D().audit.map((a) => `<tr><td>${esc(dts(a.at))} <span dir="ltr">${esc(tm(a.at))}</span></td><td>${esc(a.byName)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>`;
}
function historyPage() {
  const d = D();
  return `<h1>${esc(t('nav.history'))}</h1><div class="grid two"><section class="card"><h2>${esc(t('recentVisits'))}</h2>${d.checkins.length ? `<table><tbody>${d.checkins.map((k) => `<tr><td>${esc(dts(k.at))} <span dir="ltr">${esc(tm(k.at))}</span></td><td>${k.result === 'ok' ? pill('', t('ci.okShort')) : pill('bad', t('ci.why.' + k.reason))}</td></tr>`).join('')}</tbody></table>` : empty()}</section>
  <section class="card"><h2>${esc(t('nav.payments'))}</h2>${d.payments.length ? `<table><tbody>${d.payments.map((p) => `<tr class="${p.voided ? 'void' : ''}"><td>${esc(dts(p.at))}</td><td>${esc(nm(planOf(p.planId)))}</td><td class="num">${esc(money(p.amount))}</td><td><button class="btn sm" data-act="receipt" data-id="${esc(p.id)}">${esc(t('receipt'))}</button></td></tr>`).join('')}</tbody></table>` : empty()}</section></div>`;
}

// ---------- modals ----------
function modalHtml() {
  const m = S.modal, d = D(); if (!m) return '';
  const wrap = (title, body, acts) => `<div class="modal-bg" data-act="bg"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${body}<div class="acts noprint">${acts}</div></div></div>`;
  const cancel = `<button class="btn" data-act="close">${esc(t('cancel'))}</button>`;
  const planOpts = (sel, mem) => d.plans.filter((p) => !p.studentOnly || mem?.student).map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(nm(p))} · ${esc(money(p.price))}</option>`).join('');
  const methodSel = `<select id="m-method">${L.METHODS.map((x) => `<option value="${x}">${esc(t('pm.' + x))}</option>`).join('')}</select>`;
  if (m.type === 'receipt') { const p = d.payments.find((x) => x.id === m.id); const last = role() === 'owner' && !p.voided && d.payments.filter((x) => x.memberId === p.memberId && !x.voided)[0]?.id === p.id; return wrap(t('receipt'), receiptHtml(p), `${last ? `<button class="btn danger" data-act="void" data-id="${esc(p.id)}">${esc(t('void'))}</button>` : ''}<button class="btn" data-act="print">${esc(t('print'))}</button><button class="btn pri" data-act="close">${esc(t('close'))}</button>`); }
  if (m.type === 'sell') {
    const mem = memOf(m.id); let q = null, err = '';
    try { q = L.quote({ plans: d.plans, members: d.members }, mem, m.planId, d.today); } catch (e) { err = errText(e.message); }
    return wrap(mem.planId ? t('renew') : t('buyPlan'), `<p><b>${esc(nm(mem))}</b> <small class="muted" dir="ltr">${esc(mem.code)}</small></p>${field('m-plan', t('plan'), `<select id="m-plan" data-in="m-plan">${planOpts(m.planId, mem)}</select>`)}${field('m-method', t('method'), methodSel)}
    ${q ? `<div class="quote"><div class="r"><span>${esc(t('price'))}</span><span>${esc(money(q.plan.price))}</span></div>${q.discount ? `<div class="r"><span>${esc(t('householdDisc'))}</span><span>-${esc(money(q.discount))}</span></div>` : ''}<div class="r tot"><span>${esc(t('total'))}</span><span>${esc(money(q.price))}</span></div><div class="r"><span>${esc(t('period'))}</span><span>${esc(dt(q.start))} - ${esc(dt(q.end))}</span></div>${q.visitsLeft != null ? `<div class="r"><span>${esc(t('visitsLeft'))}</span><span>${nf(q.visitsLeft)}</span></div>` : ''}<p class="muted small">${esc(q.running ? t('quoteStack') : t('quoteToday'))}</p></div>` : `<p class="notice bad">${esc(err)}</p>`}`,
      `${cancel}<button class="btn pri" data-act="sell-go" ${q ? '' : 'disabled'}>${esc(t('confirmPay'))}</button>`);
  }
  if (m.type === 'member') return wrap(t('addMember'), `${field('n-name', t('name'), '<input id="n-name" maxlength="60" autocomplete="off">')}${field('n-nameAr', t('nameAr'), '<input id="n-nameAr" maxlength="60" dir="rtl" autocomplete="off">')}${field('n-phone', t('phone'), '<input id="n-phone" inputmode="tel" dir="ltr" maxlength="14" placeholder="01012345678" autocomplete="off">')}
    <label class="chk"><input type="checkbox" id="n-student"> ${esc(t('student'))}</label>${field('n-house', t('householdCode'), '<input id="n-house" dir="ltr" placeholder="LQ-0007" autocomplete="off">', t('householdHelp'))}
    ${field('n-plan', t('firstPlan'), `<select id="n-plan"><option value="">${esc(t('noPlanYet'))}</option>${d.plans.map((p) => `<option value="${p.id}">${esc(nm(p))} · ${esc(money(p.price))}</option>`).join('')}</select>`)}${field('m-method', t('method'), methodSel)}`, `${cancel}<button class="btn pri" data-act="member-go">${esc(t('save'))}</button>`);
  if (m.type === 'freeze') { const mem = memOf(m.id); return wrap(t('freeze'), `<p>${esc(t('freezeHelp'))}</p>${field('f-days', t('freezeDays'), `<input id="f-days" type="number" min="${L.FREEZE_MIN}" max="${Math.min(L.FREEZE_MAX, mem?.freezeLeft ?? L.FREEZE_MAX)}" value="${Math.min(14, mem?.freezeLeft ?? 14)}">`, `${t('freezeLeft')}: ${nf(mem?.freezeLeft ?? 0)}`)}`, `${cancel}<button class="btn pri" data-act="freeze-go">${esc(t('freeze'))}</button>`); }
  if (m.type === 'cancelM') return wrap(t('cancelMembership'), `<p>${esc(t('cancelHelp'))}</p>${field('c-reason', t('reason'), '<input id="c-reason" maxlength="120">')}`, `${cancel}<button class="btn danger" data-act="cancelm-go">${esc(t('cancelMembership'))}</button>`);
  if (m.type === 'void') return wrap(t('void'), `<p>${esc(t('voidHelp'))}</p>${field('v-reason', t('reason'), '<input id="v-reason" maxlength="120">')}`, `${cancel}<button class="btn danger" data-act="void-go">${esc(t('void'))}</button>`);
  if (m.type === 'price') { const p = planOf(m.id); return wrap(t('editPrice') + ': ' + nm(p), `${field('p-price', t('price') + ' (' + t('cur') + ')', `<input id="p-price" inputmode="decimal" value="${p.price / 100}">`, t('priceHelp'))}`, `${cancel}<button class="btn pri" data-act="price-go">${esc(t('save'))}</button>`); }
  if (m.type === 'book') {
    const c = classOf(m.classId);
    return wrap(`${t('book')}: ${nm(c)} · ${dlong(m.date)}`, `${field('bk-q', t('ci.find'), `<input id="bk-q" data-in="bkq" autocomplete="off" placeholder="${esc(t('ci.ph'))}">`)}<div id="bk-res"></div>`, cancel);
  }
  return '';
}
const bkResults = (q) => { const r = matches(q); return r.map((m) => `<div class="mrow"><div>${mlink(m)}</div><div>${stPill(m.status)} <button class="btn sm pri" data-act="book-go" data-id="${esc(m.id)}">${esc(t('book'))}</button></div></div>`).join('') || (q.trim() ? empty(t('noMatch')) : ''); };

// ---------- render ----------
function page() {
  const r = route(), p = r.p;
  switch (p) {
    case 'checkin': return checkinPage();
    case 'members': return membersPage();
    case 'member': return memberPage(r.a);
    case 'classes': return classesPage();
    case 'class': return rosterPage(r.a, r.b);
    case 'payments': return paymentsPage();
    case 'plans': return plansPage();
    case 'reports': return reportsPage();
    case 'audit': return auditPage();
    case 'history': return historyPage();
    default: return dashboard();
  }
}
function render() {
  const root = $('#app'); document.documentElement.lang = S.lang; document.documentElement.dir = T[S.lang].dir; document.title = `${t('appName')} | ${t('appSub')}`;
  if (!S.token || !S.data) { root.innerHTML = loginPage(); return; }
  const rp = route().p, ok = NAV[role()].includes(rp) || (rp === 'member' && staff()) || (rp === 'class' && role() !== 'member');
  root.innerHTML = `${top()}<main>${S.err ? `<p class="notice bad">${esc(S.err)}</p>` : ''}${ok ? page() : dashboard()}</main><div id="modal">${modalHtml()}</div>`;
}
const csvDownload = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.append(a); a.click(); a.remove(); };

// ---------- events ----------
document.addEventListener('submit', (e) => { const f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault(); if (f.dataset.form === 'login') login($('#pin').value.trim()); });
document.addEventListener('input', (e) => {
  const k = e.target.dataset?.in; if (!k) return;
  if (k === 'ciq') { S.ciq = e.target.value; $('#ci-res').innerHTML = resultsHtml(S.ciq); }
  else if (k === 'bkq') $('#bk-res').innerHTML = bkResults(e.target.value);
  else if (k === 'q') { S.q = e.target.value; const pos = e.target.selectionStart; render(); const el = $('[data-in=q]'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
});
document.addEventListener('change', (e) => {
  const k = e.target.dataset?.in; if (!k) return; const v = e.target.value;
  if (k === 'stF') S.stF = v; else if (k === 'planF') S.planF = v; else if (k === 'm-plan') { S.modal.planId = v; } else return;
  render();
});
document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape' && S.modal) { S.modal = null; render(); return; }
  if (e.key === 'Enter' && e.target.id === 'ci-q') {
    e.preventDefault(); const q = S.ciq.trim().toUpperCase(), r = matches(S.ciq);
    const hit = r.find((m) => m.code === q) || (r.length === 1 ? r[0] : null);
    if (hit) doCheckin(hit.id); else if (q) toast(t('ci.pick'), true);
  }
});
async function doCheckin(id) {
  const res = await act({ type: 'checkIn', memberId: id }); if (!res) return;
  S.ci = { res, memberId: id }; S.ciq = ''; render(); $('#ci-q')?.focus();
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return; const a = el.dataset.act, id = el.dataset.id;
  if (a === 'bg') { if (e.target === el) { S.modal = null; render(); } return; }
  const done = async (op, msg, after) => { const r = await act(op, msg); if (r) { S.modal = null; after && after(r); render(); } return r; };
  switch (a) {
    case 'lang': S.lang = S.lang === 'en' ? 'ar' : 'en'; LS.set('lang', S.lang); return render();
    case 'logout': return logout();
    case 'demo': return login(el.dataset.pin);
    case 'close': S.modal = null; return render();
    case 'print': return window.print();
    case 'reset': if (confirm(t('resetAsk'))) { const r = await act({ type: 'reset' }, t('resetDone')); if (r) { S.ci = null; render(); } } return;
    case 'checkin': return doCheckin(id);
    case 'checkin-open': await doCheckin(id); location.hash = '#/checkin'; return;
    case 'receipt': S.modal = { type: 'receipt', id }; return render();
    case 'sell': { const mem = memOf(id); S.modal = { type: 'sell', id, planId: mem.planId || 'pl1', req: rid() }; return render(); }
    case 'sell-go': return done({ type: 'sellPlan', memberId: S.modal.id, planId: S.modal.planId, method: val('m-method'), reqId: S.modal.req }, null, (r) => { toast(r.duplicate ? t('dup') : t('sold')); if (S.ci) S.ci = null; });
    case 'add-member': S.modal = { type: 'member' }; return render();
    case 'member-go': {
      const code = val('n-house').trim().toUpperCase(), other = code ? D().members.find((x) => x.code === code) : null;
      if (code && !other) return toast(t('noMatch'), true);
      return done({ type: 'addMember', name: val('n-name'), nameAr: val('n-nameAr'), phone: val('n-phone'), student: $('#n-student').checked, householdWith: other?.id, planId: val('n-plan') || undefined, method: val('m-method') }, t('saved'), (r) => { location.hash = '#/member/' + r.id; });
    }
    case 'freeze': S.modal = { type: 'freeze', id }; return render();
    case 'freeze-go': return done({ type: 'freeze', memberId: S.modal.id, days: Number(val('f-days')) }, t('saved'));
    case 'unfreeze': return done({ type: 'unfreeze', memberId: id }, t('saved'), () => { S.ci = null; });
    case 'cancel-m': S.modal = { type: 'cancelM', id }; return render();
    case 'cancelm-go': return done({ type: 'cancelMembership', memberId: S.modal.id, reason: val('c-reason') }, t('saved'));
    case 'void': S.modal = { type: 'void', id }; return render();
    case 'void-go': return done({ type: 'voidPayment', paymentId: S.modal.id, reason: val('v-reason') }, t('saved'));
    case 'price': S.modal = { type: 'price', id }; return render();
    case 'price-go': { const price = toCents(val('p-price')); return done({ type: 'setPlanPrice', planId: S.modal.id, price }, t('saved')); }
    case 'save-note': { const r = await act({ type: 'setNote', memberId: id, note: val('note') }, t('saved')); if (r) render(); return; }
    case 'book-self': { const r = await act({ type: 'book', classId: el.dataset.class, date: el.dataset.date }, null); if (r) { toast(r.status === 'waitlist' ? `${t('onWaitlist')} #${nf(r.position)}` : t('booked1')); render(); } return; }
    case 'book-for': S.modal = { type: 'book', classId: el.dataset.class, date: el.dataset.date }; return render();
    case 'book-go': { const m = S.modal; const r = await act({ type: 'book', memberId: id, classId: m.classId, date: m.date }); if (r) { S.modal = null; toast(r.status === 'waitlist' ? `${t('onWaitlist')} #${nf(r.position)}` : t('booked1')); render(); } return; }
    case 'cancel-booking': {
      if (el.dataset.late === '1' && !confirm(t('lateWarn'))) return;
      const r = await act({ type: 'cancelBooking', bookingId: id }); if (r) { toast(r.late ? t('lateDone') : t('cancelled1')); render(); } return;
    }
    case 'mark': S.marks.v[id] = el.dataset.m; return render();
    case 'mark-all': for (const k of Object.keys(S.marks.v)) if (!S.marks.v[k]) S.marks.v[k] = 'attended'; return render();
    case 'mark-save': { const marks = Object.fromEntries(Object.entries(S.marks.v).filter(([, v]) => v)); const r = await act({ type: 'markClass', classId: el.dataset.class, date: el.dataset.date, marks }, t('saved')); if (r) { S.marks = null; render(); } return; }
    case 'csv-follow': return csvDownload('follow-up.csv', L.followUpCsv(D()));
    case 'csv-pay': return csvDownload('receipts.csv', L.paymentsCsv(D()));
  }
});
addEventListener('hashchange', () => { S.modal = null; S.marks = null; S.ciq = ''; if (route().p !== 'checkin') S.ci = null; render(); window.scrollTo(0, 0); });

(async function boot() {
  if (S.token) await refresh(); else render();
  if (S.token && !S.data) { LS.del('token'); S.token = null; }
  render();
})();
