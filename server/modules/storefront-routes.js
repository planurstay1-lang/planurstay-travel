/**
 * Storefront routes — read-only search endpoints used by the redesigned site.
 *
 *   GET  /api/places?q=paris        → destination autocomplete (LiteAPI /data/places)
 *   GET  /api/airports?q=toronto    → airport autocomplete (cached /data/iataCodes, ranked)
 *   POST /api/stays/search          → hotels + cheapest rate for a place or hotel list
 *   POST /api/stays/rooms           → every room & rate for one hotel
 *   POST /api/flights/offers        → flight search trimmed to what the results page renders
 *   GET  /api/trips                 → signed-in user's hotel + flight bookings
 *
 * Registered before the legacy /api/hotels/:id route so nothing is shadowed.
 * Booking (prebook/book) still goes through the existing /api/hotels/* and
 * /api/flights/* routes.
 */

const BASE_URL = "https://api.liteapi.travel/v3.0";

// Major airports get a ranking boost and a friendly city name.
const MAJOR_AIRPORTS = {
  ATL: "Atlanta", LAX: "Los Angeles", ORD: "Chicago", DFW: "Dallas", DEN: "Denver", JFK: "New York",
  LGA: "New York", EWR: "Newark", SFO: "San Francisco", SEA: "Seattle", LAS: "Las Vegas", MCO: "Orlando",
  MIA: "Miami", CLT: "Charlotte", PHX: "Phoenix", IAH: "Houston", BOS: "Boston", MSP: "Minneapolis",
  DTW: "Detroit", PHL: "Philadelphia", FLL: "Fort Lauderdale", BWI: "Baltimore", IAD: "Washington",
  DCA: "Washington", SAN: "San Diego", TPA: "Tampa", HNL: "Honolulu", AUS: "Austin", BNA: "Nashville",
  YYZ: "Toronto", YTZ: "Toronto", YVR: "Vancouver", YUL: "Montreal", YYC: "Calgary", YEG: "Edmonton",
  YOW: "Ottawa", YHZ: "Halifax", YWG: "Winnipeg", LHR: "London", LGW: "London", STN: "London",
  CDG: "Paris", ORY: "Paris", AMS: "Amsterdam", FRA: "Frankfurt", MUC: "Munich", MAD: "Madrid",
  BCN: "Barcelona", FCO: "Rome", MXP: "Milan", ZRH: "Zurich", VIE: "Vienna", DUB: "Dublin",
  LIS: "Lisbon", CPH: "Copenhagen", ARN: "Stockholm", OSL: "Oslo", HEL: "Helsinki", IST: "Istanbul",
  ATH: "Athens", BRU: "Brussels", PRG: "Prague", WAW: "Warsaw", EDI: "Edinburgh", MAN: "Manchester",
  DXB: "Dubai", AUH: "Abu Dhabi", DOH: "Doha", DEL: "Delhi", BOM: "Mumbai", BLR: "Bangalore",
  MAA: "Chennai", HYD: "Hyderabad", COK: "Kochi", SIN: "Singapore", HKG: "Hong Kong", NRT: "Tokyo",
  HND: "Tokyo", KIX: "Osaka", ICN: "Seoul", PEK: "Beijing", PVG: "Shanghai", BKK: "Bangkok",
  KUL: "Kuala Lumpur", CGK: "Jakarta", DPS: "Bali", MNL: "Manila", SYD: "Sydney", MEL: "Melbourne",
  BNE: "Brisbane", AKL: "Auckland", MEX: "Mexico City", CUN: "Cancun", GRU: "Sao Paulo",
  GIG: "Rio de Janeiro", EZE: "Buenos Aires", BOG: "Bogota", LIM: "Lima", SCL: "Santiago",
  JNB: "Johannesburg", CPT: "Cape Town", CAI: "Cairo", NBO: "Nairobi", CMN: "Casablanca",
  PUJ: "Punta Cana", MBJ: "Montego Bay", NAS: "Nassau", SJU: "San Juan",
};

function registerStorefrontRoutes(app, { apiKey, jwt, JWT_SECRET, db }) {
  // LiteAPI rate-limits bursts (429): wait and retry up to twice before giving up.
  async function lite(path, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      const r = await liteOnce(path, opts);
      if (r.status !== 429 || attempt >= 2) return r;
      await new Promise(res => setTimeout(res, 800 * (attempt + 1) + Math.random() * 400));
    }
  }
  async function liteOnce(path, { method = "GET", body, timeoutMs = 45000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(BASE_URL + path, {
        method,
        signal: controller.signal,
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, json };
    } catch (err) {
      if (err.name === "AbortError") return { ok: false, status: 408, json: { error: { message: "The search took too long. Please try again." } } };
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Short-lived cache + in-flight de-duplication. Repeat searches (back button,
  // re-sorting, a second visitor with the same dates) return instantly instead of
  // waiting on LiteAPI again. Failed lookups are never cached.
  const cache = new Map();
  function cached(key, ttlMs, fn, okTest = (v) => v && v.ok !== false && v.success !== false) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.exp > now) return hit.p;
    const p = Promise.resolve().then(fn).then(v => { if (!okTest(v)) cache.delete(key); return v; }, e => { cache.delete(key); throw e; });
    cache.set(key, { exp: now + ttlMs, p });
    if (cache.size > 500) for (const [k, v] of cache) { if (v.exp <= now || cache.size > 400) cache.delete(k); }
    return p;
  }
  const MIN = 60 * 1000;

  function errMessage(r, fallback) {
    return r.json?.error?.message || r.json?.error?.description || r.json?.message || fallback;
  }

  // Same pricing rule as the legacy search: members see net rates, guests get a 10% margin.
  const pricing = require("./pricing");
  const isMember = (req) => { try { return !!jwt.verify(req.cookies?.token || "", JWT_SECRET); } catch { return false; } };
  function marginFor(req) { return pricing.marginFor(isMember(req)); }
  // Extra hotel discount for paid members (Essential / Plus), in margin points
  const paidExtra = (req) => {
    try {
      const u = jwt.verify(req.cookies?.token || "", JWT_SECRET);
      const row = db.prepare("SELECT plan_id FROM user_memberships WHERE user_id = ? AND status = 'active' AND plan_id != 'free'").get(u.id);
      return row ? pricing.paidExtraPct(row.plan_id) : 0;
    } catch { return 0; }
  };
  // Public prices must not be below the hotel's SSP (rate parity). Members are a closed user group.
  function applyParity(o, member) {
    // Prices come from pricing.priceFor, so guests are never below the hotel's price.
    if (member) { o.memberPrice = true; o.strikeTotal = o.publicTotal > o.total ? o.publicTotal : null; }
    else { o.memberOnly = false; o.strikeTotal = null; }
    delete o.ssp; delete o.publicTotal;
    return o;
  }

  function occupancies(b) {
    const rooms = Math.max(1, parseInt(b.rooms) || 1);
    const adults = Math.max(1, parseInt(b.adults) || 2);
    const childAges = Array.isArray(b.childAges) ? b.childAges.map(n => parseInt(n)).filter(n => n >= 0 && n < 18) : [];
    // Spread adults across rooms; children go in the first room.
    const per = Math.max(1, Math.floor(adults / rooms));
    return Array.from({ length: rooms }, (_, i) => ({
      adults: i === rooms - 1 ? adults - per * (rooms - 1) || 1 : per,
      ...(i === 0 && childAges.length ? { children: childAges } : {}),
    }));
  }

  // ─── Coordinates of one place (for "distance from landmark" on results) ───
  app.get("/api/places/:placeId/location", async (req, res) => {
    const id = String(req.params.placeId || "");
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) return res.status(400).json({ error: "Invalid place" });
    try {
      const r = await cached("placeloc:" + id, 30 * 24 * 60 * MIN, () => lite(`/data/places/${encodeURIComponent(id)}`, { timeoutMs: 10000 }));
      const d = r.json?.data;
      if (!r.ok || !d?.location) return res.status(404).json({ error: "Location not found" });
      res.json({ success: true, data: { name: d.displayName?.text || d.displayName || "", lat: d.location.latitude, lng: d.location.longitude } });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });

  // ─── Amenity groups built from LiteAPI's facility list (820 types → a handful people filter by) ───
  // [key, include, exclude]; anything starting with "No " never counts.
  const AMENITY_RULES = [
    ["pool", /pool/i, /table|umbrella|cabana|lounger|nearby|towel|bar|view|toy|fence|cover|access to|hoist|lift|billiard|ramp|waterfall|wheelchair/i],
    ["parking", /parking/i, /offsite|wheelchair|rv, bus|truck|van parking/i],
    ["pets", /^pets? allowed|pet[- ]friendly|pets are allowed/i, /not allowed/i],
    ["gym", /fitness|\bgym\b/i, /nearby|wheelchair|locker|classes/i],
    ["spa", /full-service spa|^spa\b|spa services|spa treatment|wellness centre|wellness center/i, /nearby|tub|wheelchair/i],
    ["wifi", /wi-?fi|wireless internet/i, /paid|surcharge|fee/i],
    ["shuttle", /airport (shuttle|transportation|transfer)/i, /$^/],
    ["restaurant", /^restaurant/i, /$^/],
    ["ac", /^air conditioning/i, /$^/],
    ["accessible", /wheelchair|accessib/i, /$^/],
    ["beach", /private beach|beachfront|on the beach|direct access to (the )?beach|beach access/i, /$^/],
    ["ev", /electric vehicle|ev charg/i, /$^/],
    ["bar", /^bar$/i, /$^/],
    ["roomservice", /^room service/i, /$^/],
    ["family", /^family rooms/i, /$^/],
    ["nonsmoking", /^non-smoking/i, /$^/],
    ["heating", /^heating/i, /$^/],
    ["coffee", /^coffee\/tea maker/i, /$^/],
    ["laundry", /^laundry$|coin laundry|laundry facilities|dry cleaning/i, /guidelines/i],
    ["frontdesk", /^24-hour front desk/i, /$^/],
    ["elevator", /^elevator$/i, /$^/],
    ["hottub", /hot tub|jacuzzi/i, /$^/],
    ["sauna", /^sauna/i, /$^/],
    ["terrace", /^(sun |rooftop )?terrace|^garden$/i, /$^/],
    ["kids", /children's (club|playground|games)|kids' (club|outdoor)/i, /$^/],
    ["business", /business center/i, /$^/],
  ];

  let facilityMap = null, facilityAt = 0; // facility id → amenity key
  async function loadFacilityMap() {
    if (facilityMap && Date.now() - facilityAt < 7 * 24 * 3600 * 1000) return facilityMap;
    const r = await lite("/data/facilities", { timeoutMs: 15000 }).catch(() => null);
    if (!r?.ok) return facilityMap || new Map();
    const m = new Map();
    for (const f of r.json.data || []) {
      const name = String(f.facility || "");
      const rule = !/^no\b/i.test(name) && AMENITY_RULES.find(([, inc, exc]) => inc.test(name) && !exc.test(name));
      if (rule) m.set(f.facility_id, rule[0]);
    }
    facilityMap = m; facilityAt = Date.now();
    return m;
  }
  loadFacilityMap();

  // LiteAPI hotelTypeId → the handful of property types people filter by
  const HOTEL_TYPES = { 204: "Hotel", 231: "Hotel", 225: "Hotel", 226: "Hotel", 201: "Apartment", 219: "Aparthotel", 207: "Apartment", 229: "Apartment",
    203: "Hostel", 264: "Hostel", 205: "Motel", 206: "Resort", 233: "Resort", 208: "Bed & breakfast", 216: "Guest house", 222: "Guest house", 247: "Guest house", 262: "Guest house",
    218: "Inn", 213: "Villa", 220: "Holiday home", 250: "Holiday home", 230: "Holiday home", 228: "Holiday home", 257: "Holiday home", 221: "Lodge", 227: "Riad", 209: "Ryokan" };

  const mealPlan = (b) => { b = String(b || "");
    return /all.?inclusive/i.test(b) ? "all" : /full board/i.test(b) ? "full" : /half board/i.test(b) ? "half" : /breakfast|^BB$/i.test(b) ? "breakfast" : "room"; };

  // ─── Hotel brand (chain) names, amenities and location, cached per hotel for a day ───
  const brandCache = new Map(); // id → { brand, amen, lat, lng, at }
  async function attachBrands(hotels) {
    const now = Date.now(), DAY = 24 * 3600 * 1000;
    const missing = hotels.map(h => h.id).filter(id => { const c = brandCache.get(id); return !c || now - c.at > DAY; });
    const chunks = [];
    for (let i = 0; i < missing.length; i += 100) chunks.push(missing.slice(i, i + 100));
    const work = Promise.all(chunks.map(async ids => {
      const r = await lite(`/data/hotels?hotelIds=${ids.join(",")}&limit=${ids.length}`, { timeoutMs: 8000 });
      const fmap = await loadFacilityMap();
      for (const h of r.json?.data || []) {
        const brand = h.chain && !/^not available$/i.test(h.chain) ? String(h.chain).trim() : null;
        const amen = [...new Set((h.facilityIds || []).map(id => fmap.get(id)).filter(Boolean))];
        brandCache.set(h.id, { brand, amen, type: HOTEL_TYPES[h.hotelTypeId] || null, zip: h.zip || null, lat: h.latitude, lng: h.longitude, at: now });
      }
      ids.forEach(id => { if (!brandCache.has(id)) brandCache.set(id, { brand: null, at: now }); });
    })).catch(() => {});
    // Don't hold the results up for brands: wait at most 2.5 s (they're cached for the next search).
    await Promise.race([work, new Promise(r => setTimeout(r, 2500))]);
    if (brandCache.size > 50000) brandCache.clear();
    hotels.forEach(h => { const c = brandCache.get(h.id); if (c?.brand) h.brand = c.brand; if (c?.amen?.length) h.amen = c.amen; if (c?.type) h.ptype = c.type; });
  }

  // Location of one hotel (from the same cache as brands; fetched once if we haven't seen it).
  async function hotelMeta(id) {
    let c = brandCache.get(id);
    if (!c) { await attachBrands([{ id }]); c = brandCache.get(id); }
    return c || null;
  }

  // ─── Search intents (signed-in members) for "Still thinking about…?" reminders ───
  if (db) db.exec(`CREATE TABLE IF NOT EXISTS search_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, place_id TEXT, dest TEXT, dest_detail TEXT,
    checkin TEXT, checkout TEXT, adults INTEGER, rooms INTEGER, currency TEXT, low_night REAL,
    hotel_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, reminded_at DATETIME,
    UNIQUE(user_id, place_id, checkin, checkout))`);
  const userIdOf = (req) => { try { return jwt.verify(req.cookies?.token || "", JWT_SECRET).id || null; } catch { return null; } };
  function recordIntent(req, b, fields) {
    const uid = userIdOf(req);
    if (!db || !uid || !b.placeId || !/^\d{4}-\d{2}-\d{2}$/.test(b.checkin || "") || !/^\d{4}-\d{2}-\d{2}$/.test(b.checkout || "")) return;
    try {
      db.prepare(`INSERT INTO search_intents (user_id, place_id, dest, dest_detail, checkin, checkout, adults, rooms, currency, low_night, hotel_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, place_id, checkin, checkout) DO UPDATE SET updated_at = CURRENT_TIMESTAMP,
          dest = COALESCE(excluded.dest, dest), dest_detail = COALESCE(excluded.dest_detail, dest_detail),
          low_night = COALESCE(excluded.low_night, low_night), hotel_id = COALESCE(excluded.hotel_id, hotel_id)`)
        .run(uid, b.placeId, fields.dest || null, fields.destDetail || null, b.checkin, b.checkout, +b.adults || 2, +b.rooms || 1, b.currency || "USD", fields.lowNight ?? null, fields.hotelId || null);
    } catch (e) { console.warn("Intent:", e.message); }
  }

  // ─── Hotel + flight packages ───
  // Booking a flight sets a signed `pkg` cookie (30 days). Hotels near the arrival airport, for the trip
  // dates, are then sold at the member (package) price. Hotels allow lower rates inside a package, and
  // the price is never shown to anyone without a flight booking.
  const DAY = 86400000;
  const kmBetween = (a1, o1, a2, o2) => { const R = 6371, r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r; const x = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  function pkgFrom(req) {
    try { const t = jwt.verify(req.cookies?.pkg || "", JWT_SECRET); return t.p === "pkg" ? t : null; } catch { return null; }
  }
  function pkgApplies(pkg, lat, lng, checkin, checkout) {
    if (!pkg || !(lat != null && lng != null) || !checkin || !checkout) return false;
    if (kmBetween(pkg.lat, pkg.lng, +lat, +lng) > 80) return false;
    const ci = Date.parse(checkin), co = Date.parse(checkout), a = Date.parse(pkg.from);
    if (!(ci >= a - DAY) || !(co > ci)) return false;
    if (pkg.to) { const d = Date.parse(pkg.to); return ci <= d - DAY && co <= d + DAY; }
    return ci <= a + 3 * DAY && co - ci <= 14 * DAY;
  }
  /** Called after a confirmed flight booking: returns { token, info } or null. */
  async function issuePackage(segments) {
    try {
      const segs = Array.isArray(segments) ? segments : JSON.parse(segments || "[]");
      const out = segs.filter(x => (x.direction || "OUTBOUND") !== "INBOUND"), inb = segs.filter(x => x.direction === "INBOUND");
      const last = out[out.length - 1];
      if (!last?.destinationCode) return null;
      const ap = (await loadIata()).find(a => a.code === last.destinationCode);
      if (!ap || ap.latitude == null) return null;
      const from = String(last.arrivalTime || last.departureTime || "").slice(0, 10);
      const to = inb[0] ? String(inb[0].departureTime || "").slice(0, 10) : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
      const city = MAJOR_AIRPORTS[ap.code] || String(ap.name || "").replace(/\s*(International\s+)?Airport.*$/i, "");
      let placeId = null;
      try { const r = await lite(`/data/places?textQuery=${encodeURIComponent(city)}`, { timeoutMs: 8000 }); placeId = (r.json?.data || []).find(p => (p.types || []).includes("locality"))?.placeId || r.json?.data?.[0]?.placeId || null; } catch {}
      const token = jwt.sign({ p: "pkg", code: ap.code, lat: ap.latitude, lng: ap.longitude, from, to }, JWT_SECRET, { expiresIn: "30d" });
      const checkout = to || new Date(Date.parse(from) + 3 * DAY).toISOString().slice(0, 10);
      return { token, info: { city, airport: ap.code, placeId, checkin: from, checkout } };
    } catch { return null; }
  }

  // ─── Destination autocomplete ───
  app.get("/api/places", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, data: [] });
    try {
      const r = await cached("places:" + q.toLowerCase(), 24 * 60 * MIN, () => lite(`/data/places?textQuery=${encodeURIComponent(q)}`, { timeoutMs: 10000 }));
      if (!r.ok) return res.status(502).json({ error: errMessage(r, "Destination search failed") });
      const geoTypes = ["locality", "political", "administrative_area_level_1", "country", "neighborhood", "sublocality", "airport", "lodging", "point_of_interest", "tourist_attraction"];
      const data = (r.json.data || [])
        .filter(p => (p.types || []).some(t => geoTypes.includes(t)))
        .slice(0, 8)
        .map(p => ({
          placeId: p.placeId,
          name: p.displayName,
          detail: p.formattedAddress,
          kind: (p.types || []).includes("lodging") ? "hotel"
              : (p.types || []).includes("airport") ? "airport"
              : (p.types || []).some(t => ["point_of_interest", "tourist_attraction"].includes(t)) ? "landmark" : "city",
        }));
      res.json({ success: true, data });
    } catch (err) {
      console.error("Places error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ─── Airport autocomplete ───
  let iataCache = null;
  let iataLoading = null;
  async function loadIata() {
    if (iataCache) return iataCache;
    if (!iataLoading) {
      iataLoading = lite("/data/iataCodes", { timeoutMs: 30000 }).then(r => {
        iataLoading = null;
        if (!r.ok) throw new Error(errMessage(r, "IATA list failed"));
        iataCache = (r.json.data || []).filter(a => a.code && a.name && !/metropolitan area/i.test(a.name));
        return iataCache;
      }).catch(e => { iataLoading = null; throw e; });
    }
    return iataLoading;
  }

  app.get("/api/airports", async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 2) return res.json({ success: true, data: [] });
    try {
      const all = await loadIata();
      const scored = [];
      for (const a of all) {
        const code = a.code.toLowerCase();
        const name = a.name.toLowerCase();
        const city = (MAJOR_AIRPORTS[a.code] || "").toLowerCase();
        let s = 0;
        if (code === q) s = 100;
        else if (city && city.startsWith(q)) s = 90;
        else if (city && city.includes(q)) s = 75;
        else if (name.startsWith(q)) s = 60;
        else if (name.split(/[\s\-/]+/).some(w => w.startsWith(q))) s = 45;
        else if (name.includes(q)) s = 25;
        if (!s) continue;
        if (MAJOR_AIRPORTS[a.code]) s += 20;
        scored.push({ s, a });
      }
      scored.sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name));
      res.json({
        success: true,
        data: scored.slice(0, 8).map(({ a }) => ({
          code: a.code,
          name: a.name,
          city: MAJOR_AIRPORTS[a.code] || a.name.replace(/\s*(International\s+)?Airport.*$/i, ""),
          countryCode: a.countryCode,
          lat: a.latitude, lng: a.longitude,
        })),
      });
    } catch (err) {
      console.error("Airports error:", err.message);
      res.status(502).json({ error: "Airport search is unavailable right now" });
    }
  });

  // ─── Hotel details (static content, cached 1h) ───
  // ─── Hotel page extras: AI highlights, reviews, Ask AI ───
  const langOf = (req) => (["fr", "es"].includes(req.cookies?.ps_lang) ? req.cookies.ps_lang : "en");
  const askHits = new Map();
  setInterval(() => askHits.clear(), 3600 * 1000).unref();

  // 3 "Smart highlight" cards. LiteAPI allows 10/min per key, so results are cached for a week.
  app.get(/^\/api\/hotels\/(lp[0-9a-z]+)\/highlights$/i, async (req, res) => {
    const id = req.params[0], language = langOf(req);
    try {
      const r = await cached(`hl:${id}:${language}`, 7 * 24 * 60 * MIN, () => lite("/data/hotel/highlights", { method: "POST", body: { hotelId: id, language, count: 3 }, timeoutMs: 20000 }));
      const d = r.json?.data;
      if (!r.ok || !d?.generated) return res.json({ success: true, data: [] }); // hide template fallbacks
      res.json({ success: true, data: (d.highlights || []).slice(0, 3).map(h => ({ title: h.title, description: h.description })) });
    } catch { res.json({ success: true, data: [] }); }
  });

  // Reviews: first 200 fetched once (6 h) for "Who stays here", sorting and paging.
  app.get(/^\/api\/hotels\/(lp[0-9a-z]+)\/reviews$/i, async (req, res) => {
    const id = req.params[0];
    try {
      const r = await cached(`rev:${id}`, 6 * 60 * MIN, () => lite(`/data/reviews?hotelId=${encodeURIComponent(id)}&limit=200&getSentiment=true&timeout=15`, { timeoutMs: 25000 }));
      if (!r.ok) return res.json({ success: true, data: { total: 0, reviews: [], categories: [], types: [] } });
      const all = (r.json.data || []).map(v => ({
        name: String(v.name || "Guest").split(" ")[0].slice(0, 30), type: v.type || "", country: v.country || "",
        date: v.date, score: v.averageScore, headline: v.headline || "", pros: v.pros || "", cons: v.cons || "", language: v.language || "",
      })).filter(v => v.headline || v.pros || v.cons);
      const sort = String(req.query.sort || "newest");
      const sorted = [...all].sort(sort === "highest" ? (a, b) => b.score - a.score : sort === "lowest" ? (a, b) => a.score - b.score : (a, b) => String(b.date).localeCompare(String(a.date)));
      const offset = Math.max(0, +req.query.offset || 0), limit = Math.min(20, Math.max(1, +req.query.limit || 4));
      const group = (t) => /couple/i.test(t) ? "couple" : /family/i.test(t) ? "family" : /solo/i.test(t) ? "solo" : /business/i.test(t) ? "business" : /group|friend/i.test(t) ? "group" : "other";
      const counts = {};
      for (const v of r.json.data || []) { const g = group(v.type || ""); counts[g] = (counts[g] || 0) + 1; }
      const n = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
      res.json({ success: true, data: {
        total: r.json.total || all.length, withText: all.length,
        categories: (r.json.sentimentAnalysis?.categories || []).map(c => ({ name: c.name, rating: c.rating })),
        pros: r.json.sentimentAnalysis?.pros || [], cons: r.json.sentimentAnalysis?.cons || [],
        types: Object.entries(counts).map(([k, c]) => ({ type: k, pct: Math.round(100 * c / n) })).sort((a, b) => b.pct - a.pct),
        reviews: sorted.slice(offset, offset + limit), offset, limit,
      } });
    } catch { res.json({ success: true, data: { total: 0, reviews: [], categories: [], types: [] } }); }
  });

  // Ask AI about one hotel (LiteAPI's grounded Q&A). 20 questions per visitor per hour.
  app.get(/^\/api\/hotels\/(lp[0-9a-z]+)\/ask$/i, async (req, res) => {
    const id = req.params[0], q = String(req.query.q || "").trim().slice(0, 300);
    if (q.length < 3) return res.status(400).json({ error: "Ask a question about this hotel" });
    const ip = req.ip || ""; const n = (askHits.get(ip) || 0) + 1; askHits.set(ip, n);
    if (n > 20) return res.status(429).json({ error: "You've asked a lot of questions. Please try again later." });
    try {
      const lang = langOf(req);
      const question = lang === "en" ? q : `${q} (answer in ${lang === "fr" ? "French" : "Spanish"})`;
      const r = await cached(`ask:${id}:${lang}:${q.toLowerCase()}`, 24 * 60 * MIN, () => lite(`/data/hotel/ask?hotelId=${encodeURIComponent(id)}&query=${encodeURIComponent(question)}`, { timeoutMs: 25000 }));
      if (!r.ok || !r.json?.data?.answer) return res.status(502).json({ error: "The assistant couldn't answer right now. Please try again." });
      res.json({ success: true, data: { answer: r.json.data.answer } });
    } catch { res.status(502).json({ error: "The assistant couldn't answer right now. Please try again." }); }
  });

  app.get(/^\/api\/hotels\/(lp[0-9a-z]+)$/i, async (req, res, next) => {
    const id = req.params[0];
    try {
      const lang = ["fr", "es"].includes(req.cookies?.ps_lang) ? req.cookies.ps_lang : null; // hotel descriptions/amenities in the visitor's language
      const r = await cached("hotel:" + id + (lang || ""), 60 * MIN, () => lite(`/data/hotel?hotelId=${encodeURIComponent(id)}&timeout=4${lang ? "&language=" + lang : ""}`, { timeoutMs: 15000 }));
      if (!r.ok || !r.json?.data) return next(); // fall back to the legacy route
      res.set("Cache-Control", "public, max-age=600");
      res.json(r.json.data);
    } catch { next(); }
  });

  // ─── Hotel search (place or hotel ids) ───
  app.post("/api/stays/search", async (req, res) => {
    const b = req.body || {};
    const hasGeo = Number.isFinite(+b.latitude) && Number.isFinite(+b.longitude) && b.latitude !== "" && b.longitude !== "";
    if (!b.placeId && !hasGeo && !(Array.isArray(b.hotelIds) && b.hotelIds.length)) {
      return res.status(400).json({ error: "Choose a destination" });
    }
    if (!b.checkin || !b.checkout) return res.status(400).json({ error: "Choose your dates" });
    try {
      const searchBody = {
          // Map area search ("search as I move the map") takes priority over placeId
          ...(hasGeo
            ? { latitude: +(+b.latitude).toFixed(4), longitude: +(+b.longitude).toFixed(4), radius: Math.round(Math.min(Math.max(+b.radius || 5000, 500), 50000) / 100) * 100 }
            : b.placeId ? { placeId: b.placeId } : { hotelIds: b.hotelIds }),
          checkin: b.checkin,
          checkout: b.checkout,
          occupancies: occupancies(b),
          currency: b.currency || "USD",
          guestNationality: b.guestNationality || "US",
          margin: 0, // net + hotel SSP; the visitor's price is computed below (pricing.priceFor)
          maxRatesPerHotel: 5, // enough to know which hotels offer free cancellation / meals, not just the cheapest rate
          includeHotelData: true,
          limit: Math.min(parseInt(b.limit) || 100, 200),
          timeout: 12,
      };
      const r = await cached("stays:" + JSON.stringify(searchBody), 5 * MIN, () => lite("/hotels/rates", { method: "POST", body: searchBody }));
      if (!r.ok) {
        if (r.status === 404 || r.json?.error?.code === 2001) return res.json({ success: true, data: [] });
        return res.status(502).json({ error: errMessage(r, "Hotel search failed") });
      }
      const hotelsById = new Map((r.json.hotels || []).map(h => [h.id, h]));
      const nights = Math.max(1, Math.round((new Date(b.checkout) - new Date(b.checkin)) / 86400000));
      const data = (r.json.data || []).map(entry => {
        const h = hotelsById.get(entry.hotelId) || {};
        // Cheapest offer across room types
        let best = null;
        const meals = new Set(); let refundAny = false;
        for (const rt of entry.roomTypes || []) {
          const total = rt.offerRetailRate?.amount;
          if (total == null) continue;
          for (const rate of rt.rates || []) { meals.add(mealPlan(rate.boardName || rate.boardType)); if (rate.cancellationPolicies?.refundableTag === "RFN") refundAny = true; }
          if (!best || total < best.total) {
            const rate = rt.rates?.[0] || {};
            best = {
              offerId: rt.offerId,
              total,
              currency: rt.offerRetailRate.currency,
              ssp: rt.suggestedSellingPrice?.amount || null,
              roomName: rate.name,
              board: rate.boardName,
              refundable: rate.cancellationPolicies?.refundableTag === "RFN",
              taxesExcluded: (rate.retailRate?.taxesAndFees || []).filter(t => !t.included).reduce((s, t) => s + (t.amount || 0), 0),
            };
          }
        }
        if (!best) return null;
        return {
          id: entry.hotelId,
          name: h.name,
          photo: h.main_photo,
          thumb: h.thumbnail,
          address: h.address,
          city: h.city_name,
          country: h.country_code,
          lat: h.latitude,
          lng: h.longitude,
          stars: h.stars || 0,
          rating: h.rating || 0,
          reviews: h.review_count || 0,
          nights,
          ...best,
          meals: [...meals], refundAny,
          perNight: best.total / nights,
        };
      }).filter(Boolean);
      await attachBrands(data);
      const member = isMember(req), pkg = !member && pkgFrom(req), extra = member ? paidExtra(req) : 0;
      data.forEach(h => {
        const pk = !!pkg && pkgApplies(pkg, h.lat, h.lng, b.checkin, b.checkout);
        const p = pricing.priceFor(h.total, h.ssp, member || pk, extra);
        h.total = p.total; h.publicTotal = p.publicTotal; h.perNight = p.total / h.nights;
        applyParity(h, member || pk);
        if (pk) h.packagePrice = true;
      });
      if (member && !b.latitude && data.length) recordIntent(req, b, { dest: String(b.dest || "").slice(0, 120), destDetail: String(b.destDetail || "").slice(0, 160), lowNight: Math.min(...data.map(h => h.perNight)) });
      res.json({ success: true, data, pricing: { member, package: data.some(h => h.packagePrice), memberFactor: pricing.memberFactor() } });
    } catch (err) {
      console.error("Stays search error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ─── Weather forecast for a location and date range (LiteAPI /data/weather) ───
  app.get("/api/extras/weather", async (req, res) => {
    const lat = +req.query.lat, lng = +req.query.lng;
    const start = String(req.query.start || ""), end = String(req.query.end || start);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "lat, lng, start and end (YYYY-MM-DD) are required" });
    }
    try {
      const path = `/data/weather?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&startDate=${start}&endDate=${end}&units=metric`;
      const r = await cached("weather:" + path, 3 * 60 * MIN, () => lite(path, { timeoutMs: 12000 }));
      if (!r.ok) return res.status(502).json({ error: errMessage(r, "Weather unavailable") });
      const days = (r.json.weatherData || []).map(w => w.dailyWeather || {}).filter(d => d.date).map(d => ({
        date: d.date,
        min: d.temperature?.min, max: d.temperature?.max,
        rainMm: d.precipitation?.total ?? 0,
        cloud: d.cloud_cover?.afternoon ?? null,
        wind: d.wind?.max?.speed ?? null,
      })).slice(0, 16);
      res.json({ success: true, data: days });
    } catch (err) {
      console.error("Weather error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ─── Add-ons offered at checkout ───
  // Uber ride credit: charged on top of the booking via LiteAPI prebook `addons` (verified on sandbox).
  app.get("/api/extras/uber", (req, res) => {
    res.json({ success: true, data: [10, 20, 30, 50, 75, 100].map(v => ({ value: v, currency: "USD" })) });
  });

  // eSIM data plans for a country. Requires eSIMply access on the LiteAPI account; when it isn't
  // enabled we answer { enabled: false } so the site simply hides the eSIM option.
  app.get("/api/extras/esim", async (req, res) => {
    const cc = String(req.query.country || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return res.status(400).json({ error: "2-letter country code required" });
    try {
      // eSimply add-on (Nuitee Connect): country packages, USD only, non-refundable
      const r = await cached("esim:" + cc, 60 * MIN, () => lite(`/addons/esimply/packages/${cc}`, { timeoutMs: 12000 }));
      if (r.status === 403 || r.json?.error?.code === 40301) return res.json({ success: true, enabled: false, data: [] });
      if (!r.ok) return res.json({ success: true, enabled: false, data: [], note: errMessage(r, "eSIM unavailable") });
      // Tolerant mapping: destinations may nest packages or be packages themselves.
      const raw = r.json.data || [];
      const list = raw.flatMap(d => Array.isArray(d.packages) ? d.packages.map(p => ({ ...p, _dest: d })) : [d]);
      const data = list.map(p => {
        const mb = p.data_size_mb ?? p.dataSizeMb ?? (p.data_gb != null ? p.data_gb * 1024 : p.dataGb != null ? p.dataGb * 1024 : null);
        return {
          packageId: p.package_id ?? p.packageId ?? p.id,
          destinationCode: p.destination_code ?? p.destinationCode ?? p._dest?.destination_code ?? p._dest?.code ?? cc,
          name: p.name || p.title || "",
          dataGb: mb != null ? Math.round((mb / 1024) * 10) / 10 : null,
          unlimited: !!(p.unlimited || /unlimited/i.test(p.name || "")),
          days: p.validity_days ?? p.validityDays ?? p.duration_days ?? null,
          price: p.calculated_price ?? p.price ?? p.retail_price ?? p.retailPrice ?? null,
          currency: p.currency || "USD",
        };
      }).filter(p => p.packageId != null && p.price != null).sort((a, b) => a.price - b.price);
      res.json({ success: true, enabled: data.length > 0, data: data.slice(0, 12) });
    } catch (err) {
      console.error("eSIM packages error:", err.message);
      res.json({ success: true, enabled: false, data: [] });
    }
  });

  // ─── Signed-in user's hotel + flight bookings, newest first ───
  app.get("/api/trips", (req, res) => {
    let user;
    try { user = jwt.verify(req.cookies?.token || "", JWT_SECRET); } catch { return res.status(401).json({ error: "Not logged in" }); }
    try {
      const hotels = db.prepare(`
        SELECT MIN(id) AS id, liteapi_booking_id AS bookingId, status, hotel_name AS name, checkin, checkout, price, currency, guest_name AS guest, created_at AS createdAt
        FROM bookings WHERE user_id = ? GROUP BY COALESCE(liteapi_booking_id, id) ORDER BY created_at DESC`).all(user.id)
        .map(b => ({ type: "hotel", ...b }));
      let flights = [];
      try {
        flights = db.prepare(`
          SELECT id, booking_id AS bookingId, liteapi_booking_ref AS pnr, status, currency, total_amount AS price, segments_json, created_at AS createdAt
          FROM flight_bookings WHERE user_id = ? ORDER BY created_at DESC`).all(user.id)
          .map(f => {
            let segs = [];
            try { segs = JSON.parse(f.segments_json || "[]"); } catch {}
            const first = segs[0] || {}, last = segs[segs.length - 1] || {};
            delete f.segments_json;
            return { type: "flight", ...f, name: first.originCode && last.destinationCode ? `${first.originCode} → ${last.destinationCode}` : "Flight", checkin: (first.departureTime || "").slice(0, 10) };
          });
      } catch { /* flight table may not exist yet */ }
      res.json({ success: true, data: [...hotels, ...flights].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
    } catch (err) {
      console.error("Trips error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ─── Guest booking lookup: booking ID + the email used at checkout ───
  app.get("/api/trips/lookup", (req, res) => {
    const bookingId = String(req.query.bookingId || "").trim();
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!bookingId || !email) return res.status(400).json({ error: "Enter your booking ID and email" });
    const b = db.prepare(`
      SELECT liteapi_booking_id AS bookingId, status, hotel_name AS name, checkin, checkout, price, currency, guest_name AS guest
      FROM bookings WHERE liteapi_booking_id = ? AND lower(guest_email) = ? LIMIT 1`).get(bookingId, email);
    if (!b) return res.status(404).json({ error: "We couldn't find a booking with that ID and email" });
    res.json({ success: true, data: { type: "hotel", ...b } });
  });

  // ─── Attach a guest booking to the signed-in account ───
  // Proof of ownership: the prebookId (only known to the browser that paid) or
  // booking ID + the email used at checkout.
  app.post("/api/trips/claim", (req, res) => {
    let user;
    try { user = jwt.verify(req.cookies?.token || "", JWT_SECRET); } catch { return res.status(401).json({ error: "Sign in to save this trip" }); }
    const { bookingId, email, prebookId } = req.body || {};
    let changed = 0;
    if (prebookId) {
      changed += db.prepare("UPDATE bookings SET user_id = ? WHERE prebook_id = ? AND user_id IS NULL").run(user.id, prebookId).changes;
      try { changed += db.prepare("UPDATE flight_bookings SET user_id = ? WHERE prebook_id = ? AND user_id IS NULL").run(user.id, prebookId).changes; } catch {}
    }
    if (!changed && bookingId && email) {
      changed += db.prepare("UPDATE bookings SET user_id = ? WHERE liteapi_booking_id = ? AND lower(guest_email) = lower(?) AND user_id IS NULL")
        .run(user.id, String(bookingId).trim(), String(email).trim()).changes;
    }
    const owned = prebookId
      ? db.prepare("SELECT 1 FROM bookings WHERE prebook_id = ? AND user_id = ?").get(prebookId, user.id)
      : bookingId ? db.prepare("SELECT 1 FROM bookings WHERE liteapi_booking_id = ? AND user_id = ?").get(String(bookingId).trim(), user.id) : null;
    if (!changed && !owned) return res.status(404).json({ error: "We couldn't match that booking. Check the booking ID and email." });
    res.json({ success: true, claimed: changed });
  });

  // ─── Flight search, trimmed for the browser ───
  // The raw LiteAPI response can be several MB (hundreds of journeys × fare
  // families with per-segment amenities). Keep only what the results page uses.
  app.post("/api/flights/offers", async (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.legs) || !b.legs.length) return res.status(400).json({ error: "Choose your route and dates" });
    try {
      const flightEngine = require("../flight-engine");
      const fq = { legs: b.legs.map(l => ({ origin: l.origin, destination: l.destination, date: l.date })), adults: b.adults || 1, currency: b.currency || "USD", country: b.country || "US" };
      // Offers stay bookable well beyond 10 minutes; prebook re-checks the price anyway.
      const result = await cached("flights:" + JSON.stringify(fq), 10 * MIN, () => flightEngine.searchFlights(fq));
      if (!result.success) {
        const e = result.error || {};
        return res.status(e.code === 408 ? 504 : 502).json({ error: e.message || "Flight search failed", code: e.code });
      }
      const block = result.data?.data?.[0] || {};
      const slimOffer = (o, withAmenities) => o && ({
        offerId: o.offerId,
        expiration: o.expiration,
        pricing: { display: { total: o.pricing?.display?.total, currency: o.pricing?.display?.currency, perPassenger: { adult: { total: o.pricing?.display?.perPassenger?.adult?.total } } } },
        baggage: o.baggage,
        fare: o.fare,
        terms: o.terms,
        segmentFares: (o.segmentFares || []).map(f => ({ segmentKey: f.segmentKey, cabin: f.cabin, fareFamily: f.fareFamily })),
        ...(withAmenities ? { segmentAmenities: (o.segmentAmenities || []).map(a => ({
          segmentKey: a.segmentKey, aircraftType: a.aircraftType,
          amenities: (a.amenities || []).filter(x => x.available).map(x => ({ category: x.category, name: x.name, chargeable: !!x.chargeable, details: x.details })),
        })) } : {}),
      });
      const journeys = (block.journeys || []).slice(0, 250).map(j => ({
        journeyKey: j.journeyKey,
        isCheapest: j.isCheapest,
        legDurations: j.legDurations,
        totalDuration: j.totalDuration,
        connections: (j.connections || []).map(c => ({
          direction: c.direction, duration: c.duration, overnight: !!c.overnight, changeAirport: !!c.changeAirport,
          arrivalAirportCode: c.arrivalAirportCode, arrivalAirportName: c.arrivalAirportName, arrivalTime: c.arrivalTime,
          departureAirportCode: c.departureAirportCode, departureAirportName: c.departureAirportName, departureTime: c.departureTime,
        })),
        segments: (j.segments || []).map(s => ({
          direction: s.direction, departureTime: s.departureTime, arrivalTime: s.arrivalTime,
          originCode: s.originCode, destinationCode: s.destinationCode, originName: s.originName, destinationName: s.destinationName,
          duration: s.duration, flight: s.flight, segmentKey: s.segmentKey,
          carrier: { marketingCode: s.carrier?.marketingCode, marketingName: s.carrier?.marketingName, marketingLogo: s.carrier?.marketingLogo, operatingCode: s.carrier?.operatingCode, operatingName: s.carrier?.operatingName },
        })),
        cheapestOffer: slimOffer(j.cheapestOffer, true),
        offers: (j.offers || []).map(o => slimOffer(o, false)),
      }));
      res.json({ success: true, data: { journeys, sortMetadata: block.sortMetadata || {} } });
    } catch (err) {
      console.error("Flight offers error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  });

  function feesFromText(text) {
    const out = [];
    const re = /(\d+(?:\.\d+)?)\s*(USD|EUR|CAD|GBP|AUD|AED|MXN)?\s*(RSRT|RESORT|FACILITY|DESTINATION|URBAN|AMENITY)\s*(CHG|CHARGE|FEE)/gi;
    let m;
    while ((m = re.exec(text || ""))) out.push({ description: `${m[3].toUpperCase() === "RSRT" ? "Resort" : m[3][0].toUpperCase() + m[3].slice(1).toLowerCase()} charge mentioned by the hotel`, amount: +m[1], currency: (m[2] || "USD").toUpperCase(), unit: "listed by the hotel, may be per night" });
    return out;
  }

  // Merge fee lines with the same name/currency and give them a readable label.
  function mergeFees(list) {
    const out = new Map();
    for (const t of list) {
      if (!(t.amount > 0)) continue;
      const raw = String(t.description || "").trim();
      const label = !raw || /^\$?[\d.,]+\s*[a-z]{3}\b/i.test(raw) || /^usd per/i.test(raw) ? "Local taxes and fees"
        : raw.replace(/\s+/g, " ").replace(/\s*\b(per|\/)\s*(night|nights|stay|room|person|day)\b.*$/i, "").trim().replace(/^./, c => c.toUpperCase()) || "Local taxes and fees";
      const key = label.toLowerCase() + "|" + (t.currency || "");
      const cur = out.get(key) || { description: label, amount: 0, currency: t.currency || "USD" };
      cur.amount = Math.round((cur.amount + t.amount) * 100) / 100;
      out.set(key, cur);
    }
    return [...out.values()];
  }

  // ─── All rooms & rates for one hotel ───
  // ─── Flexible dates: lowest nightly price for the same stay length shifted −3…+3 days ───
  // Uses the same (≤40) hotels as the visitor's results so every date compares like with like.
  app.post("/api/stays/flex", async (req, res) => {
    const b = req.body || {};
    const ids = (Array.isArray(b.hotelIds) ? b.hotelIds : []).filter(id => /^lp[0-9a-z]+$/i.test(id)).slice(0, 40);
    if (!ids.length || !/^\d{4}-\d{2}-\d{2}$/.test(b.checkin || "") || !/^\d{4}-\d{2}-\d{2}$/.test(b.checkout || "")) return res.status(400).json({ error: "hotelIds, checkin and checkout are required" });
    const day = 86400000, ci = Date.parse(b.checkin + "T00:00:00Z"), co = Date.parse(b.checkout + "T00:00:00Z");
    const nights = Math.round((co - ci) / day);
    if (!(nights >= 1 && nights <= 30)) return res.status(400).json({ error: "Invalid dates" });
    const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const member = isMember(req), extra = member ? paidExtra(req) : 0;
    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    const offsets = [-3, -2, -1, 0, 1, 2, 3].filter(o => ci + o * day >= today);
    try {
      // At most 2 date searches at a time (LiteAPI rate limit)
      const limit2 = (fns) => new Promise((resolve) => { const out = []; let i = 0, done = 0; const next = () => { if (i >= fns.length) return; const k = i++; fns[k]().then(v => { out[k] = v; }, () => { out[k] = null; }).finally(() => { if (++done === fns.length) resolve(out); else next(); }); }; if (!fns.length) resolve(out); next(); next(); });
      const rows = (await limit2(offsets.map((o) => async () => {
        const body = { hotelIds: [...ids].sort(), checkin: iso(ci + o * day), checkout: iso(co + o * day), occupancies: occupancies(b), currency: b.currency || "USD", guestNationality: "US", margin: 0, maxRatesPerHotel: 1, timeout: 10 };
        const r = await cached("flex:" + JSON.stringify(body), 3 * 60 * MIN, () => lite("/hotels/rates", { method: "POST", body }));
        let low = null, n = 0;
        for (const e of r.ok ? r.json.data || [] : []) {
          let best = null;
          for (const rt of e.roomTypes || []) { const net = rt.offerRetailRate?.amount; if (net != null && (!best || net < best.net)) best = { net, ssp: rt.suggestedSellingPrice?.amount }; }
          if (!best) continue;
          n++;
          const t = pricing.priceFor(best.net, best.ssp, member, extra).total / nights;
          if (low == null || t < low) low = t;
        }
        return { offset: o, checkin: body.checkin, checkout: body.checkout, lowNight: low != null ? Math.round(low * 100) / 100 : null, hotels: n };
      }))).filter(Boolean);
      res.json({ success: true, nights, data: rows });
    } catch (err) {
      console.error("Flex dates error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/stays/rooms", async (req, res) => {
    const b = req.body || {};
    if (!b.hotelId || !b.checkin || !b.checkout) return res.status(400).json({ error: "hotelId, checkin and checkout are required" });
    try {
      const roomsBody = {
          hotelIds: [b.hotelId],
          checkin: b.checkin,
          checkout: b.checkout,
          occupancies: occupancies(b),
          currency: b.currency || "USD",
          guestNationality: b.guestNationality || "US",
          margin: 0,
          timeout: 12,
      };
      const fetchAt = (margin) => {
        const body = { ...roomsBody, margin };
        return cached("rooms:" + JSON.stringify(body), 3 * MIN, () => lite("/hotels/rates", { method: "POST", body }));
      };
      // 1) Net rates + the hotel's own price (SSP at margin 0) for every offer.
      // roomMapping drops unmapped rooms (sometimes all of them), so rates are loaded without it; a separate
      // mapped call only lends mappedRoomId (for room photos) to rooms it can match by name.
      const mappedP = cached("roomsmap:" + JSON.stringify(roomsBody), 3 * MIN, () => lite("/hotels/rates", { method: "POST", body: { ...roomsBody, roomMapping: true } })).catch(() => null);
      const r = await fetchAt(0);
      if (!r.ok) {
        if (r.status === 404 || r.json?.error?.code === 2001) return res.json({ success: true, data: [] });
        return res.status(502).json({ error: errMessage(r, "Could not load rooms") });
      }
      // Offer IDs change with the margin; the room type + rate name/board/refundability (+ occurrence) don't.
      const keysOf = (roomTypes) => {
        const seen = new Map();
        return (roomTypes || []).map(rt => {
          const rate = rt.rates?.[0] || {};
          const k = [rt.roomTypeId, rate.name, rate.boardType, rate.cancellationPolicies?.refundableTag, (rt.rates || []).length].join("|");
          const n = (seen.get(k) || 0) + 1; seen.set(k, n);
          return k + "#" + n;
        });
      };
      const isMem = isMember(req), pkg = !isMem && pkgFrom(req);
      let pk = false;
      if (pkg) { const meta = await hotelMeta(b.hotelId); pk = pkgApplies(pkg, meta?.lat, meta?.lng, b.checkin, b.checkout); }
      const member = isMem || pk, extra = isMem ? paidExtra(req) : 0;
      const base = (r.json.data || [])[0]?.roomTypes || [];
      const baseKeys = keysOf(base);
      const plan = new Map(); // key → { margin, publicTotal }
      base.forEach((rt, i) => {
        const net = rt.offerRetailRate?.amount;
        if (net == null) return;
        const p = pricing.priceFor(net, rt.suggestedSellingPrice?.amount, member, extra);
        plan.set(baseKeys[i], { margin: p.margin, publicTotal: p.publicTotal });
      });
      // 2) One bookable request per distinct margin (usually 1-2); offers at a margin we didn't fetch are left out.
      const margins = [...new Set([...plan.values()].map(v => v.margin))].sort((x, y) => x - y).slice(0, 6);
      const results = await Promise.all(margins.map(m => fetchAt(m)));
      const chosen = [];
      margins.forEach((m, mi) => {
        const rts = results[mi].ok ? (results[mi].json.data || [])[0]?.roomTypes || [] : [];
        keysOf(rts).forEach((k, i) => { const pl = plan.get(k); if (pl && pl.margin === m) chosen.push({ rt: rts[i], publicTotal: pl.publicTotal }); });
      });
      const mapped = await mappedP;
      const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const mapIds = new Map();
      for (const rt of mapped?.ok ? (mapped.json.data || [])[0]?.roomTypes || [] : []) {
        const rate = rt.rates?.[0] || {}, id = rate.mappedRoomId || rt.mappedRoomId;
        if (id && !mapIds.has(norm(rate.name))) mapIds.set(norm(rate.name), id);
      }
      const offers = chosen.map(({ rt, publicTotal }) => {
        const rate = rt.rates?.[0] || {};
        const cp = rate.cancellationPolicies || {};
        return {
          offerId: rt.offerId,
          mappedRoomId: rate.mappedRoomId || rt.mappedRoomId || mapIds.get(norm(rate.name)) || null,
          name: rate.name || "Room",
          board: rate.boardName || rate.boardType,
          maxOccupancy: rate.maxOccupancy,
          total: rt.offerRetailRate?.amount,
          currency: rt.offerRetailRate?.currency || "USD",
          ssp: rt.suggestedSellingPrice?.amount || null,
          refundable: cp.refundableTag === "RFN",
          cancelBy: (cp.cancelPolicyInfos || []).map(c => c.cancelTime).sort()[0] || null,
          // Fees are itemized per rate (one rate per room in multi-room searches): merge them by name.
          taxesExcluded: mergeFees((rt.rates || []).flatMap(r => (r.retailRate?.taxesAndFees || []).filter(t => !t.included))),
          taxesIncluded: mergeFees((rt.rates || []).flatMap(r => (r.retailRate?.taxesAndFees || []).filter(t => t.included))),
          cancelPolicy: (cp.cancelPolicyInfos || []).map(c => ({ from: c.cancelTime, tz: c.timezone || "GMT", amount: c.amount, currency: c.currency, type: c.type })).sort((a, b2) => String(a.from).localeCompare(String(b2.from))),
          hotelRemarks: (cp.hotelRemarks || []).filter(Boolean),
          // Some suppliers only mention a charge inside the rate name (e.g. "28 USD RSRT CHG"); surface it so it's never a surprise.
          nameFees: feesFromText((rt.rates || []).map(r => r.name).join(" ")),
          remarks: rate.remarks || "",
          perks: (rate.perks || []).map(p => p.name || p).filter(Boolean),
          publicTotal,
        };
      }).filter(o => o.total != null).sort((a, b2) => a.total - b2.total);
      offers.forEach(o => { applyParity(o, member); if (pk) o.packagePrice = true; });
      if (isMem && b.placeId) recordIntent(req, b, { hotelId: b.hotelId, dest: b.dest ? String(b.dest).slice(0, 120) : null });
      res.json({ success: true, data: offers, pricing: { member: isMem, package: pk, memberFactor: pricing.memberFactor() } });
    } catch (err) {
      console.error("Stays rooms error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  });
  return { issuePackage };
}

module.exports = { registerStorefrontRoutes };
