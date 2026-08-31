/* eslint-disable @typescript-eslint/no-explicit-any */
// Postgres (Neon) backed store — 1:1 port of the original store-pg.js.
import { neon } from '@neondatabase/serverless';

let _sql: any = null;
function db() {
  if (!_sql) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is not configured');
    _sql = neon(url);
  }
  return _sql;
}

const SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    firstName TEXT DEFAULT '',
    username TEXT DEFAULT '',
    balance DOUBLE PRECISION DEFAULT 0,
    referrer TEXT,
    referralCount INTEGER DEFAULT 0,
    qualifiedCount INTEGER DEFAULT 0,
    scratchCards JSONB DEFAULT '[]',
    scratched INTEGER DEFAULT 0,
    lastScratchAt BIGINT,
    joinedChannels JSONB DEFAULT '{}',
    joinedExternals BOOLEAN DEFAULT false,
    ip TEXT,
    adRewards DOUBLE PRECISION DEFAULT 0,
    banned BOOLEAN DEFAULT false,
    bannedAt BIGINT,
    bannedReason TEXT,
    credited BOOLEAN DEFAULT false,
    lastCheckIn BIGINT,
    checkInCount INTEGER DEFAULT 0,
    refCode TEXT,
    updatedAt TEXT,
    lastChannelCheck BIGINT,
    channelCheckCache JSONB DEFAULT '[]'
  )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS lastChannelCheck BIGINT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS channelCheckCache JSONB DEFAULT '[]'`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    userId TEXT,
    type TEXT,
    amount DOUBLE PRECISION DEFAULT 0,
    fee DOUBLE PRECISION DEFAULT 0,
    card TEXT,
    payout TEXT,
    contact JSONB,
    status TEXT,
    reviewNote TEXT,
    firstName TEXT,
    username TEXT,
    ts BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions (userId)`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee DOUBLE PRECISION DEFAULT 0`,
];

let initialized = false;
async function ensureSchema() {
  if (initialized) return;
  const sql = db();
  for (const stmt of SCHEMA_STMTS) await sql.query(stmt);
  initialized = true;
}

export type FapUser = {
  id: string;
  refCode: string | null;
  firstName: string;
  username: string;
  balance: number;
  referrer: string | null;
  referralCount: number;
  qualifiedCount: number;
  scratchCards: any[];
  scratched: number;
  lastScratchAt: number | null;
  joinedChannels: Record<string, boolean>;
  joinedExternals: boolean;
  ip: string | null;
  adRewards: number;
  banned: boolean;
  bannedAt: number | null;
  bannedReason: string | null;
  credited: boolean;
  lastCheckIn: number | null;
  checkInCount: number;
  lastChannelCheck: number | null;
  channelCheckCache: string[];
};

function mapRow(r: any): FapUser | null {
  if (!r) return null;
  return {
    id: String(r.id),
    refCode: r.refcode || null,
    firstName: r.firstname || '',
    username: r.username || '',
    balance: Number(r.balance) || 0,
    referrer: r.referrer || null,
    referralCount: Number(r.referralcount) || 0,
    qualifiedCount: Number(r.qualifiedcount) || 0,
    scratchCards: Array.isArray(r.scratchcards) ? r.scratchcards : [],
    scratched: Number(r.scratched) || 0,
    lastScratchAt: r.lastscratchat ?? null,
    joinedChannels: r.joinedchannels && typeof r.joinedchannels === 'object' ? r.joinedchannels : {},
    joinedExternals: !!r.joinedexternals,
    ip: r.ip || null,
    adRewards: Number(r.adrewards) || 0,
    banned: !!r.banned,
    bannedAt: r.bannedat || null,
    bannedReason: r.bannedreason || null,
    credited: !!r.credited,
    lastCheckIn: r.lastcheckin || null,
    checkInCount: Number(r.checkincount) || 0,
    lastChannelCheck: r.lastchannelcheck || null,
    channelCheckCache: Array.isArray(r.channelcheckcache) ? r.channelcheckcache : [],
  };
}

function mapTxn(t: any) {
  if (!t) return null;
  return {
    id: String(t.id),
    userId: String(t.userid),
    type: t.type,
    amount: Number(t.amount) || 0,
    fee: Number(t.fee) || 0,
    card: t.card || null,
    payout: t.payout || null,
    contact: t.contact || null,
    status: t.status || null,
    reviewNote: t.reviewnote || null,
    firstName: t.firstname || null,
    username: t.username || null,
    ts: Number(t.ts),
  };
}

export async function getUser(id: string | number): Promise<FapUser | null> {
  await ensureSchema();
  const rows = await db()`SELECT * FROM users WHERE id = ${String(id)}`;
  return mapRow(rows[0]);
}

export async function getOrCreateUser(
  id: string | number,
  profile: { firstName?: string | undefined; username?: string | undefined } = {},
): Promise<FapUser | null> {
  await ensureSchema();
  const existing = await getUser(id);
  if (existing) return existing;
  const sql = db();
  await sql`
    INSERT INTO users (id, firstName, username, balance, referrer, referralCount,
      qualifiedCount, scratchCards, scratched, lastScratchAt, joinedChannels,
      joinedExternals, ip, banned, bannedAt, bannedReason, credited, lastCheckIn,
      checkInCount, adRewards, updatedAt)
    VALUES (${String(id)}, ${profile.firstName || ''}, ${profile.username || ''}, 0,
      ${null}, 0, 0, ${JSON.stringify([])}, 0, ${null}, ${JSON.stringify({})}, false,
      ${null}, false, ${null}, ${null}, false, ${null}, 0, 0, ${new Date().toISOString()})
    ON CONFLICT (id) DO NOTHING
  `;
  return getUser(id);
}

export async function updateUser(id: string | number, patch: Record<string, any>) {
  await ensureSchema();
  const sets: string[] = [];
  const vals: any[] = [];
  const allowed = [
    'firstName', 'username', 'balance', 'referrer', 'referralCount',
    'qualifiedCount', 'scratchCards', 'scratched', 'lastScratchAt',
    'joinedChannels', 'joinedExternals', 'ip', 'adRewards', 'banned',
    'bannedAt', 'bannedReason', 'credited', 'lastCheckIn', 'checkInCount', 'refCode',
    'lastChannelCheck', 'channelCheckCache',
  ];
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = $${vals.length + 1}`);
      const v = patch[k];
      vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    }
  }
  if (!sets.length) return null;
  sets.push(`updatedAt = $${vals.length + 1}`);
  vals.push(new Date().toISOString());
  vals.push(String(id));
  await db().query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  return null;
}

