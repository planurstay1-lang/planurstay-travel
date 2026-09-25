/**
 * First-party, cookieless site analytics: page views + booking funnel.
 * Visitors are an anonymous random ID in localStorage — no names, emails or IPs are stored.
 *
 *   POST /api/t                 { e, p, r, v, s, m }  (sent by ps.js with sendBeacon)
 *   GET  /api/admin/traffic     admin only — visitors, funnel, top pages, referrers, searches
 */
const EVENTS = new Set([
  "home", "hotel_results", "hotel_view", "flight_results", "flight_view", "checkout", "booked",
  "guides", "guide", "rewards", "trips", "login", "legal", "page",
]);
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|monitor|curl|wget|python|axios|node-fetch/i;

function createAnalytics({ db, isAdmin }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts DATETIME DEFAULT CURRENT_TIMESTAMP,
      vid TEXT, sid TEXT, event TEXT, path TEXT, ref TEXT, device TEXT, meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_site_events_ts ON site_events(ts);
  `);
  const insert = db.prepare("INSERT INTO site_events (vid, sid, event, path, ref, device, meta) VALUES (?, ?, ?, ?, ?, ?, ?)");

  // Crude per-IP rate limit so a script can't flood the table (IP is used in memory only, never stored).
  const hits = new Map();
  setInterval(() => hits.clear(), 60 * 1000).unref();
  const clip = (v, n) => String(v ?? "").slice(0, n);
  const refHost = (r) => { try { const h = new URL(r).hostname.replace(/^www\./, ""); return h; } catch { return ""; } };

  // Keep ~13 months, as the privacy policy says.
  const prune = () => { try { db.prepare("DELETE FROM site_events WHERE ts < datetime('now', '-395 days')").run(); } catch {} };
  setInterval(prune, 24 * 3600 * 1000).unref();

  function register(app) {
    app.post("/api/t", (req, res) => {
      res.status(204).end();
      const ua = req.get("user-agent") || "";
      if (BOT.test(ua)) return;
      const ip = req.ip || "";
      const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
      if (n > 120) return;
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch { return; } }
      if (!b || !EVENTS.has(b.e) || !/^[a-z0-9]{8,32}$/i.test(b.v || "")) return;
      const host = req.get("host") || "";
      const ref = refHost(b.r);
      const meta = b.m && typeof b.m === "object" ? JSON.stringify(b.m).slice(0, 400) : null;
      try {
        insert.run(clip(b.v, 32), clip(b.s, 32), b.e, clip(b.p, 200), ref && !host.includes(ref) ? ref : "", /mobi|android|iphone/i.test(ua) ? "mobile" : "desktop", meta);
      } catch { /* never break the page */ }
    });

    app.get("/api/admin/traffic", (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: "Admins only" });
      const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const W = "ts >= ? AND ts < date(?, '+1 day')";
      const q = (sql, ...a) => db.prepare(sql).all(from, to, ...a);
      const uniq = (events) => db.prepare(`SELECT COUNT(DISTINCT vid) AS n FROM site_events WHERE ${W} AND event IN (${events.map(() => "?").join(",")})`).get(from, to, ...events).n;
      const totals = db.prepare(`SELECT COUNT(DISTINCT vid) AS visitors, COUNT(DISTINCT sid) AS sessions, COUNT(*) AS views FROM site_events WHERE ${W}`).get(from, to);
      const funnel = [
        ["Visited", uniq([...EVENTS])],
        ["Searched", uniq(["hotel_results", "flight_results"])],
        ["Viewed a hotel or flight", uniq(["hotel_view", "flight_view"])],
        ["Started checkout", uniq(["checkout"])],
        ["Booked", uniq(["booked"])],
      ].map(([label, n]) => ({ label, n }));
      res.json({
        success: true, from, to, totals, funnel,
        daily: q(`SELECT date(ts) AS day, COUNT(DISTINCT vid) AS visitors, COUNT(*) AS views FROM site_events WHERE ${W} GROUP BY day ORDER BY day`),
        pages: q(`SELECT event, COUNT(*) AS views, COUNT(DISTINCT vid) AS visitors FROM site_events WHERE ${W} GROUP BY event ORDER BY views DESC`),
        referrers: q(`SELECT ref, COUNT(DISTINCT vid) AS visitors FROM site_events WHERE ${W} AND ref != '' GROUP BY ref ORDER BY visitors DESC LIMIT 12`),
        devices: q(`SELECT device, COUNT(DISTINCT vid) AS visitors FROM site_events WHERE ${W} GROUP BY device`),
        searches: q(`SELECT json_extract(meta, '$.dest') AS dest, COUNT(*) AS n FROM site_events WHERE ${W} AND event IN ('hotel_results','flight_results') AND json_extract(meta, '$.dest') IS NOT NULL GROUP BY dest ORDER BY n DESC LIMIT 12`),
      });
    });
  }
  return { register };
}

module.exports = { createAnalytics };
