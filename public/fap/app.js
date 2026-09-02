// ---- Telegram Mini App boot -------------------------------------------------
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}
const initData =
  tg?.initData || new URLSearchParams(location.search).get('initData') || '';

// API root: same-origin wherever the app is served. On the VPS the API lives
// at /fap/api; on Vercel (full app, serverless) it is /fap/api under /fap or
// /api at the root — both route to the same Express app, so data always loads
// without hardcoding a host.
const API_BASE = '/api/public/fap';

let me = null;
let txns = [];

const $ = (sel) => document.querySelector(sel);

// ---- 60-minute ad-free access window ---------------------------------------
// One ad on check-in unlocks the app for 60 minutes: no more ads and no extra
// confirmation prompts while scratching inside that window.
function accessMsLeft() {
  return Math.max(0, (me?.accessUntil || 0) - Date.now());
}
function hasAccess() {
  return accessMsLeft() > 0;
}
function fmtLeft(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + 'm ' + String(s).padStart(2, '0') + 's';
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- Rewarded ad (Adsgram — in-app, no window jump) ----------------------------
// AdController is created once per block id and reused. show() plays the ad
// inside the mini-app; resolves true only when the user watches to the end.
// Ads OFF until further notice. If a block id is set AND the SDK is present the
// rewarded ad still plays in-app; otherwise we unlock instantly (no ad gate).
// ---- Rewarded / interstitial ad (Monetag first, then Adsgram) -----------------
// Ads play in-app before a scratch. Monetag uses a global <zone> callback
// (e.g. show_11686396()) that resolves after the user watches; Adsgram is the
// fallback. Ads are OFF until a zone id / block id is configured.
let _adController = null;
let _adsEnabled = false;

// Resolve the Monetag zone id (backend value wins over the page default).
function monetagFn() {
  const zone = me?.monetagZone || window.__MONETAG_ZONE__;
  if (!zone) return null;
  const fnName = 'show_' + zone;
  return (typeof window !== 'undefined' && typeof window[fnName] === 'function') ? window[fnName].bind(window) : null;
}

// Resolve a possibly-never-resolving ad promise within a timeout. Ad SDKs
// (Monetag especially) return a promise that hangs forever when there's no ad
// inventory, which left the app stuck on "Ad loading…". A hard cap guarantees
// the scratch flow can never hang — it just counts the ad as unwatched and
// lets the user retry.
function withAdTimeout(promise, ms = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    promise.then(finish, () => finish(false));
    setTimeout(() => finish(false), ms);
  });
}

