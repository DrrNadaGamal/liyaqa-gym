// Liyaqa business rules. Pure functions, no I/O: the API, the browser app and the tests all import this file.
// All money is stored in piasters (1 EGP = 100) as integers, so totals never drift.

export class UserError extends Error {}
const bad = (m) => { throw new UserError(m); };

export const TZ = 'Africa/Cairo';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const dayKey = (t) => dayFmt.format(new Date(t));
const utc = (k) => Date.parse(k + 'T00:00:00Z');
export const addDays = (k, n) => new Date(utc(k) + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
export const dow = (k) => new Date(utc(k)).getUTCDay(); // 0 = Sunday ... 6 = Saturday
export const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5]; // the gym week starts on Saturday
const validDate = (k) => /^\d{4}-\d{2}-\d{2}$/.test(String(k)) && addDays(k, 0) === k;
export const monthKey = (t) => dayKey(t).slice(0, 7);

// Cairo wall-clock time to an epoch, correct on both sides of a daylight-saving change.
function tzOffset(t) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000;
}
export function localToEpoch(day, hhmm) {
  const guess = Date.parse(`${day}T${hhmm}:00Z`);
  let t = guess - tzOffset(guess);
  t = guess - tzOffset(t);
  return t;
}
export const hourOf = (t) => Number(partsFmt.formatToParts(new Date(t)).find((x) => x.type === 'hour').value);

