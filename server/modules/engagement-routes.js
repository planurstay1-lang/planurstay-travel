/**
 * Engagement features: hotel price alerts + newsletter.
 *
 *   POST /api/alerts                    → track hotel prices for a search (email when they drop ≥5%)
 *   GET  /api/alerts/unsubscribe?token  → stop an alert
 *   POST /api/newsletter                → subscribe (stored locally; also added to a Resend audience if RESEND_AUDIENCE_ID is set)
 *   GET  /api/newsletter/unsubscribe?token
 *
 * Alerts are re-checked by a background timer (every 3h, each alert at most once a day).
 * Data lives in the same SQLite DB as bookings, so it needs the persistent disk (DB_PATH) on Render.
 */
const crypto = require("crypto");

function registerEngagementRoutes(app, { db, apiKey, jwt, JWT_SECRET, APP_URL }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      user_id INTEGER,
      place_id TEXT NOT NULL,
      dest TEXT, dest_detail TEXT,
      checkin TEXT NOT NULL, checkout TEXT NOT NULL,
      adults INTEGER DEFAULT 2, rooms INTEGER DEFAULT 1,
      currency TEXT DEFAULT 'USD',
      margin INTEGER DEFAULT 10,
      baseline REAL, last_price REAL,
      token TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked DATETIME, last_notified DATETIME
    );
    CREATE TABLE IF NOT EXISTS newsletter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      token TEXT UNIQUE NOT NULL,
      source TEXT,
      active INTEGER DEFAULT 1,
      consent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const EMAIL_FROM = process.env.EMAIL_FROM || "PlanurStay <onboarding@resend.dev>";
  let resend = null;
  if (RESEND_API_KEY) { const { Resend } = require("resend"); resend = new Resend(RESEND_API_KEY); }
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e || "");
  const money = (n, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n); } catch { return `${cur} ${Math.round(n)}`; } };

  async function send(to, subject, bodyHtml) {
    if (!resend) { console.log(`[email skipped: no RESEND_API_KEY] ${subject} → ${to}`); return; }
    const { error } = await resend.emails.send({
      from: EMAIL_FROM, to, subject,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;background:#f6f8fc;padding:24px"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;border:1px solid #e4e8f1">
        <div style="font-size:20px;font-weight:800;color:#0b1b3f">PlanurStay</div>${bodyHtml}</div></div>`,
    });
    if (error) throw new Error(error.message || "Email failed");
  }

  // Tiny per-IP rate limit so the forms can't be used to spam inboxes.
  const hits = new Map();
  function limited(req, max = 6, windowMs = 10 * 60 * 1000) {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
    list.push(now); hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    return list.length > max;
  }
  const userFrom = (req) => { try { return jwt.verify(req.cookies?.token || "", JWT_SECRET); } catch { return null; } };

  // ─── Live cheapest nightly price for an alert's search ───
  async function cheapestPerNight(a) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch("https://api.liteapi.travel/v3.0/hotels/rates", {
        method: "POST", signal: controller.signal,
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          placeId: a.place_id, checkin: a.checkin, checkout: a.checkout,
          occupancies: Array.from({ length: a.rooms || 1 }, (_, i) => ({ adults: i === 0 ? Math.max(1, (a.adults || 2) - ((a.rooms || 1) - 1)) : 1 })),
          currency: a.currency || "USD", guestNationality: "US", margin: a.margin ?? 10, maxRatesPerHotel: 1, limit: 100, timeout: 12,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      const nights = Math.max(1, Math.round((new Date(a.checkout) - new Date(a.checkin)) / 86400000));
      let min = Infinity;
      for (const h of json.data || []) for (const rt of h.roomTypes || []) {
        const t = rt.offerRetailRate?.amount; if (t != null && t / nights < min) min = t / nights;
      }
      return Number.isFinite(min) ? min : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }

  const resultsUrl = (a) => `${APP_URL}/hotels?` + new URLSearchParams({ placeId: a.place_id, dest: a.dest || "", destDetail: a.dest_detail || "", checkin: a.checkin, checkout: a.checkout, adults: a.adults, rooms: a.rooms }).toString();

  // ─── Create an alert ───
  app.post("/api/alerts", async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: "Too many requests. Please try again in a few minutes." });
    const b = req.body || {};
    const email = String(b.email || "").trim().toLowerCase();
    if (!emailOk(email)) return res.status(400).json({ error: "Enter a valid email address" });
    if (!b.placeId || !/^\d{4}-\d{2}-\d{2}$/.test(b.checkin || "") || !/^\d{4}-\d{2}-\d{2}$/.test(b.checkout || "")) return res.status(400).json({ error: "Search details are missing" });
    if (new Date(b.checkin) < new Date(new Date().toISOString().slice(0, 10))) return res.status(400).json({ error: "These dates have already passed" });
    const currency = /^[A-Z]{3}$/.test(b.currency || "") ? b.currency : "USD";
    const user = userFrom(req);
    const existing = db.prepare("SELECT id FROM price_alerts WHERE email = ? AND place_id = ? AND checkin = ? AND checkout = ? AND currency = ? AND active = 1").get(email, b.placeId, b.checkin, b.checkout, currency);
    if (existing) return res.json({ success: true, already: true });
    const token = crypto.randomBytes(18).toString("hex");
    const price = Number.isFinite(+b.price) && +b.price > 0 ? +b.price : null;
    db.prepare(`INSERT INTO price_alerts (email, user_id, place_id, dest, dest_detail, checkin, checkout, adults, rooms, currency, margin, baseline, last_price, token, last_checked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(
      email, user ? user.id : null, b.placeId, String(b.dest || "").slice(0, 120), String(b.destDetail || "").slice(0, 160),
      b.checkin, b.checkout, Math.min(16, Math.max(1, +b.adults || 2)), Math.min(8, Math.max(1, +b.rooms || 1)), currency, user ? 0 : 10, price, price, token);
    const a = { place_id: b.placeId, dest: b.dest, dest_detail: b.destDetail, checkin: b.checkin, checkout: b.checkout, adults: +b.adults || 2, rooms: +b.rooms || 1 };
    send(email, `We're watching ${b.dest || "your"} hotel prices`, `
      <h1 style="font-size:22px;color:#0b1b3f;margin:18px 0 6px">Price alert is on</h1>
      <p style="color:#4a5572">We'll check hotel prices in <b>${esc(b.dest || "your destination")}</b> for <b>${esc(b.checkin)} to ${esc(b.checkout)}</b> every day and email you if they drop${price ? ` below <b>${money(price, currency)}</b>/night` : ""}.</p>
      <p style="margin:22px 0"><a href="${resultsUrl(a)}" style="background:#1f5bff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">See current prices</a></p>
      <p style="color:#7a849c;font-size:13px">Don't want these? <a href="${APP_URL}/api/alerts/unsubscribe?token=${token}" style="color:#7a849c">Stop this alert</a>.</p>`)
      .catch(e => console.error("Alert email:", e.message));
    res.json({ success: true });
  });

  app.get("/api/alerts/unsubscribe", (req, res) => {
    const r = db.prepare("UPDATE price_alerts SET active = 0 WHERE token = ?").run(String(req.query.token || ""));
    res.type("html").send(simplePage(r.changes ? "Price alert stopped" : "Alert not found", r.changes ? "You won't get any more emails for this search." : "This link may have already been used."));
  });

  // ─── Newsletter ───
  app.post("/api/newsletter", async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: "Too many requests. Please try again in a few minutes." });
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!emailOk(email)) return res.status(400).json({ error: "Enter a valid email address" });
    const row = db.prepare("SELECT token, active FROM newsletter WHERE email = ?").get(email);
    if (row && row.active) return res.json({ success: true, already: true });
    const token = row?.token || crypto.randomBytes(18).toString("hex");
    if (row) db.prepare("UPDATE newsletter SET active = 1, consent_at = CURRENT_TIMESTAMP WHERE email = ?").run(email);
    else db.prepare("INSERT INTO newsletter (email, token, source) VALUES (?, ?, ?)").run(email, token, String(req.body?.source || "footer").slice(0, 40));
    if (resend && process.env.RESEND_AUDIENCE_ID) {
      resend.contacts.create({ email, audienceId: process.env.RESEND_AUDIENCE_ID, unsubscribed: false }).catch(e => console.error("Audience add:", e.message));
    }
    send(email, "Welcome to PlanurStay deals", `
      <h1 style="font-size:22px;color:#0b1b3f;margin:18px 0 6px">You're in!</h1>
      <p style="color:#4a5572">We'll send the best hotel and flight deals, member offers and travel ideas. No spam, and you can leave anytime.</p>
      <p style="margin:22px 0"><a href="${APP_URL}" style="background:#1f5bff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">Start exploring</a></p>
      <p style="color:#7a849c;font-size:13px"><a href="${APP_URL}/api/newsletter/unsubscribe?token=${token}" style="color:#7a849c">Unsubscribe</a></p>`)
      .catch(e => console.error("Welcome email:", e.message));
    res.json({ success: true });
  });

  app.get("/api/newsletter/unsubscribe", (req, res) => {
    const token = String(req.query.token || "");
    const row = db.prepare("SELECT email FROM newsletter WHERE token = ?").get(token);
    if (row) {
      db.prepare("UPDATE newsletter SET active = 0 WHERE token = ?").run(token);
      if (resend && process.env.RESEND_AUDIENCE_ID) resend.contacts.update({ email: row.email, audienceId: process.env.RESEND_AUDIENCE_ID, unsubscribed: true }).catch(() => {});
    }
    res.type("html").send(simplePage(row ? "You're unsubscribed" : "Link not found", row ? "You won't receive PlanurStay newsletters anymore." : "This link may have already been used."));
  });

  function simplePage(title, msg) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — PlanurStay</title>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/css/ps.css"></head>
      <body><main class="container" style="text-align:center;padding:90px 24px"><h1 style="font-size:30px;font-weight:800">${esc(title)}</h1><p style="color:var(--text-2);margin:10px 0 24px">${esc(msg)}</p><a class="btn btn-primary" href="/">Back to PlanurStay</a></main></body></html>`;
  }

  // ─── Background checker ───
  let running = false;
  async function checkAlerts() {
    if (running || !apiKey) return;
    running = true;
    try {
      const today = new Date().toISOString().slice(0, 10);
      db.prepare("UPDATE price_alerts SET active = 0 WHERE active = 1 AND checkin < ?").run(today);
      const due = db.prepare(`SELECT * FROM price_alerts WHERE active = 1 AND (last_checked IS NULL OR last_checked < datetime('now', '-20 hours')) ORDER BY last_checked LIMIT 40`).all();
      for (const a of due) {
        const price = await cheapestPerNight(a);
        db.prepare("UPDATE price_alerts SET last_checked = CURRENT_TIMESTAMP, last_price = COALESCE(?, last_price) WHERE id = ?").run(price, a.id);
        if (price == null) continue;
        if (a.baseline == null) { db.prepare("UPDATE price_alerts SET baseline = ? WHERE id = ?").run(price, a.id); continue; }
        if (price <= a.baseline * 0.95) {
          const pct = Math.round((1 - price / a.baseline) * 100);
          try {
            await send(a.email, `Prices dropped ${pct}% in ${a.dest || "your destination"}`, `
              <h1 style="font-size:22px;color:#0b1b3f;margin:18px 0 6px">Good news: prices dropped ${pct}%</h1>
              <p style="color:#4a5572">Hotels in <b>${esc(a.dest || "your destination")}</b> for <b>${esc(a.checkin)} to ${esc(a.checkout)}</b> now start from <b>${money(price, a.currency)}</b>/night (was ${money(a.baseline, a.currency)}).</p>
              <p style="margin:22px 0"><a href="${resultsUrl(a)}" style="background:#ff5a3c;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">See the deals</a></p>
              <p style="color:#7a849c;font-size:13px">Prices change often, so book soon to lock it in. <a href="${APP_URL}/api/alerts/unsubscribe?token=${a.token}" style="color:#7a849c">Stop this alert</a>.</p>`);
            db.prepare("UPDATE price_alerts SET baseline = ?, last_notified = CURRENT_TIMESTAMP WHERE id = ?").run(price, a.id);
          } catch (e) { console.error("Price drop email:", e.message); }
        }
        await new Promise(r => setTimeout(r, 1500)); // gentle on LiteAPI
      }
    } catch (e) { console.error("Alert checker:", e.message); } finally { running = false; }
  }
  setTimeout(checkAlerts, 60 * 1000);
  setInterval(checkAlerts, 3 * 60 * 60 * 1000);
}

module.exports = { registerEngagementRoutes };
