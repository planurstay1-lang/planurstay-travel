/**
 * Flight fare alerts: "Email me when Toronto → Delhi gets cheaper".
 *
 *   POST /api/flight-alerts              { email, from, to, fromCity, toCity, fromCountry, depart, return?, adults, currency, price? }
 *   GET  /api/flight-alerts/unsubscribe?token=…
 *
 * Once a day per alert we re-run the same search and email when the cheapest fare is at least 5% below
 * the lowest price we've already told them about. Alerts stop after the departure date.
 * Searches run one at a time with a pause between them (LiteAPI flight search is slow and rate-limited).
 */
const crypto = require("crypto");

function createFlightAlerts({ db, sendEmail, appUrl }) {
  db.exec(`CREATE TABLE IF NOT EXISTS flight_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL, user_id INTEGER,
    origin TEXT NOT NULL, destination TEXT NOT NULL, from_city TEXT, to_city TEXT, country TEXT,
    depart TEXT NOT NULL, ret TEXT, adults INTEGER DEFAULT 1, currency TEXT DEFAULT 'USD',
    baseline REAL, last_price REAL, token TEXT UNIQUE NOT NULL, active INTEGER DEFAULT 1,
    last_checked DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const flightEngine = require("../flight-engine");
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n); } catch { return `${cur} ${Math.round(n)}`; } };
  const base = () => (process.env.PUBLIC_URL || appUrl() || "").replace(/\/$/, "");
  const IATA = /^[A-Z]{3}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
  const hits = new Map();
  const limited = (req) => {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(), now = Date.now();
    const list = (hits.get(ip) || []).filter(t => now - t < 600000); list.push(now); hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    return list.length > 6;
  };
  const resultsUrl = (a) => `${base()}/flights?` + new URLSearchParams({ from: a.origin, to: a.destination, fromCity: a.from_city || a.origin, toCity: a.to_city || a.destination, fromCountry: a.country || "", depart: a.depart, return: a.ret || "", adults: a.adults || 1 });
  const route = (a) => `${a.from_city || a.origin} → ${a.to_city || a.destination}`;

  async function cheapest(a) {
    const legs = [{ origin: a.origin, destination: a.destination, date: a.depart }];
    if (a.ret) legs.push({ origin: a.destination, destination: a.origin, date: a.ret });
    const r = await flightEngine.searchFlights({ legs, adults: a.adults || 1, currency: a.currency || "USD", country: a.country || "US" });
    if (!r.success) return null;
    let min = Infinity;
    for (const j of r.data?.data?.[0]?.journeys || []) for (const o of [j.cheapestOffer, ...(j.offers || [])]) { const t = +o?.pricing?.display?.total; if (t > 0 && t < min) min = t; }
    return Number.isFinite(min) ? min : null;
  }

  let running = false;
  async function run() {
    if (running || !process.env.RESEND_API_KEY) return;
    running = true;
    try {
      db.prepare("UPDATE flight_alerts SET active = 0 WHERE active = 1 AND depart < date('now', '+1 day')").run();
      const due = db.prepare("SELECT * FROM flight_alerts WHERE active = 1 AND (last_checked IS NULL OR last_checked <= datetime('now', '-20 hours')) ORDER BY last_checked LIMIT 15").all();
      for (const a of due) {
        db.prepare("UPDATE flight_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = ?").run(a.id);
        let p = null;
        try { p = await cheapest(a); } catch {}
        if (p != null) {
          const ref = Math.min(...[a.last_price, a.baseline].filter(x => x > 0));
          if (Number.isFinite(ref) && p <= ref * 0.95) {
            const pct = Math.round((1 - p / ref) * 100);
            await sendEmail({
              to: a.email, subject: `${route(a)} is ${pct}% cheaper: now ${money(p, a.currency)}`,
              html: `<div style="font-family:Arial,sans-serif;background:#f6f8fc;padding:24px"><div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;padding:26px;border:1px solid #e4e8f1">
                <div style="font-weight:800;font-size:18px;color:#1f5bff">PlanurStay</div>
                <h1 style="font-size:22px;color:#0b1b3f;margin:16px 0 6px">Fares dropped for ${esc(route(a))}</h1>
                <p style="color:#4a5572">${esc(a.depart)}${a.ret ? ` – ${esc(a.ret)}` : " (one way)"} · ${a.adults || 1} traveler${(a.adults || 1) > 1 ? "s" : ""}</p>
                <p style="margin:12px 0;padding:12px 14px;border-radius:10px;background:#effaf4;color:#0a7d46;font-weight:700">Now from ${money(p, a.currency)} total, down from ${money(ref, a.currency)}.</p>
                <p style="margin:20px 0"><a href="${esc(resultsUrl(a))}" style="background:#1f5bff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">See flights</a></p>
                <p style="color:#7a849c;font-size:12px">Fares change quickly and are confirmed at checkout. <a href="${base()}/api/flight-alerts/unsubscribe?token=${a.token}" style="color:#7a849c">Stop this alert</a>.</p></div></div>`,
            }).catch(() => {});
          }
          db.prepare("UPDATE flight_alerts SET last_price = ? WHERE id = ?").run(Math.min(p, a.last_price || Infinity), a.id);
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    } finally { running = false; }
  }
  setTimeout(run, 4 * 60 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();

  function register(app, { jwt, JWT_SECRET }) {
    app.post("/api/flight-alerts", (req, res) => {
      if (limited(req)) return res.status(429).json({ error: "Too many requests. Please try again in a few minutes." });
      const b = req.body || {};
      const email = String(b.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) || email.length > 200) return res.status(400).json({ error: "Enter a valid email address" });
      const from = String(b.from || "").toUpperCase(), to = String(b.to || "").toUpperCase();
      if (!IATA.test(from) || !IATA.test(to) || !DATE.test(b.depart || "") || (b.return && !DATE.test(b.return))) return res.status(400).json({ error: "Search details are missing" });
      if (b.depart < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: "This date has already passed" });
      const currency = /^[A-Z]{3}$/.test(b.currency || "") ? b.currency : "USD";
      let userId = null; try { userId = jwt.verify(req.cookies?.token || "", JWT_SECRET).id; } catch {}
      const dup = db.prepare("SELECT id FROM flight_alerts WHERE email = ? AND origin = ? AND destination = ? AND depart = ? AND COALESCE(ret,'') = ? AND active = 1").get(email, from, to, b.depart, b.return || "");
      if (dup) return res.json({ success: true, already: true });
      const price = +b.price > 0 ? +b.price : null, token = crypto.randomBytes(18).toString("hex");
      const a = { email, origin: from, destination: to, from_city: String(b.fromCity || "").slice(0, 60), to_city: String(b.toCity || "").slice(0, 60), country: /^[A-Z]{2}$/.test(b.fromCountry || "") ? b.fromCountry : "US",
        depart: b.depart, ret: b.return || null, adults: Math.min(9, Math.max(1, +b.adults || 1)), currency, token };
      db.prepare(`INSERT INTO flight_alerts (email, user_id, origin, destination, from_city, to_city, country, depart, ret, adults, currency, baseline, last_price, token, last_checked)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(email, userId, a.origin, a.destination, a.from_city, a.to_city, a.country, a.depart, a.ret, a.adults, currency, price, price, token);
      sendEmail({
        to: email, subject: `We're watching fares for ${route(a)}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2 style="margin:0 0 8px;color:#0b1b3f">Fare alert is on</h2>
          <p style="color:#4a5572">We'll check <b>${esc(route(a))}</b> for ${esc(a.depart)}${a.ret ? ` – ${esc(a.ret)}` : ""} every day and email you when it gets cheaper${price ? ` than <b>${money(price, currency)}</b>` : ""}.</p>
          <p><a href="${esc(resultsUrl(a))}" style="color:#1f5bff">See current fares</a> · <a href="${base()}/api/flight-alerts/unsubscribe?token=${token}" style="color:#7a849c">Stop this alert</a></p></div>`,
      }).catch(() => {});
      res.json({ success: true });
    });
    app.get("/api/flight-alerts/unsubscribe", (req, res) => {
      const r = db.prepare("UPDATE flight_alerts SET active = 0 WHERE token = ?").run(String(req.query.token || ""));
      res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fare alert — PlanurStay</title><link rel="stylesheet" href="/css/ps.css"></head>
        <body><main class="container" style="text-align:center;padding:90px 24px"><h1 style="font-size:28px">${r.changes ? "Fare alert stopped" : "Alert not found"}</h1>
        <p style="color:var(--text-2);margin:10px 0 24px">${r.changes ? "You won't get more emails for this route." : "This link may have been used already."}</p><a class="btn btn-primary" href="/">Back to PlanurStay</a></main></body></html>`);
    });
  }
  return { register, run };
}

module.exports = { createFlightAlerts };
