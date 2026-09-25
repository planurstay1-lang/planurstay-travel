/**
 * Growth emails and partner links.
 *
 *   - Welcome email on sign-up (member prices, points, how to use them).
 *   - Unfinished checkout: a signed-in member who reached payment but didn't book gets one
 *     "Your <hotel/flight> is still available" email 2–24 hours later.
 *   - Welcome back: 1–4 days after a trip ends, a thank-you email with a comeback offer:
 *     book again within 30 days and earn COMEBACK_BONUS extra points (released with the trip).
 *   - Partner links (travel insurance, airport transfers, car hire) come from env templates with
 *     {city} {country} {checkin} {checkout} {airport} placeholders; unset partners are hidden.
 *
 *   POST /api/growth/checkout-start  { type, prebookId, name, checkin, checkout, total, currency, back }
 *   GET  /api/partners               → { insurance?, transfers?, carHire? } (templates only)
 *   GET  /api/site-config            → { ga4, metaPixel, whatsapp, phone, reviewsUrl, reviewsLabel }
 *
 * Every marketing email honours users.reminders_off (the same one-click opt-out as reminders).
 */
const COMEBACK_BONUS = () => +process.env.COMEBACK_BONUS_POINTS || 500;

function createGrowth({ db, jwt, JWT_SECRET, sendEmail, appUrl }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkout_starts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT, prebook_id TEXT UNIQUE, name TEXT, checkin TEXT, checkout TEXT,
      total REAL, currency TEXT, back TEXT,
      emailed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS growth_sent (
      kind TEXT NOT NULL, ref TEXT NOT NULL, user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (kind, ref)
    );
    CREATE TABLE IF NOT EXISTS comeback_offers (
      user_id INTEGER PRIMARY KEY, points INTEGER, expires_on TEXT, used_ref TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try { db.exec("ALTER TABLE users ADD COLUMN reminders_off INTEGER DEFAULT 0"); } catch { /* exists */ }

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const base = () => (process.env.PUBLIC_URL || appUrl() || "").replace(/\/$/, "");
  const money = (n, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n); } catch { return `${cur} ${Math.round(n)}`; } };
  const fmtDate = (s) => (s ? new Date(String(s).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "");
  const userOf = (req) => { try { return jwt.verify(req.cookies?.token || "", JWT_SECRET); } catch { return null; } };
  const unsubLink = (userId) => `${base()}/api/reminders/unsubscribe?t=` + jwt.sign({ p: "unsub", u: userId }, JWT_SECRET, { expiresIn: "365d" });
  const optedOut = (userId) => !!db.prepare("SELECT reminders_off FROM users WHERE id = ?").get(userId)?.reminders_off;
  const shell = (inner, userId) => `<div style="font-family:Arial,Helvetica,sans-serif;background:#f6f8fc;padding:24px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:26px;border:1px solid #e4e8f1">
      <div style="font-weight:800;font-size:18px;color:#1f5bff">PlanurStay</div>${inner}
      ${userId ? `<p style="color:#7a849c;font-size:12px;margin-top:22px">You're getting this because you have a PlanurStay account. <a href="${esc(unsubLink(userId))}" style="color:#7a849c">Turn off these emails</a>.</p>` : ""}
    </div></div>`;
  const button = (href, label) => `<p style="margin:20px 0 6px"><a href="${esc(href)}" style="background:#1f5bff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">${esc(label)}</a></p>`;
  // Only same-site paths are allowed as "back" links in emails
  const safePath = (p) => (typeof p === "string" && /^\/(hotel|hotels|flights|checkout)\b[^\s<>"']*$/.test(p) ? p : "/");

  // ─── Welcome email ───
  function welcome(email, savePct) {
    if (!email) return;
    sendEmail({
      to: email, subject: "Welcome to PlanurStay: your member prices are on",
      html: shell(`<h1 style="font-size:22px;color:#0b1b3f;margin:16px 0 8px">Welcome aboard</h1>
        <p style="color:#4a5572">Your free membership is active. Here's what you get:</p>
        <ul style="color:#0b1b3f;padding-left:18px;line-height:1.7">
          <li><b>Member prices on hotels</b>, about ${savePct}% below what guests pay. Just stay signed in.</li>
          <li><b>500 welcome points</b> are already in your account. Earn 1 point per $1 on every trip.</li>
          <li><b>Package prices</b>: book a flight and hotels at your destination unlock lower package prices.</li>
          <li><b>Price alerts</b> for the trips you're watching.</li>
        </ul>${button(base() + "/", "Find your next trip")}`),
    }).catch(() => {});
  }

  // ─── Track checkouts that reached payment (signed-in members only) ───
  function checkoutStart(req, b) {
    const u = userOf(req);
    if (!u || !b || !b.prebookId) return false;
    db.prepare(`INSERT OR IGNORE INTO checkout_starts (user_id, type, prebook_id, name, checkin, checkout, total, currency, back) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.id, b.type === "flight" ? "flight" : "hotel", String(b.prebookId).slice(0, 120), String(b.name || "").slice(0, 160), String(b.checkin || "").slice(0, 10), String(b.checkout || "").slice(0, 10), +b.total || null, String(b.currency || "").slice(0, 3), safePath(b.back));
    return true;
  }

  async function unfinishedCheckouts() {
    const due = db.prepare(`
      SELECT c.*, u.email FROM checkout_starts c JOIN users u ON u.id = c.user_id
      WHERE c.emailed_at IS NULL AND COALESCE(u.reminders_off, 0) = 0
        AND c.created_at <= datetime('now', '-2 hours') AND c.created_at >= datetime('now', '-24 hours')
        AND (c.checkin = '' OR c.checkin >= date('now', '+2 days'))
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = c.user_id AND b.created_at >= c.created_at)
        AND NOT EXISTS (SELECT 1 FROM flight_bookings f WHERE f.user_id = c.user_id AND f.created_at >= c.created_at)
      ORDER BY c.created_at DESC LIMIT 30`).all();
    const seen = new Set();
    for (const c of due) {
      db.prepare("UPDATE checkout_starts SET emailed_at = CURRENT_TIMESTAMP WHERE id = ?").run(c.id);
      if (seen.has(c.user_id)) continue; // one per member
      seen.add(c.user_id);
      const what = c.type === "flight" ? "flight" : "stay";
      await sendEmail({
        to: c.email, subject: c.type === "flight" ? `Your flight is still available` : `${c.name || "Your hotel"} is still available`,
        html: shell(`<h1 style="font-size:22px;color:#0b1b3f;margin:16px 0 8px">Still planning your ${what}?</h1>
          <p style="color:#4a5572">You got as far as payment for <b style="color:#0b1b3f">${esc(c.name || "your trip")}</b>${c.checkin ? ` (${fmtDate(c.checkin)}${c.checkout ? ` – ${fmtDate(c.checkout)}` : ""})` : ""}${c.total ? `, ${money(c.total, c.currency)}` : ""}.
          Prices and availability change often, so it's worth checking again.</p>${button(base() + c.back, c.type === "flight" ? "See the latest fares" : "See rooms and prices")}`, c.user_id),
      }).catch(() => {});
    }
    db.prepare("DELETE FROM checkout_starts WHERE created_at < datetime('now', '-30 days')").run();
  }

  // ─── Welcome back after a trip, with a comeback offer ───
  async function afterTrips() {
    const hotels = db.prepare(`
      SELECT b.liteapi_booking_id AS ref, b.user_id, b.hotel_name AS name, b.checkout AS ended, u.email FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.user_id IS NOT NULL AND b.liteapi_booking_id IS NOT NULL AND COALESCE(u.reminders_off, 0) = 0
        AND upper(COALESCE(b.status, '')) NOT LIKE '%CANCEL%'
        AND b.checkout BETWEEN date('now', '-4 days') AND date('now', '-1 day')
        AND NOT EXISTS (SELECT 1 FROM growth_sent g WHERE g.kind = 'welcome_back' AND g.ref = b.liteapi_booking_id)
      GROUP BY b.liteapi_booking_id LIMIT 30`).all();
    let flights = [];
    try {
      flights = db.prepare(`
        SELECT f.booking_id AS ref, f.user_id, f.segments_json, u.email FROM flight_bookings f JOIN users u ON u.id = f.user_id
        WHERE f.user_id IS NOT NULL AND f.booking_id IS NOT NULL AND COALESCE(u.reminders_off, 0) = 0
          AND upper(COALESCE(f.status, '')) NOT LIKE '%CANCEL%'
          AND f.created_at >= datetime('now', '-400 days')
          AND NOT EXISTS (SELECT 1 FROM growth_sent g WHERE g.kind = 'welcome_back' AND g.ref = f.booking_id)
        LIMIT 200`).all().map(f => {
          let segs = []; try { segs = JSON.parse(f.segments_json || "[]"); } catch {}
          const last = segs[segs.length - 1] || {};
          return { ref: f.ref, user_id: f.user_id, email: f.email, name: last.destinationCode ? `your trip to ${last.destinationCode}` : "your trip", ended: String(last.arrivalTime || "").slice(0, 10) };
        }).filter(f => { const d = Date.parse(f.ended + "T00:00:00Z"), now = Date.now(); return d && now - d >= 86400000 && now - d <= 4 * 86400000; });
    } catch { /* no flight table */ }
    const seen = new Set();
    for (const t of [...hotels, ...flights]) {
      db.prepare("INSERT OR IGNORE INTO growth_sent (kind, ref, user_id) VALUES ('welcome_back', ?, ?)").run(t.ref, t.user_id);
      if (seen.has(t.user_id)) continue;
      seen.add(t.user_id);
      const pts = COMEBACK_BONUS();
      const until = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      db.prepare("INSERT OR REPLACE INTO comeback_offers (user_id, points, expires_on, used_ref) VALUES (?, ?, ?, NULL)").run(t.user_id, pts, until);
      await sendEmail({
        to: t.email, subject: `Welcome back! ${pts} bonus points for your next trip`,
        html: shell(`<h1 style="font-size:22px;color:#0b1b3f;margin:16px 0 8px">Welcome back</h1>
          <p style="color:#4a5572">We hope you enjoyed ${esc(t.name ? (t.name.startsWith("your ") ? t.name : `your stay at ${t.name}`) : "your trip")}. Your points for it are being added to your account.</p>
          <p style="margin:12px 0;padding:12px 14px;border-radius:10px;background:#effaf4;color:#0a7d46;font-weight:700">Book your next trip by ${fmtDate(until)} and earn ${pts} bonus points on top of your usual points.</p>
          ${button(base() + "/", "Plan your next trip")}
          <p style="color:#4a5572;font-size:13px">How was it? Just reply to this email: we read every message.</p>`, t.user_id),
      }).catch(() => {});
    }
  }

  /** After a confirmed booking: redeem an active comeback offer as bonus points (released with the trip). */
  function bookingMade(userId, ref, releaseDate, type = "hotel") {
    if (!userId || !ref) return;
    try {
      const o = db.prepare("SELECT * FROM comeback_offers WHERE user_id = ? AND used_ref IS NULL AND expires_on >= date('now')").get(userId);
      if (!o) return;
      db.prepare("UPDATE comeback_offers SET used_ref = ? WHERE user_id = ?").run(String(ref), userId);
      db.prepare("INSERT INTO rewards_ledger (user_id, type, points, booking_ref, booking_type, available_on, note) VALUES (?, 'pending', ?, ?, ?, ?, 'Welcome-back bonus')")
        .run(userId, o.points, String(ref), type === "flight" ? "flight" : "hotel", releaseDate || new Date(Date.now() + 86400000).toISOString().slice(0, 10));
    } catch (e) { console.warn("Comeback bonus:", e.message); }
  }

  let running = false;
  async function run() {
    if (running || !process.env.RESEND_API_KEY) return;
    running = true;
    try { await unfinishedCheckouts(); await afterTrips(); } catch (e) { console.warn("Growth emails:", e.message); } finally { running = false; }
  }
  setTimeout(run, 3 * 60 * 1000).unref();
  setInterval(run, 30 * 60 * 1000).unref();

  // ─── Partner links (affiliate templates from env) ───
  const PARTNERS = [
    ["insurance", "INSURANCE_URL", "Travel insurance", "Cover for cancellations, medical costs and lost bags."],
    ["transfers", "TRANSFERS_URL", "Airport transfer", "A driver waiting when you land, fixed price."],
    ["carHire", "CAR_HIRE_URL", "Car hire", "Compare rental cars at your destination."],
  ];

  function register(app) {
    app.post("/api/growth/checkout-start", (req, res) => { res.json({ success: true, tracked: checkoutStart(req, req.body || {}) }); });
    // Public site settings from env: analytics IDs, WhatsApp, phone, reviews badge. Unset = feature hidden.
    app.get("/api/site-config", (req, res) => {
      const env = (k) => String(process.env[k] || "").trim();
      const wa = env("WHATSAPP_NUMBER").replace(/\D/g, "");
      res.set("Cache-Control", "public, max-age=300").json({
        ga4: /^G-[A-Z0-9]{4,}$/.test(env("GA4_ID")) ? env("GA4_ID") : null,
        metaPixel: /^\d{6,20}$/.test(env("META_PIXEL_ID")) ? env("META_PIXEL_ID") : null,
        whatsapp: wa.length >= 8 && wa.length <= 15 ? wa : null,
        phone: env("SUPPORT_PHONE").slice(0, 30) || null,
        reviewsUrl: /^https:\/\//.test(env("REVIEWS_URL")) ? env("REVIEWS_URL") : null,
        reviewsLabel: env("REVIEWS_LABEL").slice(0, 60) || null,
      });
    });
    app.get("/api/partners", (req, res) => {
      const out = {};
      for (const [k, env, title, text] of PARTNERS) { const url = (process.env[env] || "").trim(); if (/^https:\/\//.test(url)) out[k] = { url, title, text }; }
      res.json({ success: true, data: out });
    });
  }

  return { register, welcome, bookingMade, run };
}

module.exports = { createGrowth };