export const egp = (c) => (c / 100).toFixed(2);
const isInt = (n) => Number.isInteger(n);
const clean = (s, max = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const pad = (n, w = 4) => String(n).padStart(w, '0');

export const ROLES = { owner: 'owner', desk: 'desk', trainer: 'trainer', member: 'member' };
export const METHODS = ['cash', 'card', 'transfer'];
export const EXPIRING_DAYS = 7;       // "expiring" means the membership ends within 7 days
export const GRACE_DAYS = 2;          // unlimited plans may still enter for 2 days after the end date, with a warning
export const DUP_CHECKIN_MIN = 120;   // a second scan within 2 hours is not counted again
export const HOUSEHOLD_PCT = 10;      // 10% off for a second person of the same household (not on visit packs)
export const FREEZE_MIN = 7, FREEZE_MAX = 30, FREEZE_YEAR_CAP = 30;
export const BOOK_AHEAD_DAYS = 7;
export const LATE_CANCEL_MIN = 120;   // cancelling less than 2 hours before the start is a late cancel
export const STRIKES_BLOCK = 3;       // 3 no-shows or late cancels in 30 days pause booking
export const STRIKE_WINDOW_DAYS = 30;
export const WAITLIST_MAX = 5;
export const PHONE_RE = /^01[0125]\d{8}$/;

const need = (user, ...roles) => { if (!roles.includes(user.role)) throw new UserError('You do not have permission to do this'); };
const nextId = (state, p) => { state.seq[p] = (state.seq[p] || 0) + 1; return p + state.seq[p]; };
const audit = (state, user, now, action, detail) => { state.audit.push({ at: now, by: user.id, byName: user.name, action, detail: clean(detail, 160) }); };
export const byId = (list, id) => list.find((x) => x.id === id);

// ---------- membership status ----------
export function statusOf(m, today) {
  if (m.cancelled) return 'cancelled';
  if (m.frozenFrom) return 'frozen';
  if (!m.planId) return 'none';
  if (m.visitsLeft != null && m.visitsLeft <= 0) return 'expired';
  if (m.end < today) return m.visitsLeft == null && daysBetween(m.end, today) <= GRACE_DAYS ? 'grace' : 'expired';
  if (daysBetween(today, m.end) <= EXPIRING_DAYS) return 'expiring';
  return 'active';
}
export const isLive = (s) => s === 'active' || s === 'expiring';
export const freezeUsed = (m, today) => (m.freezes || []).filter((f) => f.from > addDays(today, -365)).reduce((s, f) => s + f.days, 0);
export const freezeLeft = (m, today) => Math.max(0, FREEZE_YEAR_CAP - freezeUsed(m, today));
export const strikes = (state, memberId, today) => state.bookings.filter((b) => b.memberId === memberId && b.date >= addDays(today, -STRIKE_WINDOW_DAYS) && (b.status === 'noshow' || (b.status === 'cancelled' && b.late))).length;

// Starts every request: ends freezes whose planned days are over and moves the end date by the frozen days.
export function normalize(state, now) {
  const today = dayKey(now);
  for (const m of state.members) {
    if (m.frozenFrom && today >= addDays(m.frozenFrom, m.frozenDays)) {
      m.end = addDays(m.end, m.frozenDays); m.frozenFrom = null; m.frozenDays = 0;
    }
  }
}

// ---------- selling and renewing ----------
export function quote(state, m, planId, today) {
  const plan = byId(state.plans, planId);
  if (!plan || plan.archived) bad('Pick a plan');
  if (plan.studentOnly && !m.student) bad('This plan is for students. Mark the member as a student first');
  const st = statusOf(m, today);
  if (st === 'frozen') bad('Unfreeze the membership before renewing');
  let price = plan.price, discount = 0;
  const mate = plan.visits == null && m.householdId && state.members.some((o) => o.id !== m.id && o.householdId === m.householdId && !o.cancelled && o.planId && o.end >= addDays(today, -30));
  if (mate) { discount = Math.round((price * HOUSEHOLD_PCT) / 100); price -= discount; }
  // A membership that is still running continues after its end date. A lapsed or new one starts today.
  const running = (st === 'active' || st === 'expiring') && m.end >= today;
  const samePlanKind = running && (plan.visits == null) === (m.visitsLeft == null);
  const start = samePlanKind ? addDays(m.end, 1) : today;
  const end = addDays(start, plan.days - 1);
  const visitsLeft = plan.visits == null ? null : (samePlanKind ? (m.visitsLeft || 0) : 0) + plan.visits;
  return { plan, price, discount, start, end, visitsLeft, running: samePlanKind };
}

function sell(state, m, planId, method, ctx, kind) {
  const { user, now } = ctx, today = dayKey(now);
  if (!METHODS.includes(method)) bad('Pick how it was paid');
  const q = quote(state, m, planId, today);
  const before = { planId: m.planId, start: m.start, end: m.end, visitsLeft: m.visitsLeft ?? null, cancelled: !!m.cancelled };
  if (q.running) { m.end = q.end; } else { m.start = q.start; m.end = q.end; }
  m.planId = planId; m.visitsLeft = q.visitsLeft; m.cancelled = false;
  const p = { id: nextId(state, 'p'), no: 'R-' + pad(state.seq.receipt = (state.seq.receipt || 0) + 1, 6), memberId: m.id, planId, amount: q.price, discount: q.discount, method, at: now, by: user.id, byName: user.name, from: q.start, to: q.end, visits: q.plan.visits, kind, before, after: { end: m.end, visitsLeft: m.visitsLeft ?? null } };
  state.payments.push(p);
  audit(state, user, now, kind === 'signup' ? 'New membership' : 'Renewal', `${m.code} ${m.name}, ${q.plan.name}, ${egp(q.price)} EGP`);
  return p;
}

// ---------- classes ----------
export const startsAt = (c, date) => localToEpoch(date, c.time);
export const classCounts = (state, classId, date) => {
  const list = state.bookings.filter((b) => b.classId === classId && b.date === date);
  return { booked: list.filter((b) => b.status === 'booked' || b.status === 'attended' || b.status === 'noshow').length, waitlist: list.filter((b) => b.status === 'waitlist').length };
};
function bookingBlock(state, m, c, date, now) {
  const today = dayKey(now), st = statusOf(m, today);
  if (st === 'cancelled') return 'This membership is cancelled';
  if (st === 'none') return 'No membership yet. Buy a plan first';
  if (st === 'frozen') return 'The membership is frozen';
  if (st === 'expired' || st === 'grace') return 'The membership has ended. Renew first';
  if (m.end < date) return 'The membership ends before this class. Renew first';
  if (m.visitsLeft != null && m.visitsLeft <= 0) return 'No visits left on this plan';
  if (strikes(state, m.id, today) >= STRIKES_BLOCK) return 'Booking is paused: 3 no-shows or late cancels in the last 30 days';
  const clash = state.bookings.find((b) => b.memberId === m.id && b.date === date && b.status !== 'cancelled' && b.classId !== c.id && byId(state.classes, b.classId)?.time === c.time);
  if (clash) return 'Already booked into another class at the same time';
  return null;
}

// ---------- operations ----------
export function applyOp(state, op, ctx) {
  const { user, now } = ctx, today = dayKey(now);
  const mem = (id) => byId(state.members, id) || bad('Member not found');
  const selfMember = () => (user.memberId ? mem(user.memberId) : bad('No member profile on this account'));
  switch (op.type) {
    case 'addMember': {
      need(user, 'owner', 'desk');
      const name = clean(op.name, 60); if (name.length < 2) bad('Enter the name');
      const phone = String(op.phone || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
      if (!PHONE_RE.test(phone)) bad('Phone must be an Egyptian mobile number like 01012345678');
      if (state.members.some((m) => m.phone === phone)) bad('A member with this phone number already exists');
      const m = { id: nextId(state, 'm'), code: 'LQ-' + pad(state.seq.code = (state.seq.code || 0) + 1), name, nameAr: clean(op.nameAr, 60) || '', phone, joined: today, student: !!op.student, householdId: null, planId: null, start: null, end: null, visitsLeft: null, cancelled: false, frozenFrom: null, frozenDays: 0, freezes: [], note: '' };
      if (op.householdWith) { const o = mem(op.householdWith); o.householdId = o.householdId || nextId(state, 'h'); m.householdId = o.householdId; }
      state.members.push(m);
      audit(state, user, now, 'Member added', `${m.code} ${m.name}`);
      let payment = null;
      if (op.planId) payment = sell(state, m, op.planId, op.method, ctx, 'signup');
      return { id: m.id, payment: payment && payment.id };
    }
    case 'sellPlan': {
      need(user, 'owner', 'desk');
      if (op.reqId) { const dup = state.payments.find((p) => p.reqId === op.reqId); if (dup) return { id: dup.id, duplicate: true }; }
      const m = mem(op.memberId);
      const kind = m.planId ? 'renewal' : 'signup';
      const p = sell(state, m, op.planId, op.method, ctx, kind);
      if (op.reqId) p.reqId = String(op.reqId).slice(0, 40);
      return { id: p.id };
    }
    case 'voidPayment': {
      need(user, 'owner');
      const p = byId(state.payments, op.paymentId) || bad('Payment not found');
      const reason = clean(op.reason, 120); if (reason.length < 3) bad('Write a short reason');
      if (p.voided) bad('Already voided');
      const mine = state.payments.filter((x) => x.memberId === p.memberId && !x.voided);
      if (mine[mine.length - 1].id !== p.id) bad('Only the latest payment of a member can be voided');
      const m = mem(p.memberId);
      if (m.end !== p.after.end || (m.visitsLeft ?? null) !== p.after.visitsLeft || m.frozenFrom) bad('The membership changed after this payment (freeze, visits used). It cannot be voided');
      Object.assign(m, { planId: p.before.planId, start: p.before.start, end: p.before.end, visitsLeft: p.before.visitsLeft, cancelled: p.before.cancelled });
      p.voided = { at: now, by: user.id, reason };
      audit(state, user, now, 'Payment voided', `${p.no} ${m.code} ${egp(p.amount)} EGP: ${reason}`);
      return { id: p.id };
    }
    case 'checkIn': {
      need(user, 'owner', 'desk');
      const m = op.memberId ? mem(op.memberId) : state.members.find((x) => x.code === String(op.code || '').trim().toUpperCase()) || bad('No member with this code');
      const st = statusOf(m, today);
      const log = (result, reason) => { state.checkins.push({ id: nextId(state, 'k'), memberId: m.id, at: now, by: user.id, result, reason: reason || null }); };
      const recent = state.checkins.find((k) => k.memberId === m.id && k.result === 'ok' && now - k.at < DUP_CHECKIN_MIN * 60000);
      if (recent && (st === 'active' || st === 'expiring' || st === 'grace')) return { ok: true, duplicate: true, status: st, memberId: m.id, at: recent.at };
      const deny = (reason) => { log('denied', reason); return { ok: false, reason, status: st, memberId: m.id }; };
      if (st === 'cancelled') return deny('cancelled');
      if (st === 'none') return deny('none');
      if (st === 'frozen') return deny('frozen');
      if (st === 'expired') return deny(m.visitsLeft != null && m.visitsLeft <= 0 ? 'novisits' : 'expired');
      const warn = st === 'grace' ? 'grace' : st === 'expiring' ? 'expiring' : null;
      if (m.visitsLeft != null) m.visitsLeft -= 1;
      log('ok', warn);
      return { ok: true, status: st, warn, memberId: m.id, daysLeft: daysBetween(today, m.end), visitsLeft: m.visitsLeft };
    }
    case 'freeze': {
      need(user, 'owner', 'desk', 'member');
      const m = user.role === 'member' ? selfMember() : mem(op.memberId);
      const days = op.days; if (!isInt(days) || days < FREEZE_MIN || days > FREEZE_MAX) bad(`Freeze for ${FREEZE_MIN} to ${FREEZE_MAX} days`);
      const st = statusOf(m, today);
      if (!isLive(st)) bad('Only a running membership can be frozen');
      if (m.visitsLeft != null) bad('Visit packs cannot be frozen');
      if (days > freezeLeft(m, today)) bad(`Only ${freezeLeft(m, today)} freeze days left in the last 12 months`);
      const future = state.bookings.filter((b) => b.memberId === m.id && b.date >= today && (b.status === 'booked' || b.status === 'waitlist'));
      m.frozenFrom = today; m.frozenDays = days; m.freezes.push({ from: today, days });
      for (const b of future) cancelBooking(state, b, ctx, true);
      audit(state, user, now, 'Freeze', `${m.code} ${m.name}, ${days} days`);
      return { id: m.id, cancelledBookings: future.length };
    }
    case 'unfreeze': {
      need(user, 'owner', 'desk', 'member');
      const m = user.role === 'member' ? selfMember() : mem(op.memberId);
      if (!m.frozenFrom) bad('This membership is not frozen');
      const used = Math.min(m.frozenDays, Math.max(0, daysBetween(m.frozenFrom, today)));
      m.end = addDays(m.end, used);
      const f = m.freezes[m.freezes.length - 1]; if (f && f.from === m.frozenFrom) f.days = used;
      m.frozenFrom = null; m.frozenDays = 0;
      audit(state, user, now, 'Unfreeze', `${m.code} ${m.name}, ${used} days used`);
      return { id: m.id, used };
    }
    case 'cancelMembership': {
      need(user, 'owner');
      const m = mem(op.memberId); const reason = clean(op.reason, 120); if (reason.length < 3) bad('Write a short reason');
      if (m.cancelled) bad('Already cancelled');
      m.cancelled = true; m.frozenFrom = null; m.frozenDays = 0;
      for (const b of state.bookings.filter((b) => b.memberId === m.id && b.date >= today && (b.status === 'booked' || b.status === 'waitlist'))) cancelBooking(state, b, ctx, true);
      audit(state, user, now, 'Membership cancelled', `${m.code} ${m.name}: ${reason}`);
      return { id: m.id };
    }
    case 'setNote': {
      need(user, 'owner', 'desk', 'trainer');
      const m = mem(op.memberId); m.note = clean(op.note, 200);
      audit(state, user, now, 'Note', `${m.code}`);
      return { id: m.id };
    }
    case 'setPlanPrice': {
      need(user, 'owner');
      const plan = byId(state.plans, op.planId) || bad('Plan not found');
      const price = op.price; if (!isInt(price) || price < 5000 || price > 5000000) bad('Price must be between 50 and 50,000 EGP');
      const old = plan.price; plan.price = price;
      audit(state, user, now, 'Plan price', `${plan.name}: ${egp(old)} to ${egp(price)} EGP. Existing memberships keep what they paid`);
      return { id: plan.id };
    }
    case 'book': {
      need(user, 'owner', 'desk', 'member');
      const m = user.role === 'member' ? selfMember() : mem(op.memberId);
      const c = byId(state.classes, op.classId) || bad('Class not found');
      const date = op.date; if (!validDate(date)) bad('Pick a date');
      if (dow(date) !== c.dow) bad('This class does not run on that day');
      if (date > addDays(today, BOOK_AHEAD_DAYS)) bad(`Booking opens ${BOOK_AHEAD_DAYS} days ahead`);
      if (startsAt(c, date) <= now) bad('This class has already started');
      const have = state.bookings.find((b) => b.memberId === m.id && b.classId === c.id && b.date === date && b.status !== 'cancelled');
      if (have) bad(have.status === 'waitlist' ? 'Already on the waitlist' : 'Already booked');
      const block = bookingBlock(state, m, c, date, now); if (block) bad(block);
      const { booked, waitlist } = classCounts(state, c.id, date);
      let status = 'booked';
      if (booked >= c.capacity) { if (waitlist >= WAITLIST_MAX) bad('The class and its waitlist are full'); status = 'waitlist'; }
      const b = { id: nextId(state, 'b'), classId: c.id, date, memberId: m.id, status, at: now, by: user.id };
      state.bookings.push(b);
      audit(state, user, now, status === 'booked' ? 'Booked' : 'Waitlisted', `${m.code} ${c.name} ${date}`);
      return { id: b.id, status, position: status === 'waitlist' ? waitlist + 1 : null };
    }
    case 'cancelBooking': {
      need(user, 'owner', 'desk', 'member');
      const b = byId(state.bookings, op.bookingId) || bad('Booking not found');
      if (user.role === 'member' && b.memberId !== user.memberId) bad('You do not have permission to do this');
      if (b.status !== 'booked' && b.status !== 'waitlist') bad('This booking cannot be cancelled');
      const c = byId(state.classes, b.classId);
      if (startsAt(c, b.date) <= now) bad('This class has already started');
      return cancelBooking(state, b, ctx, false);
    }
    case 'markClass': {
      need(user, 'owner', 'desk', 'trainer');
      const c = byId(state.classes, op.classId) || bad('Class not found');
      if (user.role === 'trainer' && c.trainerId !== user.id) bad('You do not have permission to do this');
      const date = op.date; if (!validDate(date) || dow(date) !== c.dow) bad('Pick a date this class runs on');
      if (date > today || date < addDays(today, -7)) bad('Attendance can be marked from 7 days ago up to today');
      if (date === today && startsAt(c, date) > now) bad('This class has not started yet');
      let n = 0;
      for (const [id, v] of Object.entries(op.marks || {})) {
        const b = state.bookings.find((x) => x.id === id && x.classId === c.id && x.date === date);
        if (!b || !['booked', 'attended', 'noshow'].includes(b.status)) continue;
        if (v !== 'attended' && v !== 'noshow') bad('Bad mark');
        b.status = v; n++;
      }
      for (const b of state.bookings.filter((x) => x.classId === c.id && x.date === date && x.status === 'waitlist')) b.status = 'cancelled';
      audit(state, user, now, 'Attendance', `${c.name} ${date}: ${n} marked`);
      return { marked: n };
    }
    default: bad('Unknown action');
  }
}

function cancelBooking(state, b, ctx, system) {
  const { user, now } = ctx;
  const c = byId(state.classes, b.classId), wasBooked = b.status === 'booked';
  const late = !system && wasBooked && startsAt(c, b.date) - now < LATE_CANCEL_MIN * 60000;
  b.status = 'cancelled'; b.late = late || undefined; b.cancelledAt = now;
  let promoted = null;
  if (wasBooked) {
    const { booked } = classCounts(state, c.id, b.date);
    if (booked < c.capacity) {
      const waiting = state.bookings.filter((x) => x.classId === c.id && x.date === b.date && x.status === 'waitlist').sort((a, z) => a.at - z.at);
      for (const w of waiting) {
        const m = byId(state.members, w.memberId);
        if (m && !bookingBlock(state, m, c, b.date, now)) { w.status = 'booked'; w.promotedAt = now; promoted = w.memberId; break; }
        w.status = 'cancelled';
      }
    }
  }
  if (!system) audit(state, user, now, late ? 'Late cancel' : 'Cancelled booking', `${byId(state.members, b.memberId)?.code} ${c.name} ${b.date}`);
  return { id: b.id, late, promoted };
}

// ---------- read side ----------
export function enrich(state, m, today) {
  const status = statusOf(m, today);
  const plan = byId(state.plans, m.planId);
  const last30 = addDays(today, -30);
  return { ...m, status, planName: plan?.name || null, planNameAr: plan?.nameAr || null, daysLeft: m.end ? daysBetween(today, m.end) : null,
    visits30: state.checkins.filter((k) => k.memberId === m.id && k.result === 'ok' && dayKey(k.at) >= last30).length,
    lastVisit: state.checkins.reduce((a, k) => (k.memberId === m.id && k.result === 'ok' && k.at > a ? k.at : a), 0) || null,
    freezeLeft: freezeLeft(m, today), strikes: strikes(state, m.id, today) };
}

export function occurrences(state, today, days = BOOK_AHEAD_DAYS) {
  const out = [];
  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    for (const c of state.classes.filter((x) => x.dow === dow(date))) out.push({ classId: c.id, date, startsAt: startsAt(c, date), ...classCounts(state, c.id, date) });
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}

export function reports(state, now) {
  const today = dayKey(now), month = today.slice(0, 7);
  const pays = state.payments.filter((p) => !p.voided);
  const rev = (list) => list.reduce((s, p) => s + p.amount, 0);
  const thisMonth = pays.filter((p) => monthKey(p.at) === month);
  const series = [];
  for (let i = 13; i >= 0; i--) { const d = addDays(today, -i); series.push({ day: d, amount: rev(pays.filter((p) => dayKey(p.at) === d)) }); }
  const byPlan = state.plans.map((pl) => ({ planId: pl.id, count: thisMonth.filter((p) => p.planId === pl.id).length, amount: rev(thisMonth.filter((p) => p.planId === pl.id)) })).filter((x) => x.count);
  const byMethod = {}; for (const p of thisMonth) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
  const hours = Array(24).fill(0), since = addDays(today, -13);
  for (const k of state.checkins) if (k.result === 'ok' && dayKey(k.at) >= since) hours[hourOf(k.at)]++;
  const ms = state.members.map((m) => enrich(state, m, today));
  const count = (s) => ms.filter((m) => m.status === s).length;
  const win = pays.filter((p) => p.visits == null && p.to < today && p.to >= addDays(today, -60));
  const renewed = win.filter((p) => pays.some((q) => q.memberId === p.memberId && q.at > p.at)).length;
  const opens = occurrences(state, today, 6);
  const fill = state.classes.map((c) => { const o = opens.filter((x) => x.classId === c.id); const cap = o.length * c.capacity; return { classId: c.id, fill: cap ? Math.round((o.reduce((s, x) => s + Math.min(x.booked, c.capacity), 0) / cap) * 100) : 0 }; });
  const dayStart = (d) => localToEpoch(d, '00:00');
  return {
    counts: { active: count('active'), expiring: count('expiring'), grace: count('grace'), expired: count('expired'), frozen: count('frozen'), cancelled: count('cancelled'), none: count('none') },
    revenueMonth: rev(thisMonth), revenueToday: rev(pays.filter((p) => dayKey(p.at) === today)), series, byPlan, byMethod, hours,
    checkinsToday: new Set(state.checkins.filter((k) => k.result === 'ok' && k.at >= dayStart(today)).map((k) => k.memberId)).size,
    deniedToday: state.checkins.filter((k) => k.result === 'denied' && k.at >= dayStart(today)).length,
    retention: { ended: win.length, renewed, pct: win.length ? Math.round((renewed / win.length) * 100) : null },
    fill,
  };
}

export const announceStaff = ['owner', 'desk', 'trainer'];
export function view(state, user0, now) {
  normalize(state, now);
  const today = dayKey(now), user = state.users.find((u) => u.id === user0.id) || user0;
  const base = { now, today, gym: state.gym, plans: state.plans, classes: state.classes.map((c) => ({ ...c, trainerName: byId(state.users, c.trainerId)?.name, trainerNameAr: byId(state.users, c.trainerId)?.nameAr })), occurrences: occurrences(state, today), trainers: state.users.filter((u) => u.role === 'trainer').map((u) => ({ id: u.id, name: u.name, nameAr: u.nameAr })), me: { id: user.id, name: user.name, nameAr: user.nameAr, role: user.role, memberId: user.memberId || null } };
  const strip = (m) => ({ id: m.id, code: m.code, name: m.name, nameAr: m.nameAr });
  if (user.role === 'member') {
    const m = enrich(state, byId(state.members, user.memberId), today);
    return { ...base, member: m, payments: state.payments.filter((p) => p.memberId === m.id).slice(-12).reverse(),
      checkins: state.checkins.filter((k) => k.memberId === m.id).slice(-15).reverse(),
      bookings: state.bookings.filter((b) => b.memberId === m.id && b.date >= addDays(today, -14) && b.status !== 'cancelled') };
  }
  if (user.role === 'trainer') {
    const mine = state.classes.filter((c) => c.trainerId === user.id).map((c) => c.id);
    const bookings = state.bookings.filter((b) => mine.includes(b.classId) && b.date >= addDays(today, -7));
    const ids = new Set(bookings.map((b) => b.memberId));
    return { ...base, myClassIds: mine, bookings, members: state.members.filter((m) => ids.has(m.id)).map((m) => ({ ...strip(m), note: m.note })) };
  }
  const members = state.members.map((m) => enrich(state, m, today));
  const out = { ...base, members, payments: state.payments.slice().reverse().map((p) => ({ ...p, before: undefined, after: undefined })),
    checkins: state.checkins.filter((k) => k.at >= localToEpoch(addDays(today, -30), '00:00')).reverse().map((k) => ({ memberId: k.memberId, at: k.at, result: k.result, reason: k.reason })),
    bookings: state.bookings.filter((b) => b.date >= addDays(today, -35)), reports: reports(state, now), limits: { strikes: STRIKES_BLOCK } };
  if (user.role === 'owner') out.audit = state.audit.slice(-80).reverse();
  return out;
}

export const toCsv = (rows) => '\ufeff' + rows.map((r) => r.map((c) => { const s = String(c ?? ''); const safe = /^[=+\-@]/.test(s) ? "'" + s : s; return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe; }).join(',')).join('\r\n') + '\r\n';
export function followUpCsv(v) {
  const rows = [['Code', 'Name', 'Phone', 'Plan', 'Status', 'Ends', 'Days left', 'Visits in 30 days']];
  for (const m of v.members.filter((x) => ['expiring', 'grace', 'expired'].includes(x.status) && (x.daysLeft ?? -99) >= -30).sort((a, b) => a.end.localeCompare(b.end))) rows.push([m.code, m.name, m.phone, m.planName, m.status, m.end, m.daysLeft, m.visits30]);
  return toCsv(rows);
}
export function paymentsCsv(v) {
  const rows = [['Receipt', 'Date', 'Member', 'Plan', 'Amount EGP', 'Discount EGP', 'Method', 'Voided']];
  for (const p of v.payments) { const m = v.members.find((x) => x.id === p.memberId); rows.push([p.no, dayKey(p.at), m ? m.code + ' ' + m.name : p.memberId, v.plans.find((x) => x.id === p.planId)?.name, egp(p.amount), egp(p.discount), p.method, p.voided ? 'yes' : '']); }
  return toCsv(rows);
}

export function compact(state, now = Date.now()) {
  if (state.audit.length > 200) state.audit = state.audit.slice(-200);
  const cut = now - 22 * 864e5; state.checkins = state.checkins.filter((k) => k.at >= cut);
  const bcut = addDays(dayKey(now), -40); state.bookings = state.bookings.filter((b) => b.date >= bcut);
}

// ---------- demo data ----------
export const DEMO_USERS = [
  { pin: '1111', role: 'owner', label: 'Owner (Karim)', labelAr: 'المالك (كريم)' },
  { pin: '2222', role: 'desk', label: 'Front desk (Mona)', labelAr: 'الاستقبال (منى)' },
  { pin: '3333', role: 'trainer', label: 'Trainer (Omar)', labelAr: 'مدرب (عمر)' },
  { pin: '4444', role: 'member', label: 'Member (Hana)', labelAr: 'عضوة (هناء)' },
];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FIRST = [['Ahmed', 'أحمد'], ['Mohamed', 'محمد'], ['Omar', 'عمر'], ['Youssef', 'يوسف'], ['Mostafa', 'مصطفى'], ['Ali', 'علي'], ['Khaled', 'خالد'], ['Hassan', 'حسن'], ['Tarek', 'طارق'], ['Ziad', 'زياد'], ['Karim', 'كريم'], ['Amr', 'عمرو'], ['Sara', 'سارة'], ['Mariam', 'مريم'], ['Nour', 'نور'], ['Salma', 'سلمى'], ['Yasmin', 'ياسمين'], ['Heba', 'هبة'], ['Dina', 'دينا'], ['Farida', 'فريدة'], ['Laila', 'ليلى'], ['Rana', 'رنا'], ['Jana', 'جنى'], ['Mai', 'مي']];
const LAST = [['Hassan', 'حسن'], ['Ibrahim', 'إبراهيم'], ['Saleh', 'صالح'], ['Fouad', 'فؤاد'], ['Nabil', 'نبيل'], ['Selim', 'سليم'], ['Zaki', 'زكي'], ['Mahmoud', 'محمود'], ['Gaber', 'جابر'], ['Rizk', 'رزق'], ['Shawky', 'شوقي'], ['Anwar', 'أنور'], ['Badr', 'بدر'], ['Lotfy', 'لطفي'], ['Kamel', 'كامل']];

export function seed(now = Date.now()) {
  const R = rng(20261125), pick = (a) => a[Math.floor(R() * a.length)], between = (a, b) => a + Math.floor(R() * (b - a + 1));
  const today = dayKey(now);
  const state = { v: 1, resetAt: now, seq: {}, gym: { name: 'Liyaqa Fitness', nameAr: 'لياقة فيتنس', branch: 'Maadi, Cairo', branchAr: 'المعادي، القاهرة' }, users: [], plans: [], members: [], payments: [], checkins: [], classes: [], bookings: [], audit: [] };
  state.users.push({ id: 'u-owner', name: 'Karim Mansour', nameAr: 'كريم منصور', role: 'owner', pin: '1111' }, { id: 'u-desk', name: 'Mona Said', nameAr: 'منى سعيد', role: 'desk', pin: '2222' });
  const trainers = [['t1', 'Omar Fathy', 'عمر فتحي', '3333'], ['t2', 'Salma Gad', 'سلمى جاد', '3334'], ['t3', 'Youssef Nabil', 'يوسف نبيل', '3335'], ['t4', 'Rana Helmy', 'رنا حلمي', '3336']];
  for (const [id, name, nameAr, pin] of trainers) state.users.push({ id: 'u-' + id, name, nameAr, role: 'trainer', pin });
  state.plans = [
    { id: 'pl1', name: 'Monthly', nameAr: 'شهري', days: 30, price: 60000, visits: null },
    { id: 'pl2', name: 'Quarterly', nameAr: 'ربع سنوي', days: 90, price: 160000, visits: null },
    { id: 'pl3', name: 'Annual', nameAr: 'سنوي', days: 365, price: 550000, visits: null },
    { id: 'pl4', name: 'Student monthly', nameAr: 'شهري للطلاب', days: 30, price: 45000, visits: null, studentOnly: true },
    { id: 'pl5', name: '10-visit pack', nameAr: 'باقة 10 زيارات', days: 60, price: 45000, visits: 10 },
  ];
  const cl = [['Spin', 'سبين', 't1', 6, '19:00', 14], ['Spin', 'سبين', 't1', 1, '19:00', 14], ['Spin', 'سبين', 't1', 3, '19:00', 14], ['HIIT', 'هيت', 't3', 0, '18:00', 16], ['HIIT', 'هيت', 't3', 2, '18:00', 16], ['HIIT', 'هيت', 't3', 4, '18:00', 16],
    ['Yoga', 'يوغا', 't2', 6, '10:00', 12], ['Yoga', 'يوغا', 't2', 2, '10:00', 12], ['Pilates', 'بيلاتس', 't4', 1, '09:30', 10], ['Pilates', 'بيلاتس', 't4', 3, '09:30', 10],
    ['Boxing fitness', 'بوكسينج فيتنس', 't3', 0, '20:00', 14], ['Boxing fitness', 'بوكسينج فيتنس', 't3', 3, '20:00', 14], ['Zumba', 'زومبا', 't4', 2, '19:30', 20], ['Zumba', 'زومبا', 't4', 4, '19:30', 20],
    ['Strength basics', 'أساسيات القوة', 't1', 6, '17:00', 12], ['Strength basics', 'أساسيات القوة', 't1', 4, '17:00', 12], ['Mobility', 'مرونة', 't2', 0, '08:00', 12]];
  cl.forEach(([name, nameAr, tr, d, time, capacity], i) => state.classes.push({ id: 'c' + (i + 1), name, nameAr, trainerId: 'u-' + tr, dow: d, time, mins: 50, capacity, room: tr === 't2' || tr === 't4' ? 'Studio B' : 'Studio A' }));
  state.seq.c = cl.length;
  const nextId_ = (p) => nextId(state, p);
  const usedPhones = new Set();
  const mkPhone = () => { let p; do { p = '01' + pick(['0', '1', '2', '5']) + String(between(0, 99999999)).padStart(8, '0'); } while (usedPhones.has(p)); usedPhones.add(p); return p; };
  const scen = ['active', 'active', 'active', 'active', 'active', 'active', 'active', 'expiring', 'expiring', 'lapsed', 'lapsed', 'lapsed'];
  const N = 96, pays = [];
  let hanaDone = false;
  for (let i = 0; i < N; i++) {
    const f = i === 0 ? ['Hana', 'هناء'] : pick(FIRST), l = i === 0 ? ['Tarek', 'طارق'] : pick(LAST);
    const m = { id: nextId_('m'), code: 'LQ-' + pad(i + 1), name: f[0] + ' ' + l[0], nameAr: f[1] + ' ' + l[1], phone: mkPhone(), joined: addDays(today, -between(10, 420)), student: R() < 0.18, householdId: null, planId: null, start: null, end: null, visitsLeft: null, cancelled: false, frozenFrom: null, frozenDays: 0, freezes: [], note: '' };
    state.seq.code = i + 1;
    let sc = i === 0 ? 'active' : i === 1 ? 'grace' : i === 2 ? 'frozen' : i === 3 ? 'cancelled' : i === 4 ? 'none' : i === 5 ? 'packlow' : i === 6 ? 'packout' : pick(scen);
    if (sc === 'none') { m.joined = addDays(today, -1); state.members.push(m); continue; }
    let planId = i === 0 || i === 1 ? 'pl1' : m.student && R() < 0.7 ? 'pl4' : pick(['pl1', 'pl1', 'pl1', 'pl2', 'pl2', 'pl3', 'pl5']);
    if (sc === 'packlow' || sc === 'packout') planId = 'pl5';
    if (planId === 'pl5' && !['packlow', 'packout', 'lapsed', 'active'].includes(sc)) sc = 'active';
    const plan = byId(state.plans, planId); m.planId = planId;
    let end;
    if (sc === 'active') end = addDays(today, i === 0 ? 14 : between(EXPIRING_DAYS + 1, Math.min(plan.days - 1, 60)));
    else if (sc === 'expiring') end = addDays(today, between(0, EXPIRING_DAYS - 1));
    else if (sc === 'grace') end = addDays(today, -between(1, GRACE_DAYS));
    else if (sc === 'lapsed') end = addDays(today, -between(GRACE_DAYS + 1, 40));
    else if (sc === 'frozen') end = addDays(today, between(12, 25));
    else if (sc === 'cancelled') end = addDays(today, -between(3, 20));
    else end = addDays(today, between(10, 30));
    if (plan.visits != null) end = sc === 'lapsed' ? addDays(today, -between(3, 20)) : addDays(today, between(8, 40));
    const dur = plan.days;
    m.start = addDays(end, -(dur - 1)); if (m.start > today) { m.start = today; m.end = addDays(today, dur - 1); } else m.end = end;
    if (sc === 'frozen') { m.frozenFrom = addDays(today, -between(1, 5)); m.frozenDays = 14; m.freezes.push({ from: m.frozenFrom, days: 14 }); m.start = addDays(m.end, -(dur - 1)); }
    if (sc === 'cancelled') m.cancelled = true;
    // payments: the current period plus up to 3 earlier ones for monthly-type plans
    const chain = [{ from: m.start, to: m.end }];
    if (plan.visits == null && plan.days <= 90) { const extra = between(0, 3); for (let k = 0; k < extra; k++) { const c0 = chain[chain.length - 1]; const to = addDays(c0.from, -1); chain.push({ from: addDays(to, -(plan.days - 1)), to }); } }
    chain.forEach((c, k) => { if (c.from < addDays(today, -400)) return; const at = localToEpoch(c.from, '1' + between(0, 9) + ':' + String(between(10, 59))); pays.push({ memberId: m.id, planId, amount: plan.price, discount: 0, method: R() < 0.5 ? 'cash' : R() < 0.7 ? 'card' : 'transfer', at: Math.min(at, now - 36e5), by: R() < 0.8 ? 'u-desk' : 'u-owner', from: c.from, to: c.to, visits: plan.visits, kind: k === chain.length - 1 && !m.joined ? 'signup' : 'renewal', latest: k === 0 }); });
    if (plan.visits != null) m.visitsLeft = sc === 'packout' ? 0 : sc === 'packlow' ? 1 : sc === 'lapsed' ? between(0, 3) : between(2, 9);
    m._habit = 0.2 + R() * 0.65; m._sc = sc;
    if (i === 0) hanaDone = true;
    state.members.push(m);
  }
  // households: pair a few members
  for (let i = 10; i < 16; i += 2) { const a = state.members[i], b = state.members[i + 1]; if (a && b && a.planId && b.planId) { a.householdId = b.householdId = nextId_('h'); } }
  state.members[0].student = false; state.members[2].freezes = state.members[2].freezes;
  // receipts in time order
  pays.sort((a, b) => a.at - b.at);
  const lastBy = new Map();
  for (const p of pays) {
    state.seq.receipt = (state.seq.receipt || 0) + 1;
    const m = byId(state.members, p.memberId);
    state.payments.push({ id: nextId_('p'), no: 'R-' + pad(state.seq.receipt, 6), memberId: p.memberId, planId: p.planId, amount: p.amount, discount: 0, method: p.method, at: p.at, by: p.by, byName: p.by === 'u-owner' ? 'Karim Mansour' : 'Mona Said', from: p.from, to: p.to, visits: p.visits, kind: p.kind, before: { planId: null, start: null, end: null, visitsLeft: null, cancelled: false }, after: { end: p.to, visitsLeft: null } });
    lastBy.set(m.id, state.payments[state.payments.length - 1]);
  }
  for (const [id, p] of lastBy) { const m = byId(state.members, id); p.after = { end: m.end, visitsLeft: m.visitsLeft ?? null }; }
  for (const p of state.payments) if (p.kind === 'signup') p.kind = 'renewal';
  // check-ins over the last 21 days
  const W = [[6, 7, 0.14], [7, 8, 0.12], [8, 9, 0.06], [12, 13, 0.05], [13, 14, 0.05], [16, 17, 0.08], [17, 18, 0.14], [18, 19, 0.14], [19, 20, 0.13], [20, 21, 0.07], [21, 22, 0.02]];
  const hourPick = () => { let r = R(), acc = 0; for (const [h, , w] of W) { acc += w; if (r <= acc) return h; } return 18; };
  for (const m of state.members) {
    if (!m.planId) continue;
    const first = pays.filter((p) => p.memberId === m.id).reduce((a, p) => (p.from < a ? p.from : a), '9999');
    const plan = byId(state.plans, m.planId); let used = 0;
    const limit = plan.visits != null ? plan.visits - (m.visitsLeft ?? 0) : 999;
    for (let d = 21; d >= 0; d--) {
      const day = addDays(today, -d), wd = dow(day);
      if (day < first || day > m.end || (m.frozenFrom && day >= m.frozenFrom) || (m.cancelled && day > addDays(today, -3))) continue;
      if (R() > m._habit * (wd === 5 ? 0.45 : 1)) continue;
      if (used >= limit) break;
      const h = hourPick(), at = localToEpoch(day, String(h).padStart(2, '0') + ':' + String(between(0, 59)).padStart(2, '0'));
      if (at > now - 6e4) continue;
      state.checkins.push({ id: nextId_('k'), memberId: m.id, at, by: R() < 0.7 ? 'u-desk' : 'u-owner', result: 'ok', reason: null }); used++;
    }
    delete m._habit; delete m._sc;
  }
  state.checkins.sort((a, b) => a.at - b.at);
  for (const k of state.checkins) { k.id = nextId_('k'); }
  // a few denied scans so the desk history is realistic
  const lapsedM = state.members.filter((m) => statusOf(m, today) === 'expired').slice(0, 2);
  lapsedM.forEach((m, i) => state.checkins.push({ id: nextId_('k'), memberId: m.id, at: now - (3 + i * 2) * 36e5, by: 'u-desk', result: 'denied', reason: 'expired' }));
  state.checkins.sort((a, b) => a.at - b.at);
  // class bookings: past 7 days (history) and next 7 days (some full with a waitlist)
  const eligible = (date) => state.members.filter((m) => { const s = statusOf(m, today); return (s === 'active' || s === 'expiring') && m.end >= date && (m.visitsLeft == null || m.visitsLeft > 0); });
  for (let i = -7; i <= BOOK_AHEAD_DAYS; i++) {
    const date = addDays(today, i);
    for (const c of state.classes.filter((x) => x.dow === dow(date))) {
      const past = startsAt(c, date) <= now, pool = eligible(date).slice().sort(() => R() - 0.5);
      const fillTo = c.id === 'c2' || c.id === 'c14' ? c.capacity : Math.round(c.capacity * (0.35 + R() * 0.6));
      let n = 0;
      for (const m of pool) {
        if (n >= fillTo) break;
        if (m.id === state.members[0].id && i >= 0) continue; // Hana is booked by hand below
        if (state.bookings.some((b) => b.memberId === m.id && b.date === date && byId(state.classes, b.classId).time === c.time)) continue;
        state.bookings.push({ id: nextId_('b'), classId: c.id, date, memberId: m.id, status: past ? (R() < 0.88 ? 'attended' : 'noshow') : 'booked', at: startsAt(c, date) - between(3, 70) * 36e5, by: 'u-desk' }); n++;
      }
    }
  }
  // find the next Spin / Zumba full class for the waitlist demo and book Hana
  const hana = state.members[0];
  const nextOf = (id) => { for (let i = 0; i <= BOOK_AHEAD_DAYS; i++) { const d = addDays(today, i); const c = byId(state.classes, id); if (dow(d) === c.dow && startsAt(c, d) > now + 36e5) return d; } return null; };
  for (const cid of ['c2', 'c14']) {
    const d = nextOf(cid); if (!d) continue; const c = byId(state.classes, cid);
    const booked = state.bookings.filter((b) => b.classId === cid && b.date === d && b.status === 'booked');
    for (const b of booked.slice(c.capacity)) b.status = 'cancelled';
    const pool = eligible(d).filter((m) => m.id !== hana.id && !state.bookings.some((b) => b.memberId === m.id && b.date === d && byId(state.classes, b.classId).time === c.time && b.status !== 'cancelled'));
    let have = state.bookings.filter((b) => b.classId === cid && b.date === d && b.status === 'booked').length;
    for (const m of pool) { if (have >= c.capacity) break; state.bookings.push({ id: nextId_('b'), classId: cid, date: d, memberId: m.id, status: 'booked', at: now - 864e5, by: 'u-desk' }); have++; }
    const wl = pool.filter((m) => !state.bookings.some((b) => b.memberId === m.id && b.classId === cid && b.date === d && b.status !== 'cancelled')).slice(0, 2);
    wl.forEach((m, k) => state.bookings.push({ id: nextId_('b'), classId: cid, date: d, memberId: m.id, status: 'waitlist', at: now - (5 - k) * 36e5, by: 'u-desk' }));
    if (cid === 'c14') { /* Hana waits on Zumba: filled in below */ }
  }
  // Hana: booked into the next HIIT or Yoga, and on the waitlist of the full Spin class
  const hanaBook = (cid, status) => { const d = nextOf(cid); if (!d) return; if (state.bookings.some((b) => b.memberId === hana.id && b.date === d && byId(state.classes, b.classId).time === byId(state.classes, cid).time && b.status !== 'cancelled')) return; state.bookings.push({ id: nextId_('b'), classId: cid, date: d, memberId: hana.id, status, at: now - 36e5, by: 'u-owner' }); };
  hanaBook('c8', 'booked'); hanaBook('c5', 'booked'); hanaBook('c2', 'waitlist');
  // a member with three strikes, so the booking pause is visible
  const striker = state.members.find((m) => m.id !== hana.id && isLive(statusOf(m, today)) && m.visitsLeft == null && !state.bookings.some((b) => b.memberId === m.id && b.date >= today && b.status !== 'cancelled'));
  if (striker) for (let k = 0; k < 3; k++) { const date = addDays(today, -2 - k * 3); const c = state.classes.find((x) => x.dow === dow(date)); if (c) { state.bookings = state.bookings.filter((b) => !(b.memberId === striker.id && b.date === date)); state.bookings.push({ id: nextId_('b'), classId: c.id, date, memberId: striker.id, status: 'noshow', at: startsAt(c, date) - 864e5, by: 'u-desk' }); } }
  state.members[3].note = 'Cancelled after moving to Alexandria.'; state.members[1].note = 'Renewal reminder sent by phone.';
  // member login for the demo member
  state.users.push({ id: 'u-hana', name: hana.name, nameAr: hana.nameAr, role: 'member', pin: '4444', memberId: hana.id });
  state.audit.push({ at: now, by: 'u-owner', byName: 'Karim Mansour', action: 'Demo data created', detail: `${state.members.length} members, ${state.payments.length} payments` });
  return state;
}
