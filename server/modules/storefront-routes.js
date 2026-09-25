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
  async function lite(path, { method = "GET", body, timeoutMs = 45000 } = {}) {
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
  // Public prices must not be below the hotel's SSP (rate parity). Members are a closed user group.
  const BELOW_SSP_TOLERANCE = 0.995;
  function applyParity(o, member) {
    const ssp = o.ssp;
    const below = ssp && o.total < ssp * BELOW_SSP_TOLERANCE;
    if (member) { o.memberPrice = true; o.strikeTotal = ssp && ssp > o.total ? ssp : null; }
    else { o.memberOnly = process.env.PARITY_GATE === "on" && !!below; o.strikeTotal = null; }
    delete o.ssp;
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
  app.get(/^\/api\/hotels\/(lp[0-9a-z]+)$/i, async (req, res, next) => {
    const id = req.params[0];
    try {
      const r = await cached("hotel:" + id, 60 * MIN, () => lite(`/data/hotel?hotelId=${encodeURIComponent(id)}&timeout=4`, { timeoutMs: 15000 }));
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
          margin: marginFor(req),
          maxRatesPerHotel: 1,
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
        for (const rt of entry.roomTypes || []) {
          const total = rt.offerRetailRate?.amount;
          if (total == null) continue;
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
          perNight: best.total / nights,
        };
      }).filter(Boolean);
      const member = isMember(req);
      data.forEach(h => applyParity(h, member));
      res.json({ success: true, data, pricing: { member, memberFactor: pricing.memberFactor() } });
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
      const r = await cached("esim:" + cc, 60 * MIN, () => lite(`/data/esimply/destinations?countryCode=${cc}`, { timeoutMs: 12000 }));
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
          price: p.price ?? p.retail_price ?? p.retailPrice ?? null,
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
          margin: marginFor(req),
          roomMapping: true,
          timeout: 12,
      };
      const r = await cached("rooms:" + JSON.stringify(roomsBody), 3 * MIN, () => lite("/hotels/rates", { method: "POST", body: roomsBody }));
      if (!r.ok) {
        if (r.status === 404 || r.json?.error?.code === 2001) return res.json({ success: true, data: [] });
        return res.status(502).json({ error: errMessage(r, "Could not load rooms") });
      }
      const entry = (r.json.data || [])[0];
      const offers = (entry?.roomTypes || []).map(rt => {
        const rate = rt.rates?.[0] || {};
        const cp = rate.cancellationPolicies || {};
        return {
          offerId: rt.offerId,
          mappedRoomId: rate.mappedRoomId || rt.mappedRoomId || null,
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
        };
      }).filter(o => o.total != null).sort((a, b2) => a.total - b2.total);
      const member = isMember(req);
      offers.forEach(o => applyParity(o, member));
      res.json({ success: true, data: offers, pricing: { member, memberFactor: pricing.memberFactor() } });
    } catch (err) {
      console.error("Stays rooms error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  });
}

module.exports = { registerStorefrontRoutes };
