/**
 * AI Trip Builder: "Toronto to Delhi and Amritsar, Dec 10–24, 2 adults 2 kids" → a day-by-day plan with
 * live flights and hotels for every stop, one total, and a shareable link.
 *
 *   POST /api/trips/plan            { prompt, currency }  → { id, editKey } or { question } when details are missing
 *   GET  /api/trips/:id             → trip (spec + live options + selections); canEdit with x-trip-key or as the owner
 *   POST /api/trips/:id/select      { kind: "hotel"|"flight", index, option }   (editor only)
 *   POST /api/trips/:id/refresh     → re-check prices (keeps the chosen hotels when still available)
 *   GET  /plan, /trip/:id           → pages
 *
 * Claude only writes the plan (cities, dates, flights, day ideas). Every price comes from our own live
 * search endpoints, called with the visitor's cookie so members and package holders see their prices.
 * Env: ANTHROPIC_API_KEY, TRIP_MODEL (default claude-opus-5)
 */
const crypto = require("crypto");
const path = require("path");

const STYLES = ["budget", "comfort", "luxury"];
const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ready", "question", "title", "summary", "origin", "adults", "children", "rooms", "budget", "stops", "flights", "ground", "days", "tips"],
  properties: {
    ready: { type: "boolean", description: "false only when the destination or the travel dates/month are missing" },
    question: { type: "string", description: "One short question when ready is false, else empty" },
    title: { type: "string" },
    summary: { type: "string", description: "One or two sentences" },
    origin: { type: "string", description: "Home city or airport the travellers fly from; empty if they don't need flights" },
    adults: { type: "integer" },
    children: { type: "integer" },
    rooms: { type: "integer" },
    budget: { type: "number", description: "Total budget in the user's currency, 0 if none given" },
    stops: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["city", "country", "checkin", "checkout", "style", "why"],
        properties: {
          city: { type: "string" }, country: { type: "string" },
          checkin: { type: "string", description: "YYYY-MM-DD" }, checkout: { type: "string", description: "YYYY-MM-DD" },
          style: { type: "string", enum: STYLES }, why: { type: "string", description: "Why stay here, one sentence" },
        },
      },
    },
    flights: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["from", "to", "depart", "return"],
        properties: {
          from: { type: "string", description: "City name or IATA code" }, to: { type: "string" },
          depart: { type: "string", description: "YYYY-MM-DD" }, return: { type: "string", description: "YYYY-MM-DD for a round trip, empty for one way" },
        },
      },
    },
    ground: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["from", "to", "date", "how"],
        properties: { from: { type: "string" }, to: { type: "string" }, date: { type: "string" }, how: { type: "string", description: "e.g. 'Vande Bharat train, about 5 h'" } },
      },
    },
    days: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["date", "city", "title", "plan"],
        properties: { date: { type: "string" }, city: { type: "string" }, title: { type: "string" }, plan: { type: "string", description: "One or two short sentences" } },
      },
    },
    tips: { type: "array", items: { type: "string" } },
  },
};

function systemPrompt(currency) {
  const today = new Date().toISOString().slice(0, 10);
  return `You plan trips for PlanurStay, an online travel agency that sells flights and hotels. Today is ${today}. Prices are in ${currency}.
Turn the traveller's request into a realistic plan. Our system searches live flights and hotels for it, so you never give prices.

- Stops: up to 5 cities, in travel order. Each stop's checkout is the next stop's check-in. Total trip at most 30 nights.
- Dates: use the dates given. If only a month or season is given, pick sensible dates and mention them in the summary. All dates must be after today. If there is no destination, or no hint at all of when, set ready=false and ask one short question.
- Flights: one round trip from the origin to the first stop when the trip ends in the same city (return = last day). When the trip ends somewhere else, use two one-way flights (in to the first stop, home from the last stop). Add a one-way flight between stops only when ground travel would take more than about 7 hours. Use city names, or IATA codes when you're sure.
- Ground: other moves between stops, with a practical way to travel and the rough time.
- Style per stop: budget, comfort or luxury, from what the traveller says (default comfort).
- Travellers: default 2 adults, 0 children. Rooms: 1 per 2 adults unless they say otherwise.
- Days: one entry per day, short and specific (neighbourhoods, sights, food). No prices.
- Tips: 3 to 5 practical ones (visas and documents, weather, local transport, SIM/data, customs).
Write in the traveller's language. Keep every text field short.`;
}

