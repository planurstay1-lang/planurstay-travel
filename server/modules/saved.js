/**
 * Saved hotels (♥) for signed-in members. Guests keep saves in their browser (ps.js), which are
 * moved into the account on the next visit after signing in.
 *
 *   GET  /api/saved                 → list
 *   POST /api/saved                 { hotelId, name, photo, city, stars, rating, saved: true|false }
 *   POST /api/saved/import          { items: [...] }  (device saves → account)
 */
function createSaved({ db, jwt, JWT_SECRET }) {
  db.exec(`CREATE TABLE IF NOT EXISTS saved_hotels (
    user_id INTEGER NOT NULL, hotel_id TEXT NOT NULL, name TEXT, photo TEXT, city TEXT, stars REAL, rating REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, hotel_id))`);
  const uid = (req) => { try { return jwt.verify(req.cookies?.token || "", JWT_SECRET).id || null; } catch { return null; } };
  const clean = (h) => ({
    hotelId: String(h.hotelId || ""), name: String(h.name || "").slice(0, 160), photo: /^https:\/\//.test(h.photo || "") ? String(h.photo).slice(0, 500) : null,
    city: String(h.city || "").slice(0, 80), stars: +h.stars || null, rating: +h.rating || null,
  });
  const valid = (h) => /^lp[0-9a-z]+$/i.test(h.hotelId);
  const upsert = db.prepare(`INSERT INTO saved_hotels (user_id, hotel_id, name, photo, city, stars, rating) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, hotel_id) DO UPDATE SET name = excluded.name, photo = COALESCE(excluded.photo, photo), city = excluded.city, stars = excluded.stars, rating = excluded.rating`);

  function register(app) {
    app.get("/api/saved", (req, res) => {
      const u = uid(req);
      if (!u) return res.status(401).json({ error: "Sign in to see saved hotels" });
      const rows = db.prepare("SELECT hotel_id AS hotelId, name, photo, city, stars, rating, created_at AS savedAt FROM saved_hotels WHERE user_id = ? ORDER BY created_at DESC LIMIT 200").all(u);
      res.json({ success: true, data: rows });
    });
    app.post("/api/saved", (req, res) => {
      const u = uid(req);
      if (!u) return res.status(401).json({ error: "Sign in to save hotels" });
      const h = clean(req.body || {});
      if (!valid(h)) return res.status(400).json({ error: "Invalid hotel" });
      if (req.body.saved === false) db.prepare("DELETE FROM saved_hotels WHERE user_id = ? AND hotel_id = ?").run(u, h.hotelId);
      else {
        const n = db.prepare("SELECT COUNT(*) AS n FROM saved_hotels WHERE user_id = ?").get(u).n;
        if (n >= 200) return res.status(400).json({ error: "You can save up to 200 hotels" });
        upsert.run(u, h.hotelId, h.name, h.photo, h.city, h.stars, h.rating);
      }
      res.json({ success: true, saved: req.body.saved !== false });
    });
    app.post("/api/saved/import", (req, res) => {
      const u = uid(req);
      if (!u) return res.status(401).json({ error: "Sign in first" });
      const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 100).map(clean).filter(valid);
      db.transaction(() => items.forEach(h => upsert.run(u, h.hotelId, h.name, h.photo, h.city, h.stars, h.rating)))();
      res.json({ success: true, imported: items.length });
    });
  }
  return { register };
}

module.exports = { createSaved };
