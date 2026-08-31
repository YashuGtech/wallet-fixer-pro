const API = '/api/public/fap';
const $ = (s) => document.querySelector(s);
const keyStorage = 'fap_admin_key';

// Telegram WebApp login data (if the dashboard is opened from Telegram).
// Falls back to initData passed by the mini app as a query param.
const tg = window.Telegram?.WebApp;
const initData =
  tg?.initData ||
  new URLSearchParams(location.search).get('initData') ||
  '';

let key = localStorage.getItem(keyStorage) || '';

const PAYOUT_LABEL = { flipkart: 'Flipkart', amazon: 'Amazon', play: 'Play Store', upi: 'UPI' };

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-admin-key': key };
  // Passing valid Telegram initData lets the server authorize the admin by
  // Telegram id alone — no key required for the admin.
  if (initData) headers['x-init-data'] = initData;
  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'request failed');
  return json;
}

function money(n) { return '₹' + (Number(n) || 0).toFixed(2); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) {
  if (!ts) return '—';
  try { return new Date(Number(ts)).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
}

function showLogin() {
  $('#login').hidden = false;
  $('#dash').hidden = true;
}

function showDash() {
  $('#login').hidden = true;
  $('#dash').hidden = false;
  load();
}

let mode = 'withdrawals';

async function load() {
  try {
    const st = await api('/admin/stats');
    $('#stats').innerHTML =
      `<span>Users: <b>${st.users}</b></span>` +
      `<span>Balance: <b>${money(st.totalBalance)}</b></span>` +
      `<span>Pending: <b>${st.pendingWithdrawals}</b></span>`;
  } catch (e) {
    $('#stats').innerHTML = '<span class="err">stats failed</span>';
  }
  if (mode === 'users') await loadUsers();
  else await loadWithdrawals();
}

async function loadWithdrawals() {
  const list = $('#list');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { withdrawals } = await api('/admin/withdrawals');
    if (!withdrawals.length) { list.innerHTML = '<p class="muted">No withdrawal requests yet.</p>'; return; }
    list.innerHTML = withdrawals.map((w) => txnCard(w)).join('');
    wireCards();
  } catch (e) {
    list.innerHTML = `<p class="err">Error: ${esc(e.message)}</p>`;
  }
}

async function loadUsers() {
  const list = $('#list');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { users } = await api('/admin/users');
    if (!users.length) { list.innerHTML = '<p class="muted">No users yet.</p>'; return; }
    list.innerHTML = users.map((u) =>
      `<div class="txn" data-uid="${esc(u.id)}">` +
      `<div class="txn-top"><span class="amount">${esc(u.firstName || u.username || u.id)}</span><span class="badge">${u.cards} cards</span></div>` +
      `<div class="txn-meta"><span>@${esc(u.username || '—')} · ID ${esc(u.id)} · ${esc(u.ip || 'no-ip')}</span></div>` +
      `<div class="txn-meta"><span>Ref ${u.referralCount} · Qual ${u.qualifiedCount} · Scratched ${u.scratched}</span></div>` +
      `<div class="txn-meta"><span>Balance: <b>${money(u.balance)}</b></span></div>` +
      `<div class="actions">` +
      `<input class="reason bal" placeholder="+/- ₹" />` +
      `<button class="btn ok act-balance">Apply</button>` +
      `</div></div>`
    ).join('');
    document.querySelectorAll('.act-balance').forEach((b) => {
      b.addEventListener('click', async () => {
        const card = b.closest('.txn');
        const userId = card.dataset.uid;
        const amount = Number(card.querySelector('.bal')?.value);
        if (!Number.isFinite(amount) || amount === 0) { alert('Enter an amount'); return; }
        try {
          await api('/admin/users/balance', { method: 'POST', body: { userId, amount } });
          alert('Balance updated.');
          loadUsers();
        } catch (e) { alert('Error: ' + e.message); }
      });
    });
  } catch (e) {
    list.innerHTML = `<p class="err">Error: ${esc(e.message)}</p>`;
  }
}

