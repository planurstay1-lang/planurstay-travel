/**
 * Ready searches: a Travellez hotel search takes 30-40 s, so the likeliest searches are run in the background and kept
 * in the search cache, and a customer making one gets Travellez hotels at once (prices are re-checked live on the hotel
 * page and at checkout, so a card price is at most one cycle old).
 *
 * What gets warmed, every PREWARM_EVERY_MIN (default 30) between 6:00 and 1:00 Toronto time, at most PREWARM_MAX (8):
 *   1. the top destinations of the last 14 days at the search form's default dates (check-in in 14 days, 3 nights,
 *      2 adults, 1 room) — what most visitors search without changing anything;
 *   2. exact searches made at least twice in the last 3 days (returning visitors, shared links), still in the future.
 * Searches are recorded by the stays route (record) in search_demand. On/off from /admin (site_settings 'prewarm').
 */
const TZ = () => process.env.PREWARM_TZ || "America/Toronto";
const num = (v, d) => (Number.isFinite(+v) && v !== "" && v != null ? +v : d);
const localDate = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", { timeZone: TZ() }); // YYYY-MM-DD
const localHour = () => +new Date().toLocaleString("en-US", { timeZone: TZ(), hour: "numeric", hour12: false }) % 24;
let instance = null; // for /admin
const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/**
 * keyFor(p) → the stays route's cache key for search p; search(p) → MCP hotel list; put(key, ttlMs, list) → cache it.
 * p = { placeId, dest, c: { lat, lng }, checkin, checkout, adults, rooms, currency }
 */