// Wait (briefly) for the Monetag SDK global to appear — the SDK script loads
// async, so on a cold open the zone function may not exist for a few hundred ms.
async function monetagFnReady(ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const fn = monetagFn();
    if (fn) return fn;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Preload the rewarded ad in the background WITHOUT showing it (SDK type
// 'preload'), so it plays instantly when the user taps "Yes, Scratch" /
// "Check in". Never displays, never blocks, never hangs. Re-armed after each
// played ad so the next one is instant too.
let _preloaded = false;
async function preloadMonetag() {
  if (!_adsEnabled || _preloaded) return;
  _preloaded = true;
  const fn = await monetagFnReady();
  if (!fn) { _preloaded = false; return; }
  try {
    Promise.resolve(fn({ type: 'preload', ymid: 'fap', timeout: 5 })).catch(() => {});
  } catch { /* preload is best-effort */ }
}

// Play the rewarded interstitial. Plain show_<zone>() call (Monetag's
// documented rewarded-interstitial usage) — it shows instantly using the
// preloaded ad and resolves once the user has seen the ad.
async function playMonetag() {
  const fn = await monetagFnReady(2500);
  if (!fn) return false;
  try {
    const res = await withAdTimeout(Promise.resolve(fn()).then(() => true));
    // Re-arm the preload for the next scratch.
    _preloaded = false;
    setTimeout(() => { preloadMonetag(); }, 500);
    return res !== false;
  } catch {
    return false;
  }
}



async function playRewardedAd() {
  if (!_adsEnabled) return false;
  // Prefer Monetag; fall back to Adsgram if Monetag isn't available/times out.
  if (await playMonetag()) return true;
  const res = await withAdTimeout(new Promise((resolve) => {
    const blockId = me?.adsgramBlockId || window.__ADSGRAM_BLOCK_ID__;
    if (!blockId || typeof window.Adsgram?.init !== 'function') { resolve(false); return; }
    try {
      if (!_adController) _adController = window.Adsgram.init({ blockId });
      _adController.show().then((res2) => resolve(!!(res2 && (res2.done !== false)))).catch(() => resolve(false));
    } catch (e) {
      resolve(false);
    }
  }));
  return !!res;
}

// Enable ads when a Monetag zone or an Adsgram block id is configured, either
// from the backend (/me) or from the page defaults in index.html.
function configureAds() {
  _adsEnabled = !!(
    me?.monetagZone || me?.adsgramBlockId ||
    window.__MONETAG_ZONE__ || window.__ADSGRAM_BLOCK_ID__
  );
  _adController = null;
}

// Arm ads immediately on load using the page defaults so the very first
// scratch already has a cached ad (the backend /me call re-runs this later).
configureAds();
preloadMonetag();



// ---- Scratch confirmation modal -----------------------------------------------
const scratchModal = $('#scratchModal');
const modalYes = $('#modalYes');
const modalNo = $('#modalNo');
const MODAL_YES_HTML = modalYes ? modalYes.innerHTML : 'Yes, Scratch';
let pendingStart = null; // { tileCard, revealNow }
let modalBusy = false;

function askScratchConfirmation(tileCard, actions) {
  // Inside the 60-minute window the card scratches straight away — no ad,
  // no confirmation question.
  if (hasAccess()) {
    tileCard.unlocked = true;
    if (typeof actions.revealNow === 'function') actions.revealNow();
    return;
  }
  if (modalBusy) return;
  modalBusy = true;
  pendingStart = { tileCard, revealNow: actions.revealNow };
  scratchModal.hidden = false;
}

function closeScratchModal() {
  scratchModal.hidden = true;
  modalBusy = false;
  pendingStart = null;
}

modalNo.addEventListener('click', closeScratchModal);

function reopenScratchModal(p) {
  // Let the user retry the ad. We keep the card LOCKED until an ad actually
  // plays to completion — no scratch is allowed without watching the ad.
  pendingStart = p;
  modalBusy = false;
  scratchModal.hidden = false;
  const btn = modalYes;
  if (btn) { btn.disabled = false; btn.innerHTML = MODAL_YES_HTML; }
  // Validate the prize label so the confirmation text stays accurate.
  if (scratchModal.querySelector('p')) {
    scratchModal.querySelector('p').textContent =
      "You're about to scratch a card.\nScratch is unlocked once you watch the ad.\nDo you want to scratch it now?";
  }
}

modalYes.addEventListener('click', async () => {
  const p = pendingStart;
  if (!p || modalBusy) return;
  modalBusy = true;

  // Lock the button while the ad loads so double-taps can't double-fire.
  const btn = modalYes;
  btn.disabled = true;
  btn.innerHTML = 'Ad loading…';

  try {
    if (_adsEnabled) {
      // User confirmed a scratch: play the Monetag rewarded interstitial FIRST.
      // Scratch unlocks ONLY inside .then() — after the user has seen the ad.
      const card = p.tileCard;
      toast('Ad loading…');
      const showAd = await monetagFnReady(2500);
      const unlockAndScratch = () => {
        scratchModal.hidden = true;
        modalBusy = false;
        pendingStart = null;
        card.unlocked = true;
        if (typeof p.revealNow === 'function') p.revealNow();
      };
      if (showAd) {
        // Rewarded interstitial — show_11686396().then(...) runs after the
        // user watches the ad, and only then is the card scratched.
        try {
          showAd().then(() => {
            toast('Ad watched — you won!');
            unlockAndScratch();
          }).catch(() => {
            // Ad closed / failed — fall back to Adsgram, else unlock.
            playRewardedAd().finally(unlockAndScratch);
          });
        } catch {
          playRewardedAd().finally(unlockAndScratch);
        }
      } else {
        // Monetag SDK not present — try Adsgram, then unlock.
        playRewardedAd().finally(unlockAndScratch);
      }
      return;
    }


    // Ads disabled (no zone configured): unlock + pop the card immediately.
    scratchModal.hidden = true;
    modalBusy = false;
    pendingStart = null;
    p.tileCard.unlocked = true;
    if (typeof p.revealNow === 'function') p.revealNow();
  } finally {
    btn.disabled = false;
    btn.innerHTML = MODAL_YES_HTML;
  }
});

// ---- Inline SVG icons (dynamic content) ---------------------------------------
const COPY_SVG = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>';
const CHECK_SVG = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>';
const ARROW_DOWN_SVG = '<svg class="txn-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14" /><path d="M5 12l7 7 7-7" /></svg>';
const ARROW_UP_SVG = '<svg class="txn-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>';
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>';
// Green tick used on PAID withdrawals in the wallet transaction list.
const TICK_SVG = '<svg class="txn-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>';
// Payout method labels.
const PAYOUT_LABEL = { flipkart: 'Flipkart', amazon: 'Amazon', play: 'Play Store', upi: 'UPI' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-init-data': initData,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'request failed');
  return json;
}

// ---- Tab navigation ----------------------------------------------------------
function switchPage(name) {
  document.querySelectorAll('.page').forEach((p) => {
    p.classList.toggle('active', p.id === 'page-' + name);
  });
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.page === name);
  });
}
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchPage(t.dataset.page));
});

const initialPage = new URLSearchParams(location.search).get('page');
if (initialPage && ['home', 'refer', 'wallet', 'admin'].includes(initialPage)) {
  switchPage(initialPage);
}

const KIND_LABEL = { welcome: 'Welcome', referral: 'Referral' };

// ---- Home: balance + earned card grid (inline scratch tiles) -------------------
function renderHome() {
  if ($('#balance')) $('#balance').textContent = me.balance.toFixed(2);
  if ($('#balanceChip')) $('#balanceChip').textContent = me.balance.toFixed(2);
  if ($('#scratchedSub')) $('#scratchedSub').textContent = `${me.scratched} card(s) scratched`;

  const cards = (me.cards || []).slice(0, 12); // 2 cols x 6 rows
  if ($('#cardCount')) $('#cardCount').textContent = cards.length;
  // Live counter: X of Y cards remaining to scratch (updates on scratch + referral).
  const remaining = cards.length;
  const total = Math.max(remaining, me.totalCards ?? remaining);
  const el = $('#cardsRemaining');
  if (el) el.textContent = `${remaining} of ${total} cards remaining to scratch`;

  const grid = $('#cardsGrid');
  grid.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const c = cards[i];
    if (!c) {
      const empty = document.createElement('div');
      empty.innerHTML = '<svg class="tile-icon" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 9h20" /></svg>';
      empty.className = 'card-tile empty';
      grid.appendChild(empty);
      continue;
    }
    grid.appendChild(buildScratchTile(c, grid));
  }
}

// Build one inline scratch card — paints the cover the first time it mounts,
// then reveals the server prize once a threshold of the foil is scratched.
function buildScratchTile(card, grid) {
  const tile = document.createElement('div');
  tile.className = 'card-tile';

  const prize = document.createElement('div');
  prize.className = 'prize';
  prize.style.display = 'none';
  prize.innerHTML =
    `<span class="youwon">${KIND_LABEL[card.kind] || 'Card'} · You won</span>` +
    `<span class="amount">₹—</span>`;
  tile.appendChild(prize);

  const canvas = document.createElement('canvas');
  canvas.className = 'scratch';
  tile.appendChild(canvas);

  let revealed = false;
  let notified = false;
  let drawing = false;
  let painted = false;

  const dpr = window.devicePixelRatio || 1;

  function paintCover() {
    const rect = tile.getBoundingClientRect();
    const w = Math.max(2, Math.floor(rect.width));
    const h = Math.max(2, Math.floor(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#c8b6f5');
    g.addColorStop(0.5, '#a5e3d3');
    g.addColorStop(1, '#b8cdf7');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '600 13px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SCRATCH ME', w / 2, h / 2 + 2);
    painted = true;
  }

  // Smooth scratching: erase along the pointer path with a thick round stroke
  // (instead of isolated dots) and sample coverage only every few strokes, so
  // the gesture stays buttery even on low-end phones.
  let lastPt = null;
  let sampleTick = 0;

  function scratchAt(clientX, clientY) {
    if (revealed || !painted) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 46;
    ctx.beginPath();
    if (lastPt) {
      ctx.moveTo(lastPt.x, lastPt.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, 23, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    lastPt = { x, y };

    if (++sampleTick % 4 !== 0) return;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let cleared = 0;
    let checked = 0;
    for (let i = 3; i < data.length; i += 160) {
      checked++;
      if (data[i] === 0) cleared++;
    }
    if (checked && cleared / checked > 0.32 && !notified) {
      notified = true;
      reveal();
    }
  }


  function reveal() {
    revealed = true;
    canvas.style.pointerEvents = 'none';
    // Fade the remaining foil away instead of snapping it off.
    canvas.style.transition = 'opacity .28s ease, transform .28s ease';
    canvas.style.opacity = '0';
    canvas.style.transform = 'scale(1.04)';
    canvas.classList.add('revealed');
    prize.style.display = 'flex';
    prize.style.animation = 'pop 0.45s var(--ease-clay) both';
    prize.querySelector('.amount').textContent = '₹…';
    stake(card, prize, tile);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!card.unlocked) {
      // Reward gate: ask for confirmation, play an ad, then the card pops
      // open and grants automatically (revealNow) — no manual dragging.
      askScratchConfirmation(card, { revealNow: reveal });
      return;
    }
    drawing = true;
    lastPt = null;
    canvas.setPointerCapture(e.pointerId);
    scratchAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!card.unlocked || !drawing) return;
    e.preventDefault();
    // Use coalesced points so fast swipes erase a continuous path.
    const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (pts.length) for (const p of pts) scratchAt(p.clientX, p.clientY);
    else scratchAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerup', () => { drawing = false; lastPt = null; });
  canvas.addEventListener('pointercancel', () => { drawing = false; lastPt = null; });

  // Paint once the tile is in the layout.
  requestAnimationFrame(() => {
    paintCover();
    const ro = new ResizeObserver(() => paintCover());
    ro.observe(tile);
    setTimeout(() => { if (!painted) paintCover(); }, 60);
  });

  return tile;
}

async function stake(card, prize, tile) {
  const amountEl = prize.querySelector('.amount');
  try {
    const r = await api(API_BASE + '/scratch', { method: 'POST', body: { cardId: card.id } });
    if (r.error) {
      if (r.error === 'join_channels') {
        amountEl.style.display = 'none';
        prize.querySelector('.youwon').textContent = '';
        const missing = (r.missing || []).map((m) => m.replace('@', '')).join(', ');
        prize.insertAdjacentHTML('beforeend', '<div class="locked">' + LOCK_SVG + '<span class="locked-txt">Join: ' + missing + '</span></div>');
        toast('Join the channels to scratch');
      } else {
        amountEl.textContent = '—';
        toast(r.error);
      }
      return;
    }
    amountEl.textContent = '₹' + r.amount.toFixed(2);
    me.balance = r.balance;
    me.scratchCards = r.cardsLeft;
    me.scratched += 1;
    me.totalCards = r.totalCards ?? me.totalCards;
    // Update the live counter right away, then refresh the whole grid.
    const remEl = $('#cardsRemaining');
    if (remEl) remEl.textContent = `${r.cardsLeft} of ${me.totalCards} cards remaining to scratch`;
    if ($('#balance')) $('#balance').textContent = me.balance.toFixed(2);
    if ($('#balanceChip')) $('#balanceChip').textContent = me.balance.toFixed(2);
    if ($('#scratchedSub')) $('#scratchedSub').textContent = `${me.scratched} card(s) scratched`;
    toast('You won ₹' + r.amount.toFixed(2) + '!');
    // All cards done — mark completion so the user knows to refer for more.
    if (r.cardsLeft <= 0) {
      setTimeout(() => toast('🎉 All cards completed! Refer friends to earn more cards'), 1800);
    }
    refreshAll();
  } catch (e) {
    amountEl.textContent = '—';
    toast('Error: ' + e.message);
  }
}

$('#scratchBtn').addEventListener('click', () => {
  if (!me) return;
  if (!(me.cards || []).length) {
    toast('No cards yet — refer friends to earn cards');
    return;
  }
  const sec = $('#cardsSection');
  if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Drag across a card to scratch it by hand');
});

// ---- Refer: link + daily earnings ---------------------------------------------
async function renderRefer() {
  try {
    const r = await api(API_BASE + '/ref');
    // Prefer the one-tap t.me deep link — tapping it opens the Mini App
    // directly with the ref attached. Fall back to the browser link.
    $('#refLink').value = r.deepLink || r.url;
  } catch {
    $('#refLink').value = 'Open from Telegram bot';
  }
  $('#refCount').textContent = me.referralCount;
  $('#qualCount').textContent = me.qualifiedCount;

  const startToday = new Date().setHours(0, 0, 0, 0);
  const startYesterday = startToday - 86400000;
  const endToday = startToday + 86400000;
  let today = 0;
  let yesterday = 0;
  for (const t of txns) {
    if (t.type !== 'scratch') continue;
    if (t.ts >= startToday && t.ts < endToday) today += t.amount;
    else if (t.ts >= startYesterday && t.ts < startToday) yesterday += t.amount;
  }
  $('#earnToday').textContent = '₹' + today.toFixed(2);
  $('#earnYesterday').textContent = '₹' + yesterday.toFixed(2);
}

let copied = false;

// Copy with a fallback that works inside the Telegram mini-app webview, where
// navigator.clipboard is often blocked (needs secure context + permission).
function copyText(text) {
  return new Promise((resolve) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(resolve).catch(() => legacyCopy(text, resolve));
    } else {
      legacyCopy(text, resolve);
    }
  });
}

function legacyCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    document.execCommand('copy');
    document.body.removeChild(ta);
    done(true);
  } catch {
    done(false);
  }
}

$('#copyBtn').addEventListener('click', async () => {
  const url = $('#refLink').value;
  const ok = await copyText(url);
  copied = true;
  $('#copyBtn').innerHTML = CHECK_SVG;
  toast(ok ? 'Referral link copied' : 'Long-press the link to copy');
  setTimeout(() => { copied = false; $('#copyBtn').innerHTML = COPY_SVG; }, 2200);
  // Open Telegram's share sheet so the link can be sent straight to a friend.
  if (tg?.openTelegramLink) tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent('Join me on FAP Rewards and scratch cards for cash! 💰'));
});
$('#copyBtn').innerHTML = COPY_SVG;

// ---- Wallet: withdraw + transactions -------------------------------------------

function renderWallet() {
  $('#walletBalance').textContent = me.balance.toFixed(2);
  const list = $('#txnList');
  list.innerHTML = '';
  if (!txns.length) {
    list.innerHTML = '<div class="txn-empty">No transactions yet</div>';
    return;
  }
  for (const t of txns) {
    const item = document.createElement('div');
    const isRedeem = t.type === 'redeem';
    // Anything that is not a withdrawal adds money to the wallet.
    const credit = !isRedeem;
    const st = t.status || 'pending';
    const paid = isRedeem && st === 'approved';
    const rejected = isRedeem && st === 'rejected';
    item.className = 'txn-item' + (paid ? ' paid' : '');

    const statusHtml = isRedeem
      ? paid
        ? `<span class="txn-badge paid">${TICK_SVG}Paid</span>`
        : rejected
          ? '<span class="txn-badge no">Rejected</span>'
          : '<span class="txn-badge">Pending</span>'
      : '';

    const label = isRedeem
      ? 'Withdrawal' + (PAYOUT_LABEL[t.payout] ? ` · ${PAYOUT_LABEL[t.payout]}` : '')
      : t.type === 'scratch'
        ? 'Scratch reward'
        : t.type === 'referral'
          ? 'Referral bonus'
          : t.type === 'admin'
            ? 'Bonus credit'
            : 'Credit';

    const d = new Date(t.ts);
    const time = d.toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    // Rejected withdrawals are refunded, so the money came back to the wallet.
    const subtitle = paid ? `Paid · ${time}` : rejected ? `Refunded · ${time}` : time;
    const tone = credit ? 'credit' : paid ? 'paid' : 'debit';
    const icon = credit ? ARROW_DOWN_SVG : paid ? TICK_SVG : ARROW_UP_SVG;
    const feeHtml =
      isRedeem && Number(t.fee) > 0
        ? `<span class="txn-fee">+ ₹${Number(t.fee).toFixed(2)} fee</span>`
        : '';

    item.innerHTML =
      `<span class="txn-icon ${tone}">${icon}</span>` +
      `<span class="txn-body"><span class="txn-label">${label}${statusHtml}</span>` +
      `<span class="txn-time">${subtitle}${feeHtml}</span></span>` +
      `<span class="txn-amount ${tone}"><span class="sign">${credit ? '+' : '−'}</span>₹${Number(t.amount).toFixed(2)}</span>`;
    list.appendChild(item);
  }
}


// Only payout-method buttons are part of the selector.
const payoutBtns = Array.prototype.slice.call(document.querySelectorAll('.payout-opt'));
let selectedPayout = null;

function selectPayout(payout) {
  selectedPayout = payout;
  payoutBtns.forEach((b) => b.classList.toggle('selected', b.dataset.payout === payout));
  $('#redeemForm').classList.add('open');
  $('#redeemMsg').textContent = '';
  // Show the UPI ID field only for UPI payouts.
  const upiInput = $('#upiInput');
  if (upiInput) upiInput.hidden = payout !== 'upi';
  // Show the withdrawal fee note only once the user has reached the minimum
  // withdrawal balance (hidden otherwise).
  const fee = me?.withdrawFee || 0;
  const minW = me?.minWithdraw || 0;
  const feeNote = $('#feeNote');
  if (feeNote) {
    if (fee > 0 && (me?.balance || 0) >= minW) {
      feeNote.hidden = false;
      feeNote.textContent = `Withdrawal fee: ₹${fee} (added on top).`;
    } else {
      feeNote.hidden = true;
    }
  }

}

payoutBtns.forEach((b) => b.addEventListener('click', () => selectPayout(b.dataset.payout)));

$('#redeemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#redeemMsg');
  if (!selectedPayout) { msg.textContent = 'Select a payout method first'; return; }
  const amount = Number($('#amountInput').value);
  const upi = $('#upiInput')?.value.trim() || '';
  const name = $('#nameInput').value.trim();
  const phone = $('#phoneInput').value.trim();
  const email = $('#emailInput').value.trim();
  const country = $('#countryInput').value.trim();
  const min = me?.minWithdraw || 25;
  const fee = me?.withdrawFee || 0;
  if (!amount || amount < min) { msg.textContent = 'Minimum redemption is ₹' + min; return; }
  if (selectedPayout === 'upi' && !upi) { msg.textContent = 'Enter your UPI ID'; return; }
  if (amount + fee > me.balance) { msg.textContent = 'Not enough balance (need ₹' + (amount + fee).toFixed(2) + ' incl. fee)'; return; }
  if (!name || !phone || !email || !country) { msg.textContent = 'Fill in all contact details'; return; }
  try {
    const r = await api(API_BASE + '/redeem', {
      method: 'POST',
      body: { payout: selectedPayout, amount, name, phone, email, country, upi },
    });
    me.balance = r.balance;
    const kind = PAYOUT_LABEL[r.payout] || r.payout;
    msg.textContent = kind + ' of ₹' + r.amount.toFixed(2) + ' requested' + (r.fee > 0 ? ' (₹' + r.fee.toFixed(2) + ' fee)' : '') + ' — pending. Once approved it will be paid within 24 hours.';
    $('#redeemForm').reset();
    $('#redeemForm').classList.remove('open');
    payoutBtns.forEach((b) => b.classList.remove('selected'));
    selectedPayout = null;
    toast('Requested — approval within 24 hours');
    refreshAll();
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
  }
});

// ---- Shared refresh ------------------------------------------------------------
// Auto-detect the admin: reveal the in-app Admin tab + header link only for the
// configured admin Telegram id (isAdmin comes from /me on the server).
function updateAdminUI() {
  const isAdmin = !!me?.isAdmin;
  const tab = document.querySelector('.admin-tab');
  if (tab) tab.hidden = !isAdmin;
  const btn = $('#adminBtn');
  if (btn) btn.hidden = !isAdmin;
  if (isAdmin && $('#page-admin')) {
    renderAdmin();
    renderAdminUsers();
  }
}

// ---- In-app Admin panel: withdrawal review ------------------------------------
const ADMIN_PAYOUT = { flipkart: 'Flipkart', amazon: 'Amazon', play: 'Play Store', upi: 'UPI' };

async function renderAdmin() {
  if (!me?.isAdmin) return;
  const statsEl = $('#adminStats');
  const listEl = $('#adminWithdrawals');
  try {
    const st = await api(API_BASE + '/admin/stats');
    if (statsEl) {
      statsEl.innerHTML =
        `<div class="stat-card clay-sm"><span class="stat-label">Users</span><span class="stat-value">${st.users}</span></div>` +
        `<div class="stat-card clay-sm"><span class="stat-label">Total balance</span><span class="stat-value">₹${(+st.totalBalance).toFixed(2)}</span></div>` +
        `<div class="stat-card clay-sm"><span class="stat-label">Pending</span><span class="stat-value">${st.pendingWithdrawals}</span></div>`;
    }
  } catch { if (statsEl) statsEl.innerHTML = '<div class="stat-card clay-sm"><span class="stat-value">—</span></div>'; }

  try {
    const { withdrawals } = await api(API_BASE + '/admin/withdrawals');
    if (!listEl) return;
    const pending = (withdrawals || []).filter((w) => w.status === 'pending');
    const done = (withdrawals || []).filter((w) => w.status !== 'pending');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const time = (ts) => ts ? new Date(Number(ts)).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

    const chip = (w) => {
      const c = w.contact || {};
      const badge = w.status === 'approved' ? '<span class="adm-badge ok">Paid</span>' : w.status === 'rejected' ? '<span class="adm-badge no">Rejected</span>' : '<span class="adm-badge">Pending</span>';
      const fee = (+w.fee || 0);
      const upiLine = c.upi ? `<span>UPI: <b>${esc(c.upi)}</b></span>` : '';
      return `<div class="adm-req" data-id="${esc(w.id)}" data-status="${esc(w.status)}">` +
        `<div class="adm-req-top"><strong>₹${(+w.amount).toFixed(2)}</strong>${fee > 0 ? `<span class="adm-badge">+₹${fee.toFixed(2)} fee</span>` : ''}${badge}</div>` +
        `<div class="adm-req-meta">${ADMIN_PAYOUT[w.payout] || esc(w.payout)} · @${esc(w.username || '—')} · ID ${esc(w.userId)} · ${time(w.ts)}</div>` +
        `<div class="adm-req-contact">` +
        `<span>Name: <b>${esc(c.name || '—')}</b></span>` +
        `<span>Phone: <b>${esc(c.phone || '—')}</b></span>` +
        `<span>Email: <b>${esc(c.email || '—')}</b></span>` +
        `<span>Country: <b>${esc(c.country || '—')}</b></span>` +
        `${upiLine}` +
        `</div>` +
        (w.reviewNote && w.status !== 'pending' ? `<div class="adm-note">Note: ${esc(w.reviewNote)}</div>` : '') +
        `<div class="adm-acts">` +
        `<button class="adm-btn ok" data-act="approve">Mark as Paid</button>` +
        `<button class="adm-btn no" data-act="reject">Reject</button>` +
        `<input class="adm-reason" placeholder="Reject reason (required)" /></div>` +
        `</div>`;
    };

    listEl.innerHTML =
      (pending.length ? `<h3 class="adm-grp">Pending</h3>` + pending.map(chip).join('') : '') +
      (done.length ? `<h3 class="adm-grp">History</h3>` + done.map(chip).join('') : '') ||
      '<div class="txn-empty">No withdrawal requests yet.</div>';

    listEl.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const cardEl = b.closest('.adm-req');
        const id = cardEl.dataset.id;
        const act = b.dataset.act;
        if (act === 'reject') {
          const reason = (cardEl.querySelector('.adm-reason')?.value || '').trim();
          if (!reason) { toast('Enter a reject reason'); return; }
          if (!confirm('Reject and refund the user?')) return;
          await api(API_BASE + '/admin/withdrawals/reject', { method: 'POST', body: { id, reason } });
          toast('Rejected · refunded');
        } else {
          if (!confirm('Mark this withdrawal as paid?')) return;
          await api(API_BASE + '/admin/withdrawals/approve', { method: 'POST', body: { id } });
          toast('Marked as paid');
        }
        renderAdmin();
      });
    });
  } catch (e) {
    if (listEl) listEl.innerHTML = '<div class="txn-empty">Admin auth failed.</div>';
  }
}

// ---- In-app Admin: user list + add/subtract balance --------------------------
async function renderAdminUsers() {
  if (!me?.isAdmin) return;
  const box = $('#adminUsers');
  if (!box) return;
  try {
    const { users } = await api(API_BASE + '/admin/users');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    if (!users.length) { box.innerHTML = '<div class="txn-empty">No users yet.</div>'; return; }
    box.innerHTML = users.map((u) =>
      `<div class="adm-req" data-uid="${esc(u.id)}">` +
      `<div class="adm-req-top"><strong>${esc(u.firstName || u.username || u.id)}</strong><span class="adm-badge">${u.cards} cards</span></div>` +
      `<div class="adm-req-meta">@${esc(u.username || '—')} · ID ${esc(u.id)} · ${esc(u.ip || 'no-ip')}</div>` +
      `<div class="adm-req-meta">Ref ${u.referralCount} · Qual ${u.qualifiedCount} · Scratched ${u.scratched} · Balance ₹${(+u.balance).toFixed(2)}</div>` +
      `<div class="adm-acts">` +
      `<input class="adm-balance" type="number" step="0.01" placeholder="+/- ₹" />` +
      `<button class="adm-btn ok" data-act="balance">Apply</button>` +
      `</div></div>`
    ).join('');
    box.querySelectorAll('[data-act="balance"]').forEach((b) => {
      b.addEventListener('click', async () => {
        const card = b.closest('.adm-req');
        const userId = card.dataset.uid;
        const amount = Number(card.querySelector('.adm-balance')?.value);
        if (!Number.isFinite(amount) || amount === 0) { toast('Enter an amount'); return; }
        try {
          await api(API_BASE + '/admin/users/balance', { method: 'POST', body: { userId, amount } });
          toast('Balance updated');
          renderAdminUsers();
        } catch (e) { toast('Error: ' + e.message); }
      });
    });
  } catch (e) {
    box.innerHTML = '<div class="txn-empty">Admin auth failed.</div>';
  }
}

// Channel join gate: if the user hasn't joined every channel, the whole app is
// locked behind a join screen with direct Join buttons for EVERY channel
// (Telegram channels verified live via getChatMember on each open). If the
// user leaves any channel, the next open re-locks them.
function updateLockUI() {
  const cover = $('#lockCover');
  if (!cover) return;
  // Outside users are welcome: the channel-join screen is disabled. The ONLY
  // gate is the hourly check-in.
  cover.hidden = true;
  const nav = document.querySelector('nav');
  if (nav && hasAccess()) nav.style.display = '';
  if (hasAccess() && !document.querySelector('.page.active')) {
    document.getElementById('page-home')?.classList.add('active');
    document.querySelector('.tab[data-page="home"]')?.classList.add('active');
  }
}


// Lock screen: a simple clear message — no channel list, no scrolling. The
// user completes their verification in the BOT (join all channels there), then
// comes back here and taps Verify. Only the bot link + Verify button are shown.
function renderLockChannels() {
  const box = $('#lockChannels');
  if (!box) return;
  box.innerHTML = '';

  if (!me?.missingChannels?.length && me?.joinedExternals) {
    $('#lockMissing').textContent = 'All channels verified ✓';
    return;
  }

  const missing = me?.missingChannels || [];
  $('#lockMissing').textContent = missing.length
    ? `Join ${missing.length} channel(s) left, then tap Verify:`
    : 'Almost there — tap Verify to unlock.';

  // Show exactly which channels are left (or were left/unfollowed) so the user
  // can tap and join each one right here.
  for (const ch of missing) {
    const a = document.createElement('button');
    a.className = 'ext-link-btn';
    a.innerHTML = '<svg viewBox="0 0 24 24" fill="#229ED9"><path d="M11.94 2A10 10 0 1 0 21.9 12 10 10 0 0 0 11.94 2zm4.83 7.05-1.7 8.02c-.13.57-.46.71-.93.44l-2.57-1.9-1.24 1.2a.65.65 0 0 1-.52.25l.18-2.62 4.77-4.31c.2-.18-.05-.28-.32-.1l-5.9 3.71-2.54-.8c-.55-.17-.56-.55.12-.82l9.94-3.83c.46-.17.86.11.71.76z"/></svg>' +
      `<span>Join ${ch}</span>`;
    a.addEventListener('click', () => {
      const url = 'https://t.me/' + String(ch).replace('@', '');
      if (tg?.openTelegramLink) tg.openTelegramLink(url);
      else window.open(url, '_blank', 'noopener');
    });
    box.appendChild(a);
  }

  // Fallback: open the bot, which walks through the same join + verify flow.
  const b = document.createElement('button');
  b.className = 'ext-link-btn';
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="#229ED9"><path d="M11.94 2A10 10 0 1 0 21.9 12 10 10 0 0 0 11.94 2zm4.83 7.05-1.7 8.02c-.13.57-.46.71-.93.44l-2.57-1.9-1.24 1.2a.65.65 0 0 1-.52.25l.18-2.62 4.77-4.31c.2-.18-.05-.28-.32-.1l-5.9 3.71-2.54-.8c-.55-.17-.56-.55.12-.82l9.94-3.83c.46-.17.86.11.71.76z"/></svg>' +
    '<span>Open Bot to Join</span>';
  b.addEventListener('click', () => {
    const url = 'https://t.me/FAPRewards_OfficialBot?start';
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
  });
  box.appendChild(b);
}

// "I've joined — Verify": marks externals joined (self-confirm) and re-pulls
// /me which does the LIVE Telegram membership check (getChatMember). If the
// user left any Telegram channel, it stays locked.
$('#lockVerify')?.addEventListener('click', async () => {
  const btn = $('#lockVerify');
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    // Preload the rewarded ad while the membership check runs, so it's ready
    // the moment the user taps "Yes" on a card / check-in.
    preloadMonetag();
    // If the ONLY remaining step is the external (YouTube/WhatsApp) channel,
    // self-confirm it; Telegram channels are always live-verified by /me.
    if (!me?.joinedExternals && (me?.missingChannels || []).length === 0) {
      try { await api(API_BASE + '/join-external', { method: 'POST', body: {} }); } catch {}
    }
    me = await api(API_BASE + '/me');
    updateLockUI();
    if (me.joinedAll && me.joinedExternals) {
      toast('All channels verified!');
      updateCheckInUI();
      if (!hasAccess()) return;
      showExtGate();
      await loadTransactions();
      renderHome(); renderRefer(); renderWallet();
    } else {
      toast('Keep going — join the next channel');
    }
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg> I\'ve joined — Verify';
  }
});

let _checkinBusy = false;
$('#checkinBtn')?.addEventListener('click', async () => {
  const btn = $('#checkinBtn');
  // Already checked in (or a check-in is in flight): never repeat it.
  if (_checkinBusy || hasAccess()) { updateCheckInUI(); return; }
  _checkinBusy = true;
  const old = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Ad loading…';
  try {
    // Ad stays on check-in only. Once unlocked, scratching is ad-free.
    if (_adsEnabled) {
      const showAd = await monetagFnReady(2500);
      if (showAd) {
        try { await Promise.resolve(showAd()); } catch { /* ad closed — still check in */ }
      } else {
        try { await playRewardedAd(); } catch { /* ad failed — still unlock */ }
      }
    }
    btn.textContent = 'Checking in…';
    const ci = await api(API_BASE + '/check-in', { method: 'POST', body: {} });

    me.checkedInToday = true;
    me.accessUntil = ci?.accessUntil || Date.now() + 60 * 60 * 1000;
    startAccessTimer();
    const ck = $('#checkin');
    if (ck) ck.hidden = true;
    // Restore the tab bar + show Home.
    document.querySelector('nav').style.display = '';
    document.getElementById('page-home')?.classList.add('active');
    document.querySelector('.tab[data-page="home"]')?.classList.add('active');
    toast('Unlocked for 60 minutes — ad-free!');
    // Data doesn't always repopulate right after check-in — auto refresh the
    // mini app so everything (balance, cards, referrals) loads freshly.
    btn.textContent = 'Refreshing…';
    setTimeout(() => window.location.reload(), 600);
    return;
  } catch (e) {
    toast('Error: ' + e.message);
    _checkinBusy = false;
    btn.disabled = false; btn.innerHTML = old;
  }

});


// ---- First-use gate: join YouTube + WhatsApp before using the app ------------
const extModal = $('#extModal');
let extPending = false;

function showExtGate() {
  if (extPending || me?.joinedExternals) return;
  extPending = true;
  // Only external social channels (YouTube + WhatsApp + Instagram) are shown.
  const required = (me.externalChannels || []).filter((c) => /youtube|whatsapp|instagram/i.test(c.label));
  const box = $('#extLinks');
  box.innerHTML = '';
  for (const c of required) {
    const b = document.createElement('button');
    b.className = 'ext-link-btn';
    let icon;
    let label;
    if (c.label.includes('YouTube')) {
      icon = '<svg viewBox="0 0 24 24" fill="#FF0000"><path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19 31.6 31.6 0 0 0 0 12a31.6 31.6 0 0 0 .5 5.81 3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14A31.6 31.6 0 0 0 24 12a31.6 31.6 0 0 0-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z"/></svg>';
      label = 'Join on YouTube';
    } else if (c.label.includes('Instagram')) {
      icon = '<svg viewBox="0 0 24 24" fill="none" stroke="url(#ig-grad)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="ig-grad" x1="0" y1="0" x2="24" y2="24"><stop offset="0%" stop-color="#F58529"/><stop offset="40%" stop-color="#DD2A7B"/><stop offset="100%" stop-color="#8134AF"/></linearGradient></defs><rect x="2.5" y="2.5" width="19" height="19" rx="5.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="17.6" cy="6.4" r="1.3" fill="#DD2A7B" stroke="none"/></svg>';
      label = 'Join on Instagram';
    } else {
      icon = '<svg viewBox="0 0 24 24" fill="#25D366"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5 0 1.47 1.07 2.9 1.22 3.1.15.2 2.1 3.2 5.1 4.49.71.3 1.27.49 1.7.63.72.23 1.37.2 1.88.12.58-.09 1.76-.72 2-1.42.25-.7.25-1.3.18-1.42-.07-.13-.27-.2-.57-.35zM12.04 21.79h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.9-9.88a9.83 9.83 0 0 1 7 2.9 9.83 9.83 0 0 1 2.89 7c0 5.45-4.44 9.88-9.9 9.88zm8.42-18.3A11.8 11.8 0 0 0 12.03 0C5.47 0 .11 5.36.1 11.92c0 2.1.55 4.16 1.6 5.97L0 24l6.25-1.64a11.9 11.9 0 0 0 5.78 1.47h.01c6.56 0 11.9-5.36 11.91-11.92a11.84 11.84 0 0 0-3.49-8.42z"/></svg>';
      label = 'Join on WhatsApp';
    }
    b.innerHTML = icon + '<span>' + label + '</span>';
    b.addEventListener('click', () => {
      if (tg?.openLink) tg.openLink(c.url, { try_instant_view: false });
      else window.open(c.url, '_blank', 'noopener');
    });
    box.appendChild(b);
  }
  extModal.hidden = false;
}

