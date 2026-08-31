/* eslint-disable @typescript-eslint/no-explicit-any */
// FAP Rewards API — a 1:1 port of the original Express router (src/server.js)
// onto a TanStack server route. Every endpoint keeps its original path:
//   /api/public/fap/me, /scratch, /redeem, /admin/*, ...
import { createFileRoute } from '@tanstack/react-router';
import { getConfig } from '@/lib/fap/config';
import { validateInitData, isChannelMember, sendMessage } from '@/lib/fap/telegram.server';
import {
  getUser, getOrCreateUser, updateUser, allUsers, addTransaction, updateTransaction,
  transactionsFor, allTransactions, ensureRefCode, findByRefCode, type FapUser,
} from '@/lib/fap/store.server';

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-init-data, x-admin-key',
    },
  });

const initDataOf = (request: Request) => request.headers.get('x-init-data') || '';
const authed = (request: Request) => validateInitData(initDataOf(request));

function clientIp(request: Request) {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '';
}

function publicBaseUrl(request: Request) {
  const conf = getConfig().webappUrl;
  const norm = (s: string) => String(s || '').replace(/\/$/, '');
  if (conf && !/(^|:\/\/)localhost/.test(conf) && !/^http:\/\//.test(conf)) return norm(conf);
  const url = new URL(request.url);
  return norm(`${url.protocol}//${url.host}/fap`);
}

/** Resolve the account for a request, enforcing the same-IP anti-fake rule. */
async function accountFor(request: Request): Promise<FapUser | null> {
  const cfg = getConfig();
  const user = await authed(request);
  if (!user) return null;
  const ip = clientIp(request);

  if (String(user.id) === String(cfg.adminId)) {
    const admin = await getOrCreateUser(user.id, { firstName: user.first_name, username: user.username });
    if (!admin) return null;
    if (admin.banned) await updateUser(user.id, { banned: false, bannedReason: null });
    if (admin.ip !== ip) await updateUser(user.id, { ip });
    return admin;
  }

  const existing = await getUser(user.id);
  if (existing) {
    if (existing.ip !== ip) await updateUser(user.id, { ip });
    if (existing.banned) return null;
    return existing;
  }

  if (ip) {
    const users = await allUsers();
    const owner = users.find((u) => u.ip && u.ip === ip && String(u.id) !== String(user.id) && !u.banned);
    if (owner) {
      await getOrCreateUser(user.id, { firstName: user.first_name, username: user.username });
      await updateUser(user.id, {
        ip,
        banned: true,
        bannedAt: Date.now(),
        bannedReason: `Same-IP multi-account (owner ${owner.id} on ${ip})`,
      });
      return null;
    }
  }
  return getOrCreateUser(user.id, { firstName: user.first_name, username: user.username });
}

/** 94% ₹1–4, 4% ₹4–9, 2% ₹10–50 */
function randomReward() {
  const roll = Math.random();
  let min: number, max: number;
  if (roll < 0.94) { min = 1; max = 4; }
  else if (roll < 0.98) { min = 4; max = 9; }
  else { min = 10; max = 50; }
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

// Hourly check-in: watching one ad unlocks the whole app (and ad-free
// scratching) for the next 60 minutes. After that the user checks in again.
const ACCESS_WINDOW_MS = 60 * 60 * 1000;

function accessUntil(t: number | null) {
  return t ? Number(t) + ACCESS_WINDOW_MS : 0;
}

function checkedInToday(t: number | null) {
  return accessUntil(t) > Date.now();
}

async function adminAuthed(request: Request, url: URL) {
  const cfg = getConfig();
  const key = request.headers.get('x-admin-key') || url.searchParams.get('key') || '';
  if (key && key === cfg.adminKey) return true;
  const u = await authed(request);
  return !!(u && String(cfg.adminId) === String(u.id));
}

async function readBody(request: Request): Promise<any> {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

const PAYOUT_METHODS = ['flipkart', 'amazon', 'play', 'upi'];

async function handle(request: Request, params: any): Promise<Response> {
  const cfg = getConfig();
  const url = new URL(request.url);
  const path = '/' + String(params?._splat ?? '').replace(/^\/+|\/+$/g, '');
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return json({ ok: true });

  try {
    // ---- GET /me -----------------------------------------------------------
    if (path === '/me' && method === 'GET') {
      const user = await authed(request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const rec = await accountFor(request);
      if (!rec) {
        return json({ error: 'ip_used', message: 'This device/IP already has an account. Use your original account.' }, 403);
      }
      const refCode = await ensureRefCode(rec.id);
      const isAdmin = String(cfg.adminId) === String(rec.id);

      let missing: string[] = [];
      let joinedAll = false;
      let joinedExternals = !!rec.joinedExternals;
      if (isAdmin) {
        joinedAll = true;
        joinedExternals = true;
      } else {
        // Live Telegram membership checks are rate-limited and slow, so /me
        // (polled on every app open/refresh) only re-checks once an hour.
        // The result is cached on the user row and reused as a reminder in
        // between checks; the actual reward gate in /scratch always does a
        // fresh live check, so this cache can't be used to fake a claim.
        const CHANNEL_CHECK_TTL_MS = 60 * 60 * 1000; // 1 hour
        const cacheAge = rec.lastChannelCheck ? Date.now() - rec.lastChannelCheck : Infinity;
        if (cacheAge < CHANNEL_CHECK_TTL_MS) {
          missing = rec.channelCheckCache || [];
        } else {
          for (const ch of cfg.channels) {
            if (!(await isChannelMember(rec.id, ch))) missing.push(ch);
          }
          await updateUser(rec.id, { lastChannelCheck: Date.now(), channelCheckCache: missing });
        }
        joinedAll = missing.length === 0;
      }

      if (rec.referrer && String(rec.referrer) !== String(rec.id) && !rec.credited && joinedAll && joinedExternals) {
        const ip = clientIp(request);
        const users = await allUsers();
        const alreadyClaimed = users.some((u) => u.ip && u.ip === ip && String(u.id) !== String(rec.id));
        if (ip && !alreadyClaimed) {
          const ref = await getUser(rec.referrer);
          if (ref) {
            const newCards = [...ref.scratchCards, { id: Date.now() + Math.random().toString(16).slice(2, 8), kind: 'referral', at: Date.now() }];
            await updateUser(rec.referrer, { qualifiedCount: ref.qualifiedCount + 1, scratchCards: newCards });
            await updateUser(rec.id, { credited: true, creditedAt: Date.now() });
            await sendMessage(
              rec.referrer,
              `🎉 <b>You got a referral!</b>\n<b>Your free Scratch Card is ready!</b>\n\n` +
                `👤 <i>${rec.firstName || 'Someone'} joined all channels & opened the Mini App on a new device</i>\n\n` +
                `Open the Rewards Mini App to scratch it. 🎟️`,
            );
          }
        }
      }

      const cap = rec.qualifiedCount;
      if (rec.scratchCards.length > cap) {
        rec.scratchCards = rec.scratchCards.slice(rec.scratchCards.length - cap);
        await updateUser(rec.id, { scratchCards: rec.scratchCards });
      }

      return json({
        id: String(rec.id),
        refCode,
        refUrl: `${publicBaseUrl(request)}/?ref=${refCode}`,
        joinedAll,
        missingChannels: missing,
        joinedExternals: !!rec.joinedExternals,
        externalChannels: cfg.communityLinks,
        firstName: rec.firstName || user.first_name || '',
        username: rec.username || user.username || '',
        balance: rec.balance,
        scratchCards: rec.scratchCards.length,
        cards: rec.scratchCards.map((c: any) => ({ id: c.id, kind: c.kind, at: c.at })),
        totalCards: cap,
        referralCount: rec.referralCount,
        qualifiedCount: rec.qualifiedCount,
        scratched: rec.scratched,
        lastScratchAt: rec.lastScratchAt,
        minAmount: cfg.minAmount,
        maxAmount: cfg.maxAmount,
        withdrawFee: cfg.withdrawFee || 0,
        minWithdraw: cfg.minWithdraw || 25,
        channels: cfg.channels,
        adsgramBlockId: cfg.adsgramBlockId,
        monetagZone: cfg.monetagZone,
        checkedInToday: checkedInToday(rec.lastCheckIn),
        hasAccess: checkedInToday(rec.lastCheckIn),
        accessUntil: accessUntil(rec.lastCheckIn),
        accessWindowMs: ACCESS_WINDOW_MS,
        checkInCount: rec.checkInCount,
        isAdmin,
      });
    }

    // ---- POST /check-in ----------------------------------------------------
    if (path === '/check-in' && method === 'POST') {
      const user = await authed(request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const rec = await accountFor(request);
      if (!rec) return json({ error: 'ip_used' }, 403);
      if (checkedInToday(rec.lastCheckIn))
        return json({
          ok: true,
          alreadyChecked: true,
          checkedInToday: true,
          hasAccess: true,
          accessUntil: accessUntil(rec.lastCheckIn),
        });
      const now = Date.now();
      await updateUser(rec.id, { lastCheckIn: now, checkInCount: rec.checkInCount + 1 });
      return json({
        ok: true,
        checkedInToday: true,
        hasAccess: true,
        accessUntil: accessUntil(now),
        accessWindowMs: ACCESS_WINDOW_MS,
        checkInCount: rec.checkInCount + 1,
      });
    }

    // ---- POST /join-external ----------------------------------------------
    if (path === '/join-external' && method === 'POST') {
      const user = await authed(request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const rec = await accountFor(request);
      if (!rec) return json({ error: 'ip_used' }, 403);
      if (!rec.joinedExternals) await updateUser(rec.id, { joinedExternals: true });
      return json({ ok: true, joinedExternals: true });
    }

    // ---- POST /refer/claim -------------------------------------------------
    if (path === '/refer/claim' && method === 'POST') {
      const user = await authed(request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const rec = await accountFor(request);
      if (!rec) return json({ error: 'ip_used' }, 403);
      const { code } = await readBody(request);
      if (!code) return json({ ok: false, reason: 'no_code' });
      if (rec.referrer) return json({ ok: false, reason: 'already_referred' });
      const ref = await findByRefCode(code);
      if (!ref || String(ref.id) === String(rec.id)) return json({ ok: false, reason: 'invalid' });
      await updateUser(rec.id, { referrer: String(ref.id) });
      await updateUser(ref.id, { referralCount: ref.referralCount + 1 });
      return json({ ok: true, referrerId: String(ref.id) });
    }

    // ---- GET /ref ----------------------------------------------------------
    if (path === '/ref' && method === 'GET') {
      const user = await authed(request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const rec = await accountFor(request);
      if (!rec) return json({ error: 'ip_used' }, 403);
      const code = await ensureRefCode(rec.id);
      return json({
        refCode: code,
        url: `${publicBaseUrl(request)}/?ref=${code}`,
        deepLink: `https://t.me/${cfg.botUsername}?startapp=ref_${code}`,
      });
    }

    // ---- POST /scratch -----------------------------------------------------
    if (path === '/scratch' && method === 'POST') {
      const user = await authed(request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const rec = await accountFor(request);
      if (!rec) return json({ error: 'ip_used' }, 403);

      const missing: string[] = [];
      for (const ch of cfg.channels) {
        if (!(await isChannelMember(rec.id, ch))) missing.push(ch);
      }
      if (missing.length) return json({ error: 'join_channels', missing });
      if (!checkedInToday(rec.lastCheckIn)) return json({ error: 'checkin_required' }, 403);
      if (!rec.scratchCards.length) return json({ error: 'no_cards' }, 400);

      const { cardId } = await readBody(request);
      let idx = cardId ? rec.scratchCards.findIndex((c: any) => String(c.id) === String(cardId)) : 0;
      if (idx === -1) idx = 0;
      const [card] = rec.scratchCards.splice(idx, 1);
      if (!card) return json({ error: 'no_cards' }, 400);

      const amount = randomReward();
      const balance = Math.round((rec.balance + amount) * 100) / 100;
      const scratched = rec.scratched + 1;
      const lastScratchAt = Date.now();
      await updateUser(rec.id, { balance, scratched, lastScratchAt, scratchCards: rec.scratchCards });
      await addTransaction({ userId: String(rec.id), type: 'scratch', amount, card: card.kind, id: card.id });

      return json({
        amount,
        balance,
        cardsLeft: rec.scratchCards.length,
        totalCards: rec.qualifiedCount,
        kind: card.kind || 'any',
        cardId: card.id,
      });
    }

    // ---- GET /referral-status ---------------------------------------------
    if (path === '/referral-status' && method === 'GET') {
      const user = await authed(request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const rec = await accountFor(request);
      if (!rec) return json({ error: 'ip_used' }, 403);
      return json({
        joined: rec.joinedChannels || {},
        joinedAll: cfg.channels.every((ch) => rec.joinedChannels?.[ch]),
      });
    }

    // ---- POST /redeem ------------------------------------------------------
    if (path === '/redeem' && method === 'POST') {
      const user = await authed(request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const rec = await accountFor(request);
      if (!rec) return json({ error: 'ip_used' }, 403);

      const body = await readBody(request);
      const { payout, name, phone, email, country, upi } = body;
      const amount = body.amount ?? rec.balance;
      if (!PAYOUT_METHODS.includes(payout)) return json({ error: 'Invalid payout method' }, 400);
      if (!name || !phone || !email || !country) return json({ error: 'contact_details_required' }, 400);
      if (payout === 'upi' && !upi) return json({ error: 'upi_required' }, 400);

      const fee = cfg.withdrawFee || 0;
      const min = cfg.minWithdraw || 25;
      const amt = Math.round(Number(amount) * 100) / 100;
      if (!amt || amt < min) return json({ error: 'min_redeem' }, 400);
      const total = Math.round((amt + fee) * 100) / 100;
      if (total > rec.balance) {
        if (fee > 0 && amt <= rec.balance && rec.balance < total) return json({ error: 'fee_insufficient' }, 400);
        return json({ error: 'insufficient' }, 400);
      }

      const balance = Math.round((rec.balance - total) * 100) / 100;
      await updateUser(rec.id, { balance });
      const txn = await addTransaction({
        userId: String(rec.id),
        type: 'redeem',
        amount: amt,
        fee,
        payout,
        contact: { name, phone, email, country, upi: upi || null },
        status: 'pending',
        firstName: rec.firstName,
        username: rec.username,
      });
      return json({ amount: amt, fee, payout, balance, requestId: txn?.id, message: 'Redemption requested' });
    }

    // ---- GET /transactions -------------------------------------------------
    if (path === '/transactions' && method === 'GET') {
      const user = await authed(request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const rec = await accountFor(request);
      if (!rec) return json({ error: 'ip_used' }, 403);
      return json({ transactions: await transactionsFor(String(rec.id)) });
    }

    // ---- Admin -------------------------------------------------------------
    if (path.startsWith('/admin/')) {
      if (!(await adminAuthed(request, url))) return json({ error: 'unauthorized' }, 401);

      if (path === '/admin/stats' && method === 'GET') {
        const users = await allUsers();
        const txns = await allTransactions();
        return json({
          users: users.length,
          totalScratches: users.reduce((s, u) => s + u.scratched, 0),
          totalReferrals: users.reduce((s, u) => s + u.referralCount, 0),
          qualifiedReferrals: users.reduce((s, u) => s + u.qualifiedCount, 0),
          totalBalance: users.reduce((s, u) => s + u.balance, 0),
          pendingWithdrawals: txns.filter((t) => t.type === 'redeem' && t.status === 'pending').length,
        });
      }

      if (path === '/admin/withdrawals' && method === 'GET') {
        const txns = await allTransactions();
        return json({ withdrawals: txns.filter((t) => t.type === 'redeem') });
      }

      if (path === '/admin/withdrawals/approve' && method === 'POST') {
        const { id } = await readBody(request);
        if (!id) return json({ error: 'id_required' }, 400);
        const before = (await allTransactions()).find((x) => String(x.id) === String(id));
        if (!before) return json({ error: 'not_found' }, 404);
        if (before.status === 'approved') return json({ ok: true, already: true });
        await updateTransaction(id, { status: 'approved', reviewNote: 'Marked as paid' });
        return json({ ok: true });
      }

      if (path === '/admin/withdrawals/reject' && method === 'POST') {
        const { id, reason } = await readBody(request);
        if (!id) return json({ error: 'id_required' }, 400);
        const before = (await allTransactions()).find((x) => String(x.id) === String(id));
        if (!before) return json({ error: 'not_found' }, 404);
        if (before.status === 'rejected') return json({ ok: true, already: true });
        const t = await updateTransaction(id, { status: 'rejected', reviewNote: reason || 'Rejected' });
        const refunded = before.status === 'pending';
        if (refunded && t) {
          const u = await getUser(t.userId);
          if (u) {
            const bal = Math.round((u.balance + (Number(t.amount) || 0) + (Number(before.fee) || 0)) * 100) / 100;
            await updateUser(t.userId, { balance: bal });
          }
        }
        return json({ ok: true, refunded });
      }

      if (path === '/admin/users' && method === 'GET') {
        const users = await allUsers();
        return json({
          users: users
            .map((u) => ({
              id: String(u.id),
              firstName: u.firstName,
              username: u.username,
              balance: u.balance,
              scratched: u.scratched,
              cards: u.scratchCards.length,
              referralCount: u.referralCount,
              qualifiedCount: u.qualifiedCount,
              joinedAll: cfg.channels.every((ch) => u.joinedChannels?.[ch]),
              joinedExternals: !!u.joinedExternals,
              ip: u.ip || '',
              adRewards: u.adRewards || 0,
              banned: !!u.banned,
              bannedReason: u.bannedReason || '',
            }))
            .sort((a, b) => Number(b.balance) - Number(a.balance)),
        });
      }

      if (path === '/admin/users/balance' && method === 'POST') {
        const { userId, amount } = await readBody(request);
        const amt = Number(amount);
        if (!userId || !Number.isFinite(amt) || amt === 0) return json({ error: 'invalid' }, 400);
        const u = await getUser(userId);
        if (!u) return json({ error: 'not_found' }, 404);
        const bal = Math.max(0, Math.round((u.balance + amt) * 100) / 100);
        await updateUser(userId, { balance: bal });
        await addTransaction({ userId: String(userId), type: 'admin', amount: amt });
        return json({ ok: true, balance: bal });
      }

      if (path === '/admin/send-source' && method === 'POST') {
        return json({ ok: false, error: 'unavailable_on_serverless' }, 400);
      }
    }

    return json({ error: 'not_found', path }, 404);
  } catch (err: any) {
    console.error('[fap-api]', path, err?.message);
    return json({ error: 'server_error', message: err?.message || 'unknown' }, 500);
  }
}

export const Route = createFileRoute('/api/public/fap/$')({
  server: {
    handlers: {
      GET: ({ request, params }) => handle(request, params),
      POST: ({ request, params }) => handle(request, params),
      OPTIONS: ({ request, params }) => handle(request, params),
    },
  },
});