function createPrewarm({ db, keyFor, search, put, enabled = () => true }) {
  db.exec(`CREATE TABLE IF NOT EXISTS search_demand (
    key TEXT PRIMARY KEY, place_id TEXT, dest TEXT, lat REAL, lng REAL, checkin TEXT, checkout TEXT, adults INTEGER, rooms INTEGER,
    currency TEXT, hits INTEGER DEFAULT 0, first_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_search_demand_last ON search_demand(last_at)");
  db.exec("CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  let on = true;
  try { on = JSON.parse(db.prepare("SELECT value FROM site_settings WHERE key = 'prewarm'").get()?.value || "{}").on !== false; } catch { /* default on */ }
  if (process.env.PREWARM === "off") on = false;

  const every = () => Math.max(10, num(process.env.PREWARM_EVERY_MIN, 30)) * 60000;
  const ttl = () => every() + 10 * 60000; // outlives the gap to the next cycle
  const warm = new Map(); // key → { exp, dest, checkin, checkout, hotels, ms, at }
  const served = { day: localDate(), n: 0 };
  let running = false, lastRun = null;

  const upsert = db.prepare(`INSERT INTO search_demand (key, place_id, dest, lat, lng, checkin, checkout, adults, rooms, currency, hits)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET hits = hits + 1, last_at = CURRENT_TIMESTAMP, dest = COALESCE(excluded.dest, dest)`);
  /** A customer's hotel search (destination searches only; map drags aren't repeatable). Never throws. */
  function record(p) {
    try {
      // keyFor(p, true): the demand key, without the supplier-switch generation
      if (!p?.placeId || !p.c || !/^\d{4}-\d{2}-\d{2}$/.test(p.checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(p.checkout)) return;
      upsert.run(keyFor(p, true), String(p.placeId).slice(0, 120), String(p.dest || "").slice(0, 120) || null, +p.c.lat, +p.c.lng,
        p.checkin, p.checkout, +p.adults || 2, +p.rooms || 1, String(p.currency || "USD").toUpperCase());
    } catch (e) { console.warn("Search demand:", e.message); }
  }
  /** The stays route asks before searching: true = this search was warmed (counted for the admin page). */
  function isWarm(p) {
    const w = warm.get(keyFor(p));
    if (!w || w.exp < Date.now()) return false;
    const d = localDate(); if (served.day !== d) { served.day = d; served.n = 0; }
    served.n++;
    return true;
  }

  const row2p = (r, checkin, checkout, adults, rooms) => ({ placeId: r.place_id, dest: r.dest, c: { lat: r.lat, lng: r.lng },
    checkin: checkin || r.checkin, checkout: checkout || r.checkout, adults: adults || r.adults, rooms: rooms || r.rooms, currency: r.currency });
  /** What the next cycle warms, most valuable first. */
  function plan() {
    const max = Math.max(0, num(process.env.PREWARM_MAX, 8)), today = localDate();
    const ci = addDays(today, 14), co = addDays(ci, 3), out = [], keys = new Set();
    const add = (p) => { const k = keyFor(p); if (!keys.has(k) && out.length < max) { keys.add(k); out.push(p); } };
    // Top destinations at the form's default dates (latest centre and name for each place + currency)
    const top = db.prepare(`SELECT place_id, currency, SUM(hits) AS h, MAX(last_at) AS last FROM search_demand
      WHERE last_at >= datetime('now', '-14 days') GROUP BY place_id, currency ORDER BY h DESC, last DESC LIMIT ?`).all(max);
    const latest = db.prepare("SELECT * FROM search_demand WHERE place_id = ? AND currency = ? ORDER BY last_at DESC LIMIT 1");
    const repeats = db.prepare(`SELECT * FROM search_demand WHERE hits >= 2 AND last_at >= datetime('now', '-3 days') AND checkin > ?
      ORDER BY hits DESC, last_at DESC LIMIT ?`).all(today, max);
    // Interleave so both kinds get a share when the cap is tight
    for (let i = 0; i < max && (i < top.length || i < repeats.length); i++) {
      if (top[i]) { const r = latest.get(top[i].place_id, top[i].currency); if (r) add(row2p(r, ci, co, 2, 1)); }
      if (repeats[i]) add(row2p(repeats[i]));
    }
    return out;
  }

  async function cycle(force = false) {
    if (running || (!force && (!on || !enabled()))) return;
    const h = localHour();
    if (!force && h >= 1 && h < 6) return; // hardly anyone searches at night
    running = true;
    const t0 = Date.now(), done = [];
    try {
      for (const [k, w] of warm) if (w.exp < t0) warm.delete(k);
      for (const p of plan()) {
        const s0 = Date.now();
        const list = await search(p).catch(e => { console.warn("Prewarm search:", e.message); return []; });
        const info = { dest: p.dest || p.placeId, checkin: p.checkin, checkout: p.checkout, currency: p.currency, hotels: list.length, ms: Date.now() - s0, at: new Date().toISOString() };
        if (list.length) { put(keyFor(p), ttl(), list); warm.set(keyFor(p), { ...info, exp: Date.now() + ttl() }); }
        done.push(info);
        await new Promise(r => setTimeout(r, 2000)); // be gentle with Travellez
      }
    } finally {
      running = false;
      lastRun = { at: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000), searches: done };
      if (done.length) console.log(`Prewarm: ${done.filter(d => d.hotels).length}/${done.length} searches ready in ${lastRun.seconds}s`);
    }
  }
  const timer = setInterval(() => cycle().catch(e => console.warn("Prewarm:", e.message)), every());
  timer.unref?.();
  const first = setTimeout(() => cycle().catch(() => {}), 90000);
  first.unref?.();
  // Forget demand older than 60 days
  const prune = setInterval(() => { try { db.prepare("DELETE FROM search_demand WHERE last_at < datetime('now', '-60 days')").run(); } catch {} }, 24 * 3600000);
  prune.unref?.();

  return instance = {
    record, isWarm, plan, cycle,
    setOn(v) {
      on = !!v;
      db.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('prewarm', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(JSON.stringify({ on }));
      if (on) setTimeout(() => cycle().catch(() => {}), 1000).unref?.();
      return on;
    },
    status: () => ({ on, active: on && enabled(), everyMin: every() / 60000, running, lastRun, servedToday: served.day === localDate() ? served.n : 0,
      ready: [...warm.values()].filter(w => w.exp > Date.now()).map(({ exp, ...w }) => w), next: plan().map(p => ({ dest: p.dest || p.placeId, checkin: p.checkin, checkout: p.checkout, currency: p.currency })) }),
  };
}

module.exports = { createPrewarm, current: () => instance };