export async function allUsers(): Promise<FapUser[]> {
  await ensureSchema();
  const rows = await db()`SELECT * FROM users`;
  return (rows || []).map(mapRow).filter(Boolean) as FapUser[];
}

export async function addTransaction(t: any) {
  await ensureSchema();
  const rec = {
    id: String(t.id ?? Date.now() + Math.random().toString(36).slice(2, 8)),
    userId: String(t.userId),
    type: t.type,
    amount: Number(t.amount) || 0,
    fee: Number(t.fee) || 0,
    card: t.card || null,
    payout: t.payout || null,
    contact: t.contact || null,
    status: t.status || null,
    reviewNote: t.reviewNote || null,
    firstName: t.firstName || null,
    username: t.username || null,
    ts: t.ts || Date.now(),
  };
  await db()`
    INSERT INTO transactions (id, userId, type, amount, fee, card, payout, contact,
      status, reviewNote, firstName, username, ts)
    VALUES (${rec.id}, ${rec.userId}, ${rec.type}, ${rec.amount}, ${rec.fee}, ${rec.card},
      ${rec.payout}, ${rec.contact ? JSON.stringify(rec.contact) : null},
      ${rec.status}, ${rec.reviewNote}, ${rec.firstName}, ${rec.username}, ${rec.ts})
  `;
  return rec;
}

export async function updateTransaction(id: string, patch: Record<string, any>) {
  await ensureSchema();
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of ['status', 'reviewNote', 'amount', 'fee', 'payout', 'contact']) {
    if (k in patch) {
      sets.push(`${k} = $${vals.length + 1}`);
      const v = patch[k];
      vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    }
  }
  if (!sets.length) return null;
  vals.push(String(id));
  const rows = await db().query(
    `UPDATE transactions SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals,
  );
  return mapTxn(rows[0]);
}

export async function transactionsFor(userId: string) {
  await ensureSchema();
  const rows = await db()`SELECT * FROM transactions WHERE userId = ${String(userId)} ORDER BY ts DESC`;
  return (rows || []).map(mapTxn);
}

export async function allTransactions() {
  await ensureSchema();
  const rows = await db()`SELECT * FROM transactions ORDER BY ts DESC`;
  return (rows || []).map(mapTxn) as any[];
}

export async function ensureRefCode(id: string | number) {
  await ensureSchema();
  const u = await getUser(id);
  if (!u) return null;
  if (u.refCode) return u.refCode;
  const sql = db();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    let s = '';
    for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    code = s;
  } while ((await sql`SELECT 1 FROM users WHERE refCode = ${code}`).length);
  await sql`UPDATE users SET refCode = ${code}, updatedAt = ${new Date().toISOString()} WHERE id = ${String(id)}`;
  return code;
}

export async function findByRefCode(code: string) {
  if (!code) return null;
  await ensureSchema();
  const rows = await db()`SELECT * FROM users WHERE UPPER(refCode) = ${String(code).toUpperCase()}`;
  return mapRow(rows[0]);
}