function createTrips({ db, port, jwt, JWT_SECRET }) {
  db.exec(`CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY, edit_key TEXT NOT NULL, user_id INTEGER,
    prompt TEXT, currency TEXT, spec TEXT NOT NULL, live TEXT,
    views INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const key = () => (process.env.ANTHROPIC_API_KEY || "").trim();
  const model = () => process.env.TRIP_MODEL || "claude-opus-5";
  const base = `http://127.0.0.1:${port}`;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const today = () => new Date().toISOString().slice(0, 10);
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "")).toString();

  const buckets = new Map();
  setInterval(() => buckets.clear(), 3600 * 1000).unref();
  const limited = (req, name, max) => {
    const k = name + (req.ip || "");
    const n = (buckets.get(k) || 0) + 1; buckets.set(k, n);
    return n > max;
  };
  const userId = (req) => { try { return jwt.verify(req.cookies?.token || "", JWT_SECRET).id || null; } catch { return null; } };

  async function internal(p, { method = "GET", body, cookie } = {}) {
    const r = await fetch(base + p, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(70000),
    });
    return r.json().catch(() => ({}));
  }

  // ─── Claude: request → structured plan ───
  async function planWithClaude(prompt, currency) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: model(), max_tokens: 16000,
        system: systemPrompt(currency),
        output_config: { effort: "medium", format: { type: "json_schema", schema: SPEC_SCHEMA } },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `Planner error ${r.status}`);
    if (j.stop_reason === "refusal") throw Object.assign(new Error("refusal"), { user: "We can't plan that trip. Try describing it differently." });
    if (j.stop_reason === "max_tokens") throw new Error("Plan was cut off");
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    return JSON.parse(text);
  }

  // Keep the plan inside what we can search and book.
  function clean(s) {
    const t = today(), str = (v, n = 200) => String(v ?? "").trim().slice(0, n);
    const adults = Math.min(Math.max(parseInt(s.adults) || 2, 1), 9), children = Math.min(Math.max(parseInt(s.children) || 0, 0), 6);
    const rooms = Math.min(Math.max(parseInt(s.rooms) || Math.ceil(adults / 2), 1), Math.min(5, adults));
    const stops = (s.stops || []).filter(x => ISO.test(x.checkin) && ISO.test(x.checkout) && x.checkin > t && x.checkout > x.checkin && str(x.city))
      .slice(0, 5).map(x => ({ city: str(x.city, 80), country: str(x.country, 60), checkin: x.checkin, checkout: x.checkout, style: STYLES.includes(x.style) ? x.style : "comfort", why: str(x.why, 240) }));
    const flights = (s.flights || []).filter(f => str(f.from) && str(f.to) && ISO.test(f.depart) && f.depart > t && (!f.return || (ISO.test(f.return) && f.return >= f.depart)))
      .slice(0, 4).map(f => ({ from: str(f.from, 60), to: str(f.to, 60), depart: f.depart, return: f.return || "" }));
    return {
      title: str(s.title, 90) || "Your trip", summary: str(s.summary, 400), origin: str(s.origin, 60),
      adults, children, rooms, budget: Math.max(0, +s.budget || 0),
      stops, flights,
      ground: (s.ground || []).slice(0, 6).map(g => ({ from: str(g.from, 60), to: str(g.to, 60), date: ISO.test(g.date) ? g.date : "", how: str(g.how, 160) })),
      days: (s.days || []).slice(0, 31).map(d => ({ date: ISO.test(d.date) ? d.date : "", city: str(d.city, 60), title: str(d.title, 90), plan: str(d.plan, 320) })),
      tips: (s.tips || []).slice(0, 6).map(x => str(x, 240)).filter(Boolean),
    };
  }

  // ─── Live search for every part of the plan ───
  async function airport(q) {
    const r = await internal(`/api/airports?q=${encodeURIComponent(q.trim())}`);
    const list = r.data || [];
    if (/^[A-Z]{3}$/i.test(q.trim())) return list.find(a => a.code === q.trim().toUpperCase()) || null;
    return list.find(x => /international|intercontinental/i.test(x.name || "")) || list[0] || null;
  }

  async function searchFlight(f, spec, ctx) {
    const [from, to] = await Promise.all([airport(f.from), airport(f.to)]);
    if (!from || !to) return { ...f, error: `We couldn't find an airport for ${!from ? f.from : f.to}.` };
    const search = { from: from.code, fromCity: from.city, fromCountry: from.countryCode, to: to.code, toCity: to.city, depart: f.depart, return: f.return, adults: spec.adults };
    const url = `/flights?${qs(search)}`;
    const legs = [{ origin: from.code, destination: to.code, date: f.depart }, ...(f.return ? [{ origin: to.code, destination: from.code, date: f.return }] : [])];
    const r = await internal("/api/flights/offers", { method: "POST", cookie: ctx.cookie, body: { legs, adults: spec.adults, currency: ctx.currency, country: from.countryCode || "US" } });
    const leg = (segs) => segs.length ? { depart: segs[0].departureTime, arrive: segs[segs.length - 1].arrivalTime, stops: segs.length - 1, via: segs.slice(0, -1).map(s => s.destinationCode) } : null;
    const js = (r.data?.journeys || []).map(j => {
      const o = j.cheapestOffer || (j.offers || [])[0] || {};
      return {
        price: o.pricing?.display?.total, currency: o.pricing?.display?.currency,
        airlines: [...new Set(j.segments.map(s => s.carrier?.marketingName).filter(Boolean))].slice(0, 3),
        logo: j.segments[0]?.carrier?.marketingLogo,
        outbound: leg(j.segments.filter(s => s.direction === "OUTBOUND")), inbound: leg(j.segments.filter(s => s.direction === "INBOUND")),
        minutes: j.totalDuration?.minutes || null,
      };
    }).filter(j => +j.price > 0);
    if (!js.length) return { ...f, fromCode: from.code, toCode: to.code, fromCity: from.city, toCity: to.city, url, options: [], error: r.error || "No flights found for these dates." };
    const cheapest = [...js].sort((a, b) => a.price - b.price)[0];
    // Fastest among reasonably priced ones (≤ 1.4× the cheapest), so "fastest" is never absurd
    const fastest = [...js].filter(j => j.price <= cheapest.price * 1.4).sort((a, b) => (a.minutes || 1e9) - (b.minutes || 1e9))[0];
    const options = [{ label: "Cheapest", ...cheapest }, ...(fastest && fastest !== cheapest ? [{ label: "Fastest", ...fastest }] : [])];
    return { ...f, fromCode: from.code, toCode: to.code, fromCity: from.city, toCity: to.city, url, options };
  }

  async function searchStay(stop, spec, ctx, keepId) {
    const places = await internal(`/api/places?q=${encodeURIComponent(stop.city + (stop.country ? ", " + stop.country : ""))}`);
    const list0 = places.data || [];
    const place = list0.find(p => p.kind === "city") || list0[0];
    if (!place) return { ...stop, options: [], error: `We couldn't find ${stop.city}.` };
    const dest = `${place.name}${place.detail ? ", " + place.detail : ""}`;
    const childAges = Array.from({ length: spec.children }, () => 8);
    const r = await internal("/api/stays/search", { method: "POST", cookie: ctx.cookie, body: { placeId: place.placeId, dest, checkin: stop.checkin, checkout: stop.checkout, adults: spec.adults, rooms: spec.rooms, childAges, currency: ctx.currency, limit: 120 } });
    const hotels = (r.data || []).filter(h => !h.memberOnly && h.total > 0);
    const hotelsUrl = `/hotels?${qs({ placeId: place.placeId, dest, checkin: stop.checkin, checkout: stop.checkout, adults: spec.adults, rooms: spec.rooms })}`;
    if (!hotels.length) return { ...stop, placeId: place.placeId, dest, hotelsUrl, options: [], error: r.error || "No hotels available for these dates." };
    const score = (h) => (h.rating || 0) * Math.log10(10 + (h.reviews || 0));
    const rated = hotels.filter(h => h.rating >= 7 && h.reviews >= 20);
    const pool = rated.length >= 3 ? rated : hotels;
    const byPrice = [...pool].sort((a, b) => a.total - b.total);
    const median = byPrice[Math.floor(byPrice.length / 2)].total;
    const budget = byPrice[0];
    // Best value: the best-reviewed hotel at or a little above the typical (median) price
    const value = [...pool].filter(h => h.total <= median * 1.15).sort((a, b) => score(b) - score(a))[0] || budget;
    const top = [...pool].filter(h => (h.stars || 0) >= 4).sort((a, b) => score(b) - score(a))[0] || [...pool].sort((a, b) => score(b) - score(a))[0];
    const seen = new Set(), options = [];
    for (const [label, h] of [["Best value", value], ["Top rated", top], ["Lowest price", budget]]) {
      if (!h || seen.has(h.id)) continue; seen.add(h.id);
      options.push({
        label, id: h.id, name: h.name, photo: h.thumb || h.photo, stars: h.stars, rating: h.rating, reviews: h.reviews, area: h.address || h.city,
        total: h.total, perNight: h.perNight, currency: h.currency, nights: h.nights, refundable: !!h.refundable, board: h.board,
        member: !!h.memberPrice, packagePrice: !!h.packagePrice,
        url: `/hotel/${h.id}?${qs({ checkin: stop.checkin, checkout: stop.checkout, adults: spec.adults, rooms: spec.rooms, dest, placeId: place.placeId })}`,
      });
    }
    // A hotel chosen earlier stays chosen when it's still available at refresh
    const kept = keepId && hotels.find(h => h.id === keepId);
    if (kept && !seen.has(kept.id)) options.unshift({ label: "Your pick", id: kept.id, name: kept.name, photo: kept.thumb || kept.photo, stars: kept.stars, rating: kept.rating, reviews: kept.reviews, area: kept.address || kept.city, total: kept.total, perNight: kept.perNight, currency: kept.currency, nights: kept.nights, refundable: !!kept.refundable, board: kept.board, member: !!kept.memberPrice, packagePrice: !!kept.packagePrice, url: `/hotel/${kept.id}?${qs({ checkin: stop.checkin, checkout: stop.checkout, adults: spec.adults, rooms: spec.rooms, dest, placeId: place.placeId })}` });
    const pref = { budget: "Lowest price", comfort: "Best value", luxury: "Top rated" }[stop.style];
    const sel = keepId ? Math.max(0, options.findIndex(o => o.id === keepId)) : Math.max(0, options.findIndex(o => o.label === pref));
    return { ...stop, placeId: place.placeId, dest, hotelsUrl, options, sel };
  }

  // At most 3 searches at once (LiteAPI rate limits)
  async function pool3(fns) {
    const out = new Array(fns.length); let i = 0;
    const worker = async () => { while (i < fns.length) { const k = i++; try { out[k] = await fns[k](); } catch (e) { out[k] = { error: "Search took too long. Try refreshing prices." }; } } };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }

  async function runSearches(spec, ctx, prev) {
    const keep = (i) => prev?.stops?.[i]?.options?.[prev.stops[i].sel]?.id;
    const res = await pool3([
      ...spec.flights.map((f) => () => searchFlight(f, spec, ctx)),
      ...spec.stops.map((s, i) => () => searchStay(s, spec, ctx, keep(i))),
    ]);
    const flights = res.slice(0, spec.flights.length).map((f, i) => ({ ...f, sel: Math.min(prev?.flights?.[i]?.sel || 0, Math.max(0, (f.options || []).length - 1)) }));
    return { flights, stops: res.slice(spec.flights.length), currency: ctx.currency, checkedAt: new Date().toISOString() };
  }

  function load(id) {
    const row = db.prepare("SELECT * FROM trips WHERE id = ?").get(String(id || ""));
    if (!row) return null;
    return { ...row, spec: JSON.parse(row.spec), live: row.live ? JSON.parse(row.live) : null };
  }
  const canEdit = (req, row) => (req.get("x-trip-key") && req.get("x-trip-key") === row.edit_key) || (row.user_id && row.user_id === userId(req));
  const view = (req, row) => ({ id: row.id, prompt: row.prompt, spec: row.spec, live: row.live, canEdit: !!canEdit(req, row), createdAt: row.created_at });

  function register(app) {
    app.get("/plan", (req, res) => res.sendFile(path.join(__dirname, "../../public/plan.html")));
    app.get("/trip/:id", (req, res) => res.sendFile(path.join(__dirname, "../../public/trip.html")));

    app.post("/api/trips/plan", async (req, res) => {
      if (!key()) return res.status(503).json({ error: "The trip planner isn't available right now." });
      const prompt = String(req.body?.prompt || "").trim().slice(0, 1500);
      if (prompt.length < 8) return res.status(400).json({ error: "Tell us a bit more: where, when and who's travelling." });
      if (limited(req, "plan", 8)) return res.status(429).json({ error: "You've planned several trips in a short time. Please try again in a little while." });
      const currency = /^[A-Z]{3}$/.test(req.body?.currency || "") ? req.body.currency : "USD";
      try {
        const raw = await planWithClaude(prompt, currency);
        if (!raw.ready) return res.json({ success: true, question: String(raw.question || "Where would you like to go, and when?").slice(0, 300) });
        const spec = clean(raw);
        if (!spec.stops.length) return res.json({ success: true, question: raw.question || "Which dates are you travelling? (We can only plan trips starting from tomorrow.)" });
        const live = await runSearches(spec, { cookie: req.headers.cookie || "", currency });
        const id = crypto.randomBytes(6).toString("base64url"), editKey = crypto.randomBytes(18).toString("hex");
        db.prepare("INSERT INTO trips (id, edit_key, user_id, prompt, currency, spec, live) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, editKey, userId(req), prompt, currency, JSON.stringify(spec), JSON.stringify(live));
        res.json({ success: true, id, editKey });
      } catch (err) {
        console.error("Trip plan error:", err.message);
        res.status(502).json({ error: err.user || "The planner is busy right now. Please try again in a moment." });
      }
    });

    app.get("/api/trips/:id", (req, res) => {
      const row = load(req.params.id);
      if (!row) return res.status(404).json({ error: "Trip not found" });
      db.prepare("UPDATE trips SET views = views + 1 WHERE id = ?").run(row.id);
      res.json({ success: true, data: view(req, row) });
    });

    app.post("/api/trips/:id/select", (req, res) => {
      const row = load(req.params.id);
      if (!row) return res.status(404).json({ error: "Trip not found" });
      if (!canEdit(req, row)) return res.status(403).json({ error: "Only the person who planned this trip can change it. Plan your own copy instead." });
      const { kind, index, option } = req.body || {};
      const list = kind === "hotel" ? row.live?.stops : kind === "flight" ? row.live?.flights : null;
      const item = list?.[+index];
      if (!item || !Number.isInteger(+option) || +option < 0 || +option >= (item.options || []).length) return res.status(400).json({ error: "Invalid choice" });
      item.sel = +option;
      db.prepare("UPDATE trips SET live = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify(row.live), row.id);
      res.json({ success: true, data: view(req, row) });
    });

    app.post("/api/trips/:id/refresh", async (req, res) => {
      const row = load(req.params.id);
      if (!row) return res.status(404).json({ error: "Trip not found" });
      const age = Date.now() - Date.parse(row.live?.checkedAt || 0);
      // Anyone with the link may refresh old prices; fresh ones are served as they are.
      if (age < 15 * 60 * 1000) return res.json({ success: true, data: view(req, row) });
      if (limited(req, "refresh", 20)) return res.status(429).json({ error: "Please wait a little before refreshing prices again." });
      const first = [...row.spec.flights.map(f => f.depart), ...row.spec.stops.map(s => s.checkin)].sort()[0];
      if (!first || first <= today()) return res.status(400).json({ error: "This trip has already started, so prices can't be refreshed." });
      try {
        row.live = await runSearches(row.spec, { cookie: req.headers.cookie || "", currency: /^[A-Z]{3}$/.test(req.body?.currency || "") ? req.body.currency : row.currency }, row.live);
        db.prepare("UPDATE trips SET live = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(JSON.stringify(row.live), row.id);
        res.json({ success: true, data: view(req, row) });
      } catch (err) {
        console.error("Trip refresh error:", err.message);
        res.status(502).json({ error: "Couldn't refresh prices right now." });
      }
    });
  }
  return { register };
}

module.exports = { createTrips, SPEC_SCHEMA };