function txnCard(w) {
  const c = w.contact || {};
  const statusClass = w.status === 'approved' ? 'badge ok' : w.status === 'rejected' ? 'badge no' : 'badge';
  return `<div class="txn" data-id="${esc(w.id)}" data-status="${esc(w.status || 'pending')}">
    <div class="txn-top">
      <span class="amount">${money(w.amount)}</span>
      <span class="${statusClass}">${w.status === 'approved' ? 'paid' : esc(w.status || 'pending')}</span>
    </div>
    <div class="txn-meta">
      <span>${PAYOUT_LABEL[w.payout] || esc(w.payout)}</span>
      <span>@${esc(w.username || '—')} · ID ${esc(w.userId)}</span>
      <span>${fmtTime(w.ts)}</span>
    </div>
    <div class="txn-contact">
      <span>Name: <b>${esc(c.name || '—')}</b></span>
      <span>Phone: <b>${esc(c.phone || '—')}</b></span>
      <span>Email: <b>${esc(c.email || '—')}</b></span>
      <span>Country: <b>${esc(c.country || '—')}</b></span>
    </div>
    ${w.reviewNote && w.status !== 'pending' ? `<div class="note">Note: ${esc(w.reviewNote)}</div>` : ''}
    <div class="actions">
      <button class="btn ok act-approve">Mark as Paid</button>
      <button class="btn ghost act-reject">Reject</button>
      <input class="reason" placeholder="Reject reason (required)" />
    </div>
  </div>`;
}

function wireCards() {
  document.querySelectorAll('.act-approve').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.closest('.txn').dataset.id;
      if (!confirm('Mark this withdrawal as paid?')) return;
      try {
        await api('/admin/withdrawals/approve', { method: 'POST', body: { id } });
        alert('Marked as paid.');
        load();
      } catch (e) { alert('Error: ' + e.message); }
    });
  });
  document.querySelectorAll('.act-reject').forEach((b) => {
    b.addEventListener('click', async () => {
      const card = b.closest('.txn');
      const id = card.dataset.id;
      const reason = (card.querySelector('.reason')?.value || '').trim();
      if (!reason) { alert('Enter a reason before rejecting.'); return; }
      if (!confirm('Reject this withdrawal and refund the user?')) return;
      try {
        await api('/admin/withdrawals/reject', { method: 'POST', body: { id, reason } });
        alert('Rejected. User refunded.');
        load();
      } catch (e) { alert('Error: ' + e.message); }
    });
  });
}

$('#loginBtn').addEventListener('click', async () => {
  const attempt = $('#keyInput').value.trim();
  if (!attempt) { $('#loginMsg').textContent = 'Enter the admin key.'; return; }
  key = attempt;
  try {
    await api('/admin/stats');
    localStorage.setItem(keyStorage, key);
    showDash();
  } catch {
    $('#loginMsg').textContent = 'Wrong admin key.';
  }
});
$('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });

$('#refreshBtn').addEventListener('click', load);
$('#logoutBtn').addEventListener('click', () => { localStorage.removeItem(keyStorage); key = ''; showLogin(); });

$('#tabWithdrawals').addEventListener('click', () => {
  mode = 'withdrawals';
  $('#tabWithdrawals').classList.add('active');
  $('#tabUsers').classList.remove('active');
  load();
});
$('#tabUsers').addEventListener('click', () => {
  mode = 'users';
  $('#tabUsers').classList.add('active');
  $('#tabWithdrawals').classList.remove('active');
  load();
});

(async function init() {
  // If opened from Telegram as the admin, authorize by Telegram id (no key).
  if (initData) {
    try { await api('/admin/stats'); showDash(); return; } catch { /* not the admin via Telegram */ }
  }
  if (key) {
    try { await api('/admin/stats'); showDash(); return; } catch { /* fall through to login */ }
  }
  showLogin();
})();