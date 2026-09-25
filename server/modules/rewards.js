/**
 * PlanurStay Rewards — our own loyalty program, funded from booking commission.
 *
 * Economics (keep ≤ ~2% of booking value so member bookings stay profitable):
 *   - Earn 1 point per US$1 spent (tier multipliers 1× / 1.25× / 1.5× / 2×)
 *   - 100 points = US$1 off. Redeem from 1,000 points in steps of 500.
 *   - Points are pending until the stay/trip is over, then released (cancelled bookings never release).
 *   - Welcome bonus: 500 points.
 *   - Redemption creates a single-use LiteAPI voucher (100% off, capped at the value), so the
 *     discount is applied by LiteAPI at prebook — verified on sandbox (voucherTotalAmount).
 *
 *   GET  /api/rewards            → balance, pending, tier, vouchers, history (signed in)
 *   POST /api/rewards/redeem     → { points } → voucher code
 */
const crypto = require("crypto");

const TIERS = [
  { key: "explorer", label: "Explorer", min: 0, mult: 1 },
  { key: "silver", label: "Silver", min: 2000, mult: 1.25 },
  { key: "gold", label: "Gold", min: 8000, mult: 1.5 },
  { key: "platinum", label: "Platinum", min: 25000, mult: 2 },
];
const POINT_VALUE_USD = 0.01;
const MIN_REDEEM = 1000, REDEEM_STEP = 500, WELCOME_BONUS = 500;

function createRewards({ db, apiKey, jwt, JWT_SECRET }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rewards_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,              -- pending | earn | bonus | redeem | reverse
      points INTEGER NOT NULL,         -- negative for redeem/reverse
      booking_ref TEXT,
      booking_type TEXT,
      available_on TEXT,               -- for pending: date the points release
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_rewards_user ON rewards_ledger(user_id);
    CREATE TABLE IF NOT EXISTS rewards_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code TEXT UNIQUE NOT NULL,
      value REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      points_used INTEGER NOT NULL,
      liteapi_id INTEGER,
      status TEXT DEFAULT 'active',
      expires_on TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ─── FX to USD for points on non-USD bookings (cached 12h; free public rates) ───
  let fx = { at: 0, rates: { USD: 1 } };
  async function toUsd(amount, currency) {
    if (!amount) return 0;
    if (!currency || currency === "USD") return amount;
    if (Date.now() - fx.at > 12 * 3600 * 1000) {
      try {
        const r = await fetch("https://open.er-api.com/v6/latest/USD");
        const j = await r.json();
        if (j && j.rates) fx = { at: Date.now(), rates: j.rates };
      } catch { /* keep old rates */ }
    }
    const rate = fx.rates[currency];
    return rate ? amount / rate : null;
  }

  const sum = (userId, where) => db.prepare(`SELECT COALESCE(SUM(points),0) AS s FROM rewards_ledger WHERE user_id = ? AND ${where}`).get(userId).s;
  const tierFor = (lifetime) => [...TIERS].reverse().find(t => lifetime >= t.min) || TIERS[0];

  function ensureMember(userId) {
    const any = db.prepare("SELECT 1 FROM rewards_ledger WHERE user_id = ? LIMIT 1").get(userId);
    if (any) return;
    db.prepare("INSERT INTO rewards_ledger (user_id, type, points, note) VALUES (?, 'bonus', ?, 'Welcome to PlanurStay Rewards')").run(userId, WELCOME_BONUS);
  }

  function summary(userId) {
    ensureMember(userId);
    const points = sum(userId, "type IN ('earn','bonus','redeem','reverse')");
    const pending = sum(userId, "type = 'pending'");
    const lifetime = sum(userId, "type IN ('earn','bonus')");
    const tier = tierFor(lifetime);
    const next = TIERS[TIERS.indexOf(tier) + 1] || null;
    const vouchers = db.prepare("SELECT code, value, currency, status, expires_on, created_at FROM rewards_vouchers WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all(userId);
    const history = db.prepare("SELECT type, points, note, available_on, created_at FROM rewards_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 30").all(userId);
    return {
      points, pending, lifetime,
      valueUsd: +(points * POINT_VALUE_USD).toFixed(2),
      tier: { key: tier.key, label: tier.label, multiplier: tier.mult },
      nextTier: next ? { label: next.label, pointsToGo: Math.max(0, next.min - lifetime), multiplier: next.mult } : null,
      redeem: { min: MIN_REDEEM, step: REDEEM_STEP, pointValueUsd: POINT_VALUE_USD },
      vouchers, history,
    };
  }

  /** Called after a confirmed booking for a signed-in member. Points release after the trip. */
  async function addPending(userId, { bookingRef, bookingType = "hotel", amount, currency, releaseDate, note }) {
    if (!userId || !bookingRef) return null;
    ensureMember(userId);
    if (db.prepare("SELECT 1 FROM rewards_ledger WHERE user_id = ? AND booking_ref = ? AND type IN ('pending','earn')").get(userId, bookingRef)) return null;
    const usd = await toUsd(+amount || 0, currency);
    if (usd == null) { console.warn(`Rewards: no FX rate for ${currency}; points skipped for ${bookingRef}`); return null; }
    const lifetime = sum(userId, "type IN ('earn','bonus')");
    const pts = Math.floor(usd * tierFor(lifetime).mult);
    if (pts <= 0) return null;
    db.prepare("INSERT INTO rewards_ledger (user_id, type, points, booking_ref, booking_type, available_on, note) VALUES (?, 'pending', ?, ?, ?, ?, ?)")
      .run(userId, pts, bookingRef, bookingType, releaseDate || new Date(Date.now() + 86400000).toISOString().slice(0, 10), note || `${bookingType === "flight" ? "Flight" : "Hotel"} booking ${bookingRef}`);
    return pts;
  }

  // ─── Release pending points after the trip (skip cancelled bookings) ───
  async function bookingCancelled(ref, type) {
    try {
      const url = type === "flight" ? `https://api.liteapi.travel/v3.0/flights/bookings/${encodeURIComponent(ref)}` : `https://api.liteapi.travel/v3.0/bookings/${encodeURIComponent(ref)}`;
      const r = await fetch(url, { headers: { "X-API-Key": apiKey, Accept: "application/json" } });
      if (!r.ok) return false; // unknown → don't block the member
      const j = await r.json();
      const status = String(j.data?.status || j.data?.booking?.status || j.status || "").toUpperCase();
      return /CANCEL/.test(status);
    } catch { return false; }
  }
  async function releaseDue() {
    const today = new Date().toISOString().slice(0, 10);
    const due = db.prepare("SELECT * FROM rewards_ledger WHERE type = 'pending' AND available_on <= ? LIMIT 100").all(today);
    for (const p of due) {
      const cancelled = await bookingCancelled(p.booking_ref, p.booking_type);
      if (cancelled) db.prepare("UPDATE rewards_ledger SET type = 'reverse', points = 0, note = ? WHERE id = ?").run(`Booking ${p.booking_ref} was cancelled`, p.id);
      else db.prepare("UPDATE rewards_ledger SET type = 'earn', note = COALESCE(note,'') || ' · points released' WHERE id = ?").run(p.id);
    }
  }
  setTimeout(releaseDue, 90 * 1000);
  setInterval(releaseDue, 6 * 3600 * 1000);

  // ─── Redeem points → single-use LiteAPI voucher ───
  async function createLiteVoucher(code, valueUsd) {
    const start = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const res = await fetch("https://da.liteapi.travel/vouchers", {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        voucher_code: code, discount_type: "percentage", discount_value: 100,
        maximum_discount_amount: valueUsd, minimum_spend: Math.max(valueUsd * 3, 50),
        currency: "USD", validity_start: start, validity_end: end, usages_limit: 1, status: "active",
        description: `PlanurStay Rewards: $${valueUsd} off`,
        terms_and_conditions: "Single use. Valid for 12 months on bookings of at least 3x the voucher value.",
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.voucher) throw new Error(j.error?.message || j.message || "Voucher could not be created");
    return { id: j.voucher.id, end };
  }

  function register(app) {
    const user = (req) => { try { return jwt.verify(req.cookies?.token || "", JWT_SECRET); } catch { return null; } };

    // Public program rules for the Rewards page (single source of truth)
    app.get("/api/rewards/program", (req, res) => {
      const pricing = require("./pricing");
      res.json({
        tiers: TIERS.map(t => ({ key: t.key, label: t.label, min: t.min, multiplier: t.mult })),
        pointsPerDollar: 1, pointValueUsd: POINT_VALUE_USD, pointsPerDollarOff: Math.round(1 / POINT_VALUE_USD),
        minRedeem: MIN_REDEEM, redeemStep: REDEEM_STEP, welcomeBonus: WELCOME_BONUS,
        memberSavePct: pricing.memberSavePct(),
      });
    });

    app.get("/api/rewards", (req, res) => {
      const u = user(req);
      if (!u) return res.status(401).json({ error: "Sign in to see your rewards" });
      res.json({ success: true, data: summary(u.id) });
    });

    app.post("/api/rewards/redeem", async (req, res) => {
      const u = user(req);
      if (!u) return res.status(401).json({ error: "Sign in to redeem points" });
      const want = Math.floor((+req.body?.points || 0) / REDEEM_STEP) * REDEEM_STEP;
      const s = summary(u.id);
      if (want < MIN_REDEEM) return res.status(400).json({ error: `Redeem at least ${MIN_REDEEM.toLocaleString()} points` });
      if (want > s.points) return res.status(400).json({ error: `You have ${s.points.toLocaleString()} points available` });
      const value = +(want * POINT_VALUE_USD).toFixed(2);
      const code = "PS" + crypto.randomBytes(4).toString("hex").toUpperCase();
      try {
        const v = await createLiteVoucher(code, value);
        const tx = db.transaction(() => {
          db.prepare("INSERT INTO rewards_ledger (user_id, type, points, note) VALUES (?, 'redeem', ?, ?)").run(u.id, -want, `Redeemed for $${value} voucher ${code}`);
          db.prepare("INSERT INTO rewards_vouchers (user_id, code, value, points_used, liteapi_id, expires_on) VALUES (?, ?, ?, ?, ?, ?)").run(u.id, code, value, want, v.id, v.end);
        });
        tx();
        res.json({ success: true, data: { code, value, currency: "USD", expiresOn: v.end, points: summary(u.id).points } });
      } catch (err) {
        console.error("Rewards redeem:", err.message);
        res.status(502).json({ error: "We couldn't create your voucher right now. Your points were not used." });
      }
    });
  }

  return { register, addPending, summary, markVoucherUsed: (code) => db.prepare("UPDATE rewards_vouchers SET status = 'used' WHERE code = ?").run(code) };
}

module.exports = { createRewards, TIERS };