$('#extDone')?.addEventListener('click', async () => {
  try {
    await api(API_BASE + '/join-external', { method: 'POST', body: {} });
    me.joinedExternals = true;
    extModal.hidden = true;
    extPending = false;
    toast('Welcome! Channels joined.');
  } catch (e) {
    toast('Error: ' + e.message);
  }
});

async function refreshAll() {
  try {
    me = await api(API_BASE + '/me');
  } catch {}
  if (!me) return;
  configureAds();
  // Preload the ad in the background (no display). It only SHOWS when the
  // user explicitly taps "Yes, Scratch" or the daily check-in button.
  preloadMonetag();
  updateAdminUI();
  updateLockUI();
  // Only gate: the hourly check-in (works for outside users too).
  updateCheckInUI();
  startAccessTimer();
  if (!hasAccess()) return;

  await loadTransactions();
  renderHome();
  renderRefer();
  renderWallet();
}

// Fetch the user's transactions once (shared by refresh + lock verify).
async function loadTransactions() {
  try {
    const data = await api(API_BASE + '/transactions');
    txns = data.transactions || [];
  } catch {}
}

// ---- Daily check-in UI: full-screen cover until the user checks in today ---
function updateCheckInUI() {
  const ck = $('#checkin');
  if (!ck) return;
  // Hourly check-in: the cover only shows when the 60-minute window is over.
  const needs = !hasAccess();
  ck.hidden = !needs;
  if (needs) {
    // Hide all pages + tab bar so nothing is reachable before checking in.
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    document.querySelector('nav').style.display = 'none';
  }
}

// Live countdown for the 60-minute free window. When it runs out, the
// check-in cover comes back so the user watches one ad to unlock another hour.
let _accessTimer = null;
function startAccessTimer() {
  if (_accessTimer) clearInterval(_accessTimer);
  const tick = () => {
    const badge = document.querySelector('#accessBadge');
    const left = accessMsLeft();
    if (badge) {
      badge.hidden = left <= 0;
      badge.textContent = 'Ad-free access: ' + fmtLeft(left);
    }
    if (left <= 0) {
      clearInterval(_accessTimer);
      _accessTimer = null;
      if (me) me.checkedInToday = false;
      updateCheckInUI();
    }
  };
  tick();
  _accessTimer = setInterval(tick, 1000);
}

// ---- Claim a ?ref=CODE from the URL on first load ---------------------------
// If the app was opened via a shared mini-app ref link (YOURWEBAPP/?ref=XYZ),
// report that code to the backend once so the referrer gets recorded without
// relying on the t.me bot deep-link. Runs at startup, before /me.
// Supports three sources:
//   1) ?ref=CODE  on the web-app URL (browser-shareable link)
//   2) startapp=CODE from a t.me/<bot>/<app>?startapp= deep link (one-tap)
//   3) startapp=ref_CODE (prefixed variant from the server's deepLink)
async function claimUrlRef() {
  let code = new URLSearchParams(location.search).get('ref');
  if (!code) {
    const sp = tg?.initDataUnsafe?.start_param || '';
    code = sp.replace(/^ref_/, '');
  }
  if (!code || !initData) return;
  try {
    await api(API_BASE + '/refer/claim', { method: 'POST', body: { code } });
  } catch {
    // Already referred / invalid — ignore, /me shows the real state.
  }
}

// ---- Init ----------------------------------------------------------------------
function hideLoading() {
  const el = $('#loading');
  if (el) el.classList.add('hide');
  setTimeout(() => { if (el) el.style.display = 'none'; }, 400);
}

(async function init() {
  // Claim any incoming ref code before loading state (so the referrer link is
  // recorded and credit can be awarded on the fresh-IP check in /me).
  await claimUrlRef();
  try {
    me = await api(API_BASE + '/me');
  } catch (e) {
    // Banned accounts (same-IP / fake / blocked): show ONLY the banned screen.
    // No loading leftover, no balance, no tabs — the data is never rendered.
    if (e.message === 'ip_used') {
      showBanned();
    } else {
      hideLoading();
      toast('Not authorized — open from the Telegram bot');
    }
    return;
  }
  hideLoading();
  await refreshAll();
})();

// Dedicated banned screen — full-screen cover, nothing else is reachable.
function showBanned() {
  const banned = $('#banned');
  const loading = $('#loading');
  // Kill the loading overlay immediately (cover-style, no fade) and hide the
  // whole app shell so no account data can leak behind the ban screen.
  if (loading) { loading.classList.add('hide'); loading.style.display = 'none'; }
  const shell = document.querySelector('main');
  if (shell) shell.style.display = 'none';
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const tb = document.querySelector('nav');
  if (tb) tb.style.display = 'none';
  if (banned) banned.hidden = false;
}