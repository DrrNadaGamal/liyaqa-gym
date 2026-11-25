import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/logic.js';

const NOW = Date.parse('2026-11-25T10:00:00Z'); // Wednesday 12:00 in Cairo
const TODAY = L.dayKey(NOW);
const fresh = () => L.seed(NOW);
const U = (s, role) => s.users.find((u) => u.role === role);
const op = (s, role, o, now = NOW) => { const r = L.applyOp(s, o, { user: typeof role === 'string' ? U(s, role) : role, now }); return r; };
const throws = (s, role, o, re, now = NOW) => assert.throws(() => op(s, role, o, now), (e) => e instanceof L.UserError && re.test(e.message));
const st = (s, m, now = NOW) => L.statusOf(m, L.dayKey(now));
const find = (s, pred) => s.members.find((m) => pred(m, st(s, m)));
const live = (s) => find(s, (m, x) => x === 'active' && m.visitsLeft == null && !m.householdId);
// a clean member with a known membership, independent of the random seed
function mk(s, over = {}) {
  const id = 'mx' + (s.members.length + 1);
  const m = { id, code: 'LQ-9' + String(s.members.length).padStart(3, '0'), name: 'Test Member', nameAr: '', phone: '0100000' + String(1000 + s.members.length), joined: TODAY, student: false, householdId: null, planId: 'pl1', start: L.addDays(TODAY, -10), end: L.addDays(TODAY, 20), visitsLeft: null, cancelled: false, frozenFrom: null, frozenDays: 0, freezes: [], note: '', ...over };
  s.members.push(m); return m;
}
const nextDate = (s, classId, minHours = 3) => { const c = L.byId(s.classes, classId); for (let i = 0; i <= 7; i++) { const d = L.addDays(TODAY, i); if (L.dow(d) === c.dow && L.startsAt(c, d) > NOW + minHours * 36e5) return d; } };

test('time: Cairo wall clock converts correctly in winter and summer', () => {
  assert.equal(new Date(L.localToEpoch('2026-11-25', '19:00')).toISOString(), '2026-11-25T17:00:00.000Z');
  assert.equal(new Date(L.localToEpoch('2026-07-01', '19:00')).toISOString(), '2026-07-01T16:00:00.000Z');
  assert.equal(L.dow('2026-11-25'), 3);
  assert.equal(L.addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(L.hourOf(L.localToEpoch('2026-11-25', '06:30')), 6);
});

test('seed: integrity of members, payments, bookings and users', () => {
  const s = fresh();
  assert.equal(new Set(s.members.map((m) => m.code)).size, s.members.length);
  assert.equal(new Set(s.members.map((m) => m.phone)).size, s.members.length);
  assert.ok(s.members.every((m) => L.PHONE_RE.test(m.phone)));
  assert.equal(new Set(s.payments.map((p) => p.no)).size, s.payments.length);
  for (let i = 1; i < s.payments.length; i++) assert.ok(s.payments[i].at >= s.payments[i - 1].at);
  assert.ok(s.payments.every((p) => L.byId(s.members, p.memberId) && L.byId(s.plans, p.planId) && p.to >= p.from));
  assert.equal(new Set(s.users.map((u) => u.pin)).size, s.users.length);
  for (const c of s.classes) assert.ok(L.byId(s.users, c.trainerId)?.role === 'trainer');
  for (const o of L.occurrences(s, TODAY)) assert.ok(o.booked <= L.byId(s.classes, o.classId).capacity, 'class over capacity');
  const keys = s.bookings.filter((b) => b.status !== 'cancelled').map((b) => b.memberId + b.classId + b.date);
  assert.equal(new Set(keys).size, keys.length, 'duplicate booking');
  const seen = new Set(s.members.map((m) => st(s, m)));
  for (const x of ['active', 'expiring', 'expired', 'frozen', 'cancelled', 'none']) assert.ok(seen.has(x), 'missing status ' + x);
  assert.ok(s.members.some((m) => m.visitsLeft != null));
  assert.ok(s.checkins.every((k) => k.at <= NOW));
});

test('status rules: active, expiring, grace, expired, frozen, cancelled, packs', () => {
  const m = { planId: 'pl1', end: L.addDays(TODAY, 30), cancelled: false, frozenFrom: null, visitsLeft: null };
  assert.equal(L.statusOf(m, TODAY), 'active');
  assert.equal(L.statusOf({ ...m, end: L.addDays(TODAY, 7) }, TODAY), 'expiring');
  assert.equal(L.statusOf({ ...m, end: L.addDays(TODAY, 8) }, TODAY), 'active');
  assert.equal(L.statusOf({ ...m, end: TODAY }, TODAY), 'expiring');
  assert.equal(L.statusOf({ ...m, end: L.addDays(TODAY, -2) }, TODAY), 'grace');
  assert.equal(L.statusOf({ ...m, end: L.addDays(TODAY, -3) }, TODAY), 'expired');
  assert.equal(L.statusOf({ ...m, frozenFrom: TODAY }, TODAY), 'frozen');
  assert.equal(L.statusOf({ ...m, cancelled: true }, TODAY), 'cancelled');
  assert.equal(L.statusOf({ ...m, planId: null }, TODAY), 'none');
  assert.equal(L.statusOf({ ...m, visitsLeft: 0 }, TODAY), 'expired');
  assert.equal(L.statusOf({ ...m, visitsLeft: 3, end: L.addDays(TODAY, -1) }, TODAY), 'expired', 'packs get no grace');
});

test('addMember: validates phone, rejects duplicates, numbers codes, can sell a plan at once', () => {
  const s = fresh();
  throws(s, 'desk', { type: 'addMember', name: 'A', phone: '01012345678' }, /name/);
  throws(s, 'desk', { type: 'addMember', name: 'Sara Ali', phone: '12345' }, /Egyptian mobile/);
  throws(s, 'desk', { type: 'addMember', name: 'Sara Ali', phone: s.members[0].phone }, /already exists/);
  const n = s.members.length;
  const r = op(s, 'desk', { type: 'addMember', name: 'Sara Ali', phone: '٠١٠١٢٣٤٥٦٧٨', planId: 'pl1', method: 'cash' });
  assert.equal(s.members.length, n + 1);
  const m = L.byId(s.members, r.id);
  assert.equal(m.phone, '01012345678');
  assert.equal(m.code, 'LQ-' + String(n + 1).padStart(4, '0'));
  assert.equal(m.start, TODAY); assert.equal(m.end, L.addDays(TODAY, 29));
  assert.equal(L.byId(s.payments, r.payment).kind, 'signup');
  throws(s, 'trainer', { type: 'addMember', name: 'Sara Ali', phone: '01012345679' }, /permission/);
  throws(s, 'member', { type: 'addMember', name: 'Sara Ali', phone: '01012345679' }, /permission/);
});

test('renewal: running membership continues after its end, lapsed starts today, packs add up', () => {
  const s = fresh(); const m = mk(s);
  const end0 = m.end;
  op(s, 'desk', { type: 'sellPlan', memberId: m.id, planId: 'pl1', method: 'card' });
  assert.equal(m.end, L.addDays(end0, 30), 'stacked on the old end date');
  const lapsed = mk(s, { start: L.addDays(TODAY, -50), end: L.addDays(TODAY, -20) });
  op(s, 'desk', { type: 'sellPlan', memberId: lapsed.id, planId: 'pl1', method: 'cash' });
  assert.equal(lapsed.start, TODAY); assert.equal(lapsed.end, L.addDays(TODAY, 29));
  const pack = mk(s, { planId: 'pl5', visitsLeft: 2, end: L.addDays(TODAY, 10) });
  op(s, 'desk', { type: 'sellPlan', memberId: pack.id, planId: 'pl5', method: 'cash' });
  assert.equal(pack.visitsLeft, 12);
  const unl = mk(s); // unlimited member buying a pack does not mix the two kinds
  op(s, 'desk', { type: 'sellPlan', memberId: unl.id, planId: 'pl5', method: 'cash' });
  assert.equal(unl.visitsLeft, 10); assert.equal(unl.start, TODAY);
  throws(s, 'desk', { type: 'sellPlan', memberId: m.id, planId: 'pl1', method: 'bitcoin' }, /how it was paid/);
  throws(s, 'desk', { type: 'sellPlan', memberId: m.id, planId: 'nope', method: 'cash' }, /plan/);
});

test('pricing: household discount, student plan, price edits only affect new sales', () => {
  const s = fresh(); const a = mk(s, { householdId: 'hX' }), b = mk(s, { householdId: 'hX', planId: null, start: null, end: null });
  const p = op(s, 'desk', { type: 'sellPlan', memberId: b.id, planId: 'pl1', method: 'cash' });
  assert.equal(L.byId(s.payments, p.id).amount, 54000); assert.equal(L.byId(s.payments, p.id).discount, 6000);
  const q = op(s, 'desk', { type: 'sellPlan', memberId: b.id, planId: 'pl5', method: 'cash' });
  assert.equal(L.byId(s.payments, q.id).discount, 0, 'no discount on packs');
  const c = mk(s);
  throws(s, 'desk', { type: 'sellPlan', memberId: c.id, planId: 'pl4', method: 'cash' }, /student/);
  c.student = true;
  assert.equal(L.byId(s.payments, op(s, 'desk', { type: 'sellPlan', memberId: c.id, planId: 'pl4', method: 'cash' }).id).amount, 45000);
  throws(s, 'desk', { type: 'setPlanPrice', planId: 'pl1', price: 70000 }, /permission/);
  throws(s, 'owner', { type: 'setPlanPrice', planId: 'pl1', price: 10 }, /between/);
  const before = s.payments.length; op(s, 'owner', { type: 'setPlanPrice', planId: 'pl1', price: 70000 });
  assert.equal(L.byId(s.plans, 'pl1').price, 70000); assert.equal(s.payments.length, before);
  assert.equal(a.householdId, 'hX');
});

test('sellPlan is idempotent for the same request id', () => {
  const s = fresh(); const m = mk(s); const n = s.payments.length;
  const r1 = op(s, 'desk', { type: 'sellPlan', memberId: m.id, planId: 'pl1', method: 'cash', reqId: 'abc' });
  const r2 = op(s, 'desk', { type: 'sellPlan', memberId: m.id, planId: 'pl1', method: 'cash', reqId: 'abc' });
  assert.equal(s.payments.length, n + 1); assert.equal(r2.duplicate, true); assert.equal(r1.id, r2.id);
});

test('void: owner only, latest payment only, restores the membership, blocked after changes', () => {
  const s = fresh(); const m = mk(s); const end0 = m.end;
  const p1 = op(s, 'desk', { type: 'sellPlan', memberId: m.id, planId: 'pl1', method: 'cash' });
  const p2 = op(s, 'desk', { type: 'sellPlan', memberId: m.id, planId: 'pl1', method: 'cash' });
  throws(s, 'desk', { type: 'voidPayment', paymentId: p2.id, reason: 'mistake' }, /permission/);
  throws(s, 'owner', { type: 'voidPayment', paymentId: p2.id, reason: '' }, /reason/);
  throws(s, 'owner', { type: 'voidPayment', paymentId: p1.id, reason: 'mistake' }, /latest/);
  op(s, 'owner', { type: 'voidPayment', paymentId: p2.id, reason: 'entered twice' });
  assert.equal(m.end, L.addDays(end0, 30));
  throws(s, 'owner', { type: 'voidPayment', paymentId: p2.id, reason: 'again' }, /Already voided/);
  op(s, 'owner', { type: 'voidPayment', paymentId: p1.id, reason: 'wrong member' });
  assert.equal(m.end, end0);
  assert.equal(L.reports(s, NOW).revenueMonth, L.reports(fresh(), NOW).revenueMonth, 'voided payments do not count as revenue');
  const pk = mk(s, { planId: 'pl5', visitsLeft: 5, end: L.addDays(TODAY, 20) });
  const p3 = op(s, 'desk', { type: 'sellPlan', memberId: pk.id, planId: 'pl5', method: 'cash' });
  op(s, 'desk', { type: 'checkIn', memberId: pk.id });
  throws(s, 'owner', { type: 'voidPayment', paymentId: p3.id, reason: 'oops' }, /changed/);
});

test('check-in: statuses, warnings, duplicates, packs, codes, permissions', () => {
  const s = fresh();
  const ok = mk(s), exp = mk(s, { end: L.addDays(TODAY, 3) }), grace = mk(s, { end: L.addDays(TODAY, -1) }), dead = mk(s, { end: L.addDays(TODAY, -9) });
  const fr = mk(s, { frozenFrom: TODAY, frozenDays: 10 }), cn = mk(s, { cancelled: true }), none = mk(s, { planId: null, start: null, end: null });
  let r = op(s, 'desk', { type: 'checkIn', memberId: ok.id }); assert.equal(r.ok, true); assert.equal(r.warn, null);
  r = op(s, 'desk', { type: 'checkIn', memberId: exp.id }); assert.equal(r.ok, true); assert.equal(r.warn, 'expiring'); assert.equal(r.daysLeft, 3);
  r = op(s, 'desk', { type: 'checkIn', memberId: grace.id }); assert.equal(r.ok, true); assert.equal(r.warn, 'grace');
  for (const [m, why] of [[dead, 'expired'], [fr, 'frozen'], [cn, 'cancelled'], [none, 'none']]) { r = op(s, 'desk', { type: 'checkIn', memberId: m.id }); assert.equal(r.ok, false); assert.equal(r.reason, why); }
  assert.equal(s.checkins.filter((k) => k.memberId === dead.id && k.result === 'denied').length, 1, 'denied scans are logged');
  const n = s.checkins.length; r = op(s, 'desk', { type: 'checkIn', memberId: ok.id });
  assert.equal(r.duplicate, true); assert.equal(s.checkins.length, n, 'a second scan within 2 hours is not counted');
  r = op(s, 'desk', { type: 'checkIn', memberId: ok.id }, NOW + 121 * 60000); assert.equal(r.duplicate, undefined);
  r = op(s, 'desk', { type: 'checkIn', code: ' ' + exp.code.toLowerCase() }, NOW + 5 * 36e5); assert.equal(r.ok, true);
  throws(s, 'desk', { type: 'checkIn', code: 'LQ-0000' }, /No member/);
  const pk = mk(s, { planId: 'pl5', visitsLeft: 2, end: L.addDays(TODAY, 30) });
  assert.equal(op(s, 'desk', { type: 'checkIn', memberId: pk.id }).visitsLeft, 1);
  assert.equal(op(s, 'desk', { type: 'checkIn', memberId: pk.id }, NOW + 3 * 36e5).visitsLeft, 0);
  r = op(s, 'desk', { type: 'checkIn', memberId: pk.id }, NOW + 6 * 36e5); assert.equal(r.ok, false); assert.equal(r.reason, 'novisits'); assert.equal(pk.visitsLeft, 0);
  throws(s, 'trainer', { type: 'checkIn', memberId: ok.id }, /permission/);
  throws(s, 'member', { type: 'checkIn', memberId: ok.id }, /permission/);
});

test('freeze: limits, cap, packs, bookings cancelled, auto and early unfreeze extend the end date', () => {
  const s = fresh(); const m = mk(s); const end0 = m.end;
  throws(s, 'desk', { type: 'freeze', memberId: m.id, days: 3 }, /7 to 30/);
  throws(s, 'desk', { type: 'freeze', memberId: m.id, days: 31 }, /7 to 30/);
  const d = nextDate(s, 'c8'); m.planId = 'pl1';
  op(s, 'desk', { type: 'book', memberId: m.id, classId: 'c8', date: d });
  const r = op(s, 'desk', { type: 'freeze', memberId: m.id, days: 14 });
  assert.equal(r.cancelledBookings, 1); assert.equal(st(s, m), 'frozen');
  assert.ok(!s.bookings.some((b) => b.memberId === m.id && b.status === 'booked'));
  throws(s, 'desk', { type: 'sellPlan', memberId: m.id, planId: 'pl1', method: 'cash' }, /Unfreeze/);
  assert.equal(op(s, 'desk', { type: 'checkIn', memberId: m.id }).reason, 'frozen');
  L.normalize(s, NOW + 13 * 864e5); assert.equal(st(s, m, NOW + 13 * 864e5), 'frozen');
  const later = NOW + 14 * 864e5; L.normalize(s, later);
  assert.equal(m.frozenFrom, null); assert.equal(m.end, L.addDays(end0, 14));
  const m2 = mk(s); op(s, 'desk', { type: 'freeze', memberId: m2.id, days: 20 });
  op(s, 'desk', { type: 'unfreeze', memberId: m2.id }, NOW + 5 * 864e5);
  assert.equal(m2.end, L.addDays(L.addDays(TODAY, 20), 5), 'only the days actually frozen are added');
  assert.equal(L.freezeLeft(m2, L.addDays(TODAY, 5)), 25);
  throws(s, 'desk', { type: 'freeze', memberId: m2.id, days: 30 }, /days left/);
  const pk = mk(s, { planId: 'pl5', visitsLeft: 5 });
  throws(s, 'desk', { type: 'freeze', memberId: pk.id, days: 10 }, /packs/);
  const lapsed = mk(s, { end: L.addDays(TODAY, -10) });
  throws(s, 'desk', { type: 'freeze', memberId: lapsed.id, days: 10 }, /running/);
  throws(s, 'desk', { type: 'unfreeze', memberId: lapsed.id }, /not frozen/);
});

test('cancel membership: owner only, needs a reason, drops future bookings', () => {
  const s = fresh(); const m = mk(s); const d = nextDate(s, 'c8');
  op(s, 'desk', { type: 'book', memberId: m.id, classId: 'c8', date: d });
  throws(s, 'desk', { type: 'cancelMembership', memberId: m.id, reason: 'moved' }, /permission/);
  throws(s, 'owner', { type: 'cancelMembership', memberId: m.id, reason: '' }, /reason/);
  op(s, 'owner', { type: 'cancelMembership', memberId: m.id, reason: 'moved away' });
  assert.equal(st(s, m), 'cancelled'); assert.ok(!s.bookings.some((b) => b.memberId === m.id && b.status === 'booked'));
  throws(s, 'owner', { type: 'cancelMembership', memberId: m.id, reason: 'again' }, /Already/);
  op(s, 'desk', { type: 'sellPlan', memberId: m.id, planId: 'pl1', method: 'cash' });
  assert.equal(st(s, m), 'active', 'buying a plan reactivates a cancelled member');
});

test('booking: capacity, waitlist, promotion, window, overlap, expiry and ownership', () => {
  const s = fresh(); const c = L.byId(s.classes, 'c8'); const d = nextDate(s, 'c8');
  s.bookings = s.bookings.filter((b) => !(b.classId === 'c8' && b.date === d));
  const people = Array.from({ length: c.capacity + 3 }, () => mk(s));
  const res = people.map((m) => op(s, 'desk', { type: 'book', memberId: m.id, classId: 'c8', date: d }));
  assert.deepEqual(res.slice(0, c.capacity).map((r) => r.status), Array(c.capacity).fill('booked'));
  assert.deepEqual(res.slice(c.capacity).map((r) => r.position), [1, 2, 3]);
  throws(s, 'desk', { type: 'book', memberId: people[0].id, classId: 'c8', date: d }, /Already booked/);
  throws(s, 'desk', { type: 'book', memberId: people[c.capacity].id, classId: 'c8', date: d }, /waitlist/);
  const [a, b, c2] = people.slice(c.capacity);
  // cancel a booked spot: first on the waitlist is promoted
  const first = s.bookings.find((x) => x.memberId === people[0].id && x.date === d);
  const out = op(s, 'desk', { type: 'cancelBooking', bookingId: first.id });
  assert.equal(out.promoted, a.id); assert.equal(L.classCounts(s, 'c8', d).booked, c.capacity); assert.equal(L.classCounts(s, 'c8', d).waitlist, 2);
  const extra = mk(s); for (const m of [mk(s), mk(s)]) op(s, 'desk', { type: 'book', memberId: m.id, classId: 'c8', date: d });
  // dates and classes
  throws(s, 'desk', { type: 'book', memberId: extra.id, classId: 'c8', date: L.addDays(d, 1) }, /does not run/);
  throws(s, 'desk', { type: 'book', memberId: extra.id, classId: 'c8', date: L.addDays(d, 14) }, /days ahead/);
  throws(s, 'desk', { type: 'book', memberId: extra.id, classId: 'c8', date: 'junk' }, /Pick a date/);
  const e2 = mk(s, { end: L.addDays(d, -1) }); throws(s, 'desk', { type: 'book', memberId: e2.id, classId: 'c8', date: d }, /ends before/);
  const e3 = mk(s, { end: L.addDays(TODAY, -10) }); throws(s, 'desk', { type: 'book', memberId: e3.id, classId: 'c8', date: d }, /ended/);
  // same time slot clash: c9 is Pilates Mon 09:30, c8 Yoga Tue 10:00. Use two classes with the same time on the same day
  s.classes.push({ ...c, id: 'cz', name: 'Clash', capacity: 5 }); const m4 = mk(s);
  op(s, 'desk', { type: 'book', memberId: m4.id, classId: 'c8', date: d });
  throws(s, 'desk', { type: 'book', memberId: m4.id, classId: 'cz', date: d }, /same time/);
});

test('booking: members only act on their own bookings; past classes cannot be booked', () => {
  const s = fresh(); const me = s.users.find((u) => u.role === 'member'); const other = mk(s);
  const d = nextDate(s, 'c11');
  op(s, me, { type: 'book', classId: 'c11', date: d });
  const mine = s.bookings.find((b) => b.memberId === me.memberId && b.classId === 'c11' && b.date === d);
  assert.ok(mine);
  const ob = op(s, 'desk', { type: 'book', memberId: other.id, classId: 'c11', date: d });
  throws(s, me, { type: 'cancelBooking', bookingId: ob.id }, /permission/);
  op(s, me, { type: 'cancelBooking', bookingId: mine.id });
  // member cannot book for someone else: the memberId in the request is ignored
  op(s, me, { type: 'book', memberId: other.id, classId: 'c11', date: d });
  assert.ok(s.bookings.some((b) => b.memberId === me.memberId && b.classId === 'c11' && b.date === d && b.status !== 'cancelled'));
  const c = L.byId(s.classes, 'c4'); const today = L.dayKey(NOW);
  const dd = L.addDays(today, ((c.dow - L.dow(today) + 7) % 7) || 7);
  assert.throws(() => L.applyOp(s, { type: 'book', memberId: other.id, classId: 'c4', date: dd }, { user: U(s, 'desk'), now: L.startsAt(c, dd) + 60000 }), /already started/);
});

test('strikes: late cancels and no-shows pause booking after three', () => {
  const s = fresh(); const m = mk(s); s.bookings = s.bookings.filter((b) => b.memberId !== m.id);
  const c = L.byId(s.classes, 'c8'); const d = nextDate(s, 'c8', 0.5);
  const near = L.startsAt(c, d) - 90 * 60000; // 90 minutes before the class: a late cancel
  const bk = op(s, 'desk', { type: 'book', memberId: m.id, classId: 'c8', date: d }, near - 36e5);
  const r = op(s, 'desk', { type: 'cancelBooking', bookingId: bk.id }, near);
  assert.equal(r.late, true); assert.equal(L.strikes(s, m.id, L.dayKey(near)), 1);
  const bk2 = op(s, 'desk', { type: 'book', memberId: m.id, classId: 'c8', date: d }, near - 36e5);
  const r2 = op(s, 'desk', { type: 'cancelBooking', bookingId: bk2.id }, near - 5 * 36e5);
  assert.equal(r2.late, false, 'early cancel is free');
  // two more strikes from no-shows
  for (const k of [3, 6]) { const dd = L.addDays(TODAY, -k); s.bookings.push({ id: 'bx' + k, classId: 'c1', date: dd, memberId: m.id, status: 'noshow', at: NOW - 9e8, by: 'u-desk' }); }
  assert.equal(L.strikes(s, m.id, TODAY), 3);
  const d2 = nextDate(s, 'c11');
  throws(s, 'desk', { type: 'book', memberId: m.id, classId: 'c11', date: d2 }, /paused/);
  assert.equal(L.strikes(s, m.id, L.addDays(TODAY, 40)), 0, 'strikes expire after 30 days');
});

test('markClass: trainer only for their class, date window, no-shows become strikes, waitlist is cleared', () => {
  const s = fresh(); const t1 = L.byId(s.users, 'u-t1'), t2 = L.byId(s.users, 'u-t2');
  const c = L.byId(s.classes, 'c1'); // Spin, Saturday 19:00, trainer t1
  const today = L.dayKey(NOW); const past = L.addDays(today, -((L.dow(today) - c.dow + 7) % 7 || 7));
  const m = mk(s); s.bookings.push({ id: 'bm', classId: 'c1', date: past, memberId: m.id, status: 'booked', at: NOW - 9e8, by: 'u-desk' }, { id: 'bw', classId: 'c1', date: past, memberId: mk(s).id, status: 'waitlist', at: NOW - 9e8, by: 'u-desk' });
  throws(s, t2, { type: 'markClass', classId: 'c1', date: past, marks: { bm: 'noshow' } }, /permission/);
  throws(s, t1, { type: 'markClass', classId: 'c1', date: L.addDays(past, -14), marks: {} }, /7 days/);
  throws(s, t1, { type: 'markClass', classId: 'c1', date: L.addDays(past, 1), marks: {} }, /runs on/);
  throws(s, t1, { type: 'markClass', classId: 'c1', date: past, marks: { bm: 'dancing' } }, /Bad mark/);
  const r = op(s, t1, { type: 'markClass', classId: 'c1', date: past, marks: { bm: 'noshow' } });
  assert.equal(r.marked, 1); assert.equal(L.byId(s.bookings, 'bm').status, 'noshow'); assert.equal(L.byId(s.bookings, 'bw').status, 'cancelled');
  assert.equal(L.strikes(s, m.id, today), 1);
  const future = nextDate(s, 'c1', 1); if (future) throws(s, t1, { type: 'markClass', classId: 'c1', date: future, marks: {} }, /up to today/);
  op(s, 'desk', { type: 'markClass', classId: 'c1', date: past, marks: { bm: 'attended' } });
  assert.equal(L.byId(s.bookings, 'bm').status, 'attended');
});

test('views: each role sees only what it should', () => {
  const s = fresh();
  const owner = L.view(s, U(s, 'owner'), NOW), desk = L.view(s, U(s, 'desk'), NOW), tr = L.view(s, U(s, 'trainer'), NOW), me = L.view(s, s.users.find((u) => u.role === 'member'), NOW);
  assert.ok(owner.audit && owner.reports && owner.payments);
  assert.equal(desk.audit, undefined); assert.ok(desk.payments);
  assert.equal(tr.payments, undefined); assert.equal(tr.reports, undefined);
  assert.ok(tr.members.every((x) => !('phone' in x)), 'trainers do not get phone numbers');
  assert.ok(tr.bookings.every((b) => tr.myClassIds.includes(b.classId)));
  assert.equal(me.members, undefined); assert.equal(me.payments.every((p) => p.memberId === me.member.id), true);
  assert.ok(me.bookings.every((b) => b.memberId === me.member.id));
  assert.equal(me.audit, undefined); assert.equal(me.reports, undefined);
  assert.ok(!JSON.stringify(me).includes(s.members[5].phone), "a member's view has no other member's phone");
  assert.ok(!JSON.stringify(tr).includes('"pin"'));
  assert.ok(!JSON.stringify(owner).includes('"pin"'));
});

test('reports: counts, revenue, retention and peak hours add up', () => {
  const s = fresh(); const r = L.reports(s, NOW);
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), s.members.length);
  const month = s.payments.filter((p) => !p.voided && L.monthKey(p.at) === L.monthKey(NOW)).reduce((a, p) => a + p.amount, 0);
  assert.equal(r.revenueMonth, month);
  assert.equal(r.byPlan.reduce((a, p) => a + p.amount, 0), month);
  assert.equal(r.hours.length, 24);
  const since = L.addDays(TODAY, -13); assert.equal(r.hours.reduce((a, b) => a + b, 0), s.checkins.filter((k) => k.result === 'ok' && L.dayKey(k.at) >= since).length);
  assert.ok(r.retention.pct >= 0 && r.retention.pct <= 100);
  assert.equal(r.series.length, 14);
});

test('csv: formula-looking cells are neutralised, quotes escaped', () => {
  const csv = L.toCsv([['a', '=HYPERLINK("x")', 'he said "hi", ok'], ['+1', '-2', '@x']]);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('"he said ""hi"", ok"'));
  assert.ok(csv.includes("'+1") && csv.includes("'@x"));
  const v = L.view(fresh(), U(fresh(), 'owner'), NOW);
  assert.ok(L.followUpCsv(v).split('\r\n')[0].startsWith('\ufeffCode'));
  assert.ok(L.paymentsCsv(v).includes('R-'));
});

test('compact keeps the state small', () => {
  const s = fresh(); for (let i = 0; i < 300; i++) s.audit.push({ at: NOW, by: 'x', byName: 'x', action: 'x', detail: 'x' });
  s.checkins.push({ id: 'old', memberId: 'm1', at: NOW - 40 * 864e5, by: 'x', result: 'ok' });
  L.compact(s, NOW);
  assert.ok(s.audit.length <= 200); assert.ok(!s.checkins.some((k) => k.id === 'old'));
});

test('unknown operations and bad input are rejected cleanly', () => {
  const s = fresh();
  throws(s, 'owner', { type: 'dropEverything' }, /Unknown/);
  throws(s, 'owner', { type: 'setNote', memberId: 'zzz', note: 'x' }, /not found/);
  op(s, 'trainer', { type: 'setNote', memberId: s.members[0].id, note: 'x'.repeat(500) });
  assert.equal(s.members[0].note.length, 200);
});
