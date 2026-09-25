/**
 * Admin: revenue dashboard + pricing probe.
 * Access: signed-in users whose email is listed in ADMIN_EMAILS (comma separated). No env → no admin.
 *
 *   GET /api/admin/overview?from=YYYY-MM-DD&to=YYYY-MM-DD   LiteAPI analytics + our own DB stats
 *   GET /api/admin/pricing-probe?q=City&checkin=&checkout=   net vs SSP vs our public price, per hotel
 */
const pricing = require("./pricing");

function createAdmin({ db, apiKey, jwt, JWT_SECRET, dbInfo = {} }) {
  // Tolerant parsing: ADMIN_EMAILS or ADMIN_EMAIL, separated by commas/semicolons/spaces, quotes ignored.
  const admins = () => (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || "")
    .split(/[,;\s]+/).map(s => s.replace(/["'<>]/g, "").trim().toLowerCase()).filter(s => s.includes("@"));
  const adminUser = (req) => {
    try {
      const u = jwt.verify(req.cookies?.token || "", JWT_SECRET);
      return admins().includes(String(u.email || "").trim().toLowerCase()) ? u : null;
    } catch { return null; }
  };
  const guard = (req, res, next) => (adminUser(req) ? next() : res.status(403).json({ error: "Admins only" }));

  // Markup settings editable from /admin; persisted so they survive restarts (with a persistent disk).
  db.exec("CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  const loadSettings = () => {
    const o = {};
    for (const r of db.prepare("SELECT key, value FROM site_settings WHERE key IN ('publicMargin','memberMargin')").all()) o[r.key] = r.value === "" ? null : +r.value;
    pricing.setOverrides(o);
  };
  loadSettings();

  async function da(path, body) {
    const r = await fetch("https://da.liteapi.travel" + path, {
      method: "POST", headers: { "X-Api-Key": apiKey(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j.data : null;
  }
  async function rates(body) {
    const r = await fetch("https://api.liteapi.travel/v3.0/hotels/rates", {
      method: "POST", headers: { "X-API-Key": apiKey(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    return r.json().catch(() => ({}));
  }
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return {}; } };
  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };

  function register(app) {
    // Tells the /admin page why access was refused (never reveals who the admins are)
    app.get("/api/admin/me", (req, res) => {
      let email = null;
      try { email = jwt.verify(req.cookies?.token || "", JWT_SECRET).email || null; } catch {}
      res.json({ admin: !!adminUser(req), signedIn: !!email, email, adminListSet: admins().length > 0 });
    });

    // Public: current member saving for marketing copy (no margins exposed)
    app.get("/api/pricing/summary", (req, res) => res.json({ memberSavePct: pricing.memberSavePct() }));

    app.post("/api/admin/pricing", guard, (req, res) => {
      const b = req.body || {};
      const val = (v) => (v === "" || v == null ? null : +v);
      const pub = val(b.publicMargin), mem = val(b.memberMargin);
      const eff = { pub: pub ?? +(process.env.PUBLIC_MARGIN || 16), mem: mem ?? +(process.env.MEMBER_MARGIN || 6) };
      if ([pub, mem].some(v => v != null && !(Number.isFinite(v) && v >= 0 && v <= 40))) return res.status(400).json({ error: "Margins must be between 0 and 40" });
      if (eff.mem > eff.pub) return res.status(400).json({ error: "Member margin can't be higher than the public margin" });
      const up = db.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP");
      up.run("publicMargin", pub == null ? "" : String(pub));
      up.run("memberMargin", mem == null ? "" : String(mem));
      loadSettings();
      res.json({ success: true, publicMargin: pricing.PUBLIC_MARGIN(), memberMargin: pricing.MEMBER_MARGIN(), memberSavePct: pricing.memberSavePct() });
    });

    app.get("/api/admin/overview", guard, async (req, res) => {
      const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const [report, weekly, markets, hotels] = await Promise.all([
        da("/analytics/report", { from, to }), da("/analytics/weekly", { from, to }),
        da("/analytics/markets", { from, to }), da("/analytics/hotels", { from, to }),
      ]);
      const sumBy = (arr, k) => (arr || []).reduce((s, x) => s + (+x[k] || 0), 0);
      const pts = one("SELECT COALESCE(SUM(CASE WHEN type IN ('earn','bonus','redeem','reverse') THEN points END),0) AS avail, COALESCE(SUM(CASE WHEN type='pending' THEN points END),0) AS pending FROM rewards_ledger") || {};
      res.json({
        success: true, from, to, database: dbInfo,
        pricing: { publicMargin: pricing.PUBLIC_MARGIN(), memberMargin: pricing.MEMBER_MARGIN(), memberSavePct: pricing.memberSavePct(), parityGate: process.env.PARITY_GATE === "on" },
        liteapi: {
          totals: {
            sales: sumBy(report?.sales, "sales"), commission: sumBy(report?.commission, "commission"),
            bookings: sumBy(report?.confirmed_booking, "confirmed_booking"),
            currency: report?.sales?.[0]?.currency || report?.commission?.[0]?.currency || "",
          },
          daily: (report?.uniqueDates || []).map(d => ({
            date: d.slice(0, 10),
            sales: (report.sales || []).find(x => x.date === d)?.sales || 0,
            commission: (report.commission || []).find(x => x.date === d)?.commission || 0,
            bookings: (report.confirmed_booking || []).find(x => x.date === d)?.confirmed_booking || 0,
          })),
          weekly: weekly?.arr || [], markets: markets || [], hotels: (hotels || []).slice(0, 15),
        },
        site: {
          users: one("SELECT COUNT(*) AS n FROM users")?.n || 0,
          hotelBookings: one("SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS value FROM bookings WHERE created_at >= ? AND created_at < date(?, '+1 day')", from, to) || {},
          flightBookings: one("SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS value FROM flight_bookings WHERE created_at >= ? AND created_at < date(?, '+1 day')", from, to) || {},
          memberBookings: one("SELECT COUNT(*) AS n FROM bookings WHERE user_id IS NOT NULL AND created_at >= ? AND created_at < date(?, '+1 day')", from, to)?.n || 0,
          priceAlerts: one("SELECT COUNT(*) AS n FROM price_alerts")?.n || 0,
          newsletter: one("SELECT COUNT(*) AS n FROM newsletter")?.n || 0,
          rewards: {
            pointsAvailable: pts.avail || 0, pointsPending: pts.pending || 0,
            liabilityUsd: +(((pts.avail || 0) + (pts.pending || 0)) / 100).toFixed(2),
            vouchers: all("SELECT status, COUNT(*) AS n, COALESCE(SUM(value),0) AS value FROM rewards_vouchers GROUP BY status"),
          },
          recent: all("SELECT hotel_name AS name, checkin, price, currency, status, created_at, CASE WHEN user_id IS NULL THEN 'guest' ELSE 'member' END AS who FROM bookings ORDER BY id DESC LIMIT 10"),
        },
      });
    });

    // How much room is there between net, SSP and our public price? Also: does SSP move with our margin?
    app.get("/api/admin/pricing-probe", guard, async (req, res) => {
      const q = String(req.query.q || "New York").slice(0, 60);
      const checkin = /^\d{4}-\d{2}-\d{2}$/.test(req.query.checkin) ? req.query.checkin : new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
      const checkout = /^\d{4}-\d{2}-\d{2}$/.test(req.query.checkout) ? req.query.checkout : new Date(Date.parse(checkin) + 2 * 86400000).toISOString().slice(0, 10);
      try {
        const pr = await fetch(`https://api.liteapi.travel/v3.0/data/places?textQuery=${encodeURIComponent(q)}`, { headers: { "X-API-Key": apiKey() } }).then(r => r.json());
        const placeId = pr.data?.[0]?.placeId;
        if (!placeId) return res.status(404).json({ error: "Place not found" });
        const base = { placeId, checkin, checkout, occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", maxRatesPerHotel: 1, limit: 40, timeout: 12 };
        const P = pricing.PUBLIC_MARGIN();
        const [r0, rP] = await Promise.all([rates({ ...base, margin: 0 }), rates({ ...base, margin: P })]);
        const pick = (entry) => {
          let best = null;
          for (const rt of entry.roomTypes || []) {
            const t = rt.offerRetailRate?.amount;
            if (t != null && (!best || t < best.total)) best = { total: t, ssp: rt.suggestedSellingPrice?.amount || null, room: rt.rates?.[0]?.name };
          }
          return best;
        };
        const atP = new Map((rP.data || []).map(e => [e.hotelId, pick(e)]));
        const rows = (r0.data || []).map(e => {
          const n = pick(e), p = atP.get(e.hotelId);
          if (!n || !p) return null;
          return {
            hotelId: e.hotelId, room: n.room, net: n.total, sspAtMargin0: n.ssp, publicTotal: p.total, sspAtPublicMargin: p.ssp,
            sspOverNet: n.ssp ? +(n.ssp / n.total).toFixed(3) : null,
            publicOverSsp: p.ssp ? +(p.total / p.ssp).toFixed(3) : null,
          };
        }).filter(Boolean);
        const med = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
        res.json({
          success: true, q, placeId, checkin, checkout, publicMargin: P, hotels: rows.length,
          summary: {
            medianSspOverNet: med(rows.map(r => r.sspOverNet)),
            medianPublicOverSsp: med(rows.map(r => r.publicOverSsp)),
            sspMovesWithMargin: rows.filter(r => r.sspAtMargin0 && r.sspAtPublicMargin && Math.abs(r.sspAtPublicMargin / r.sspAtMargin0 - 1) > 0.01).length,
            belowSspAtPublicMargin: rows.filter(r => r.publicOverSsp != null && r.publicOverSsp < 0.995).length,
          },
          rows,
        });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
  }
  return { register, isAdmin: (req) => !!adminUser(req) };
}

module.exports = { createAdmin };
