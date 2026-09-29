/**
 * Travellez MCP connection: flights from every supplier Travellez connects (Duffel, Mystifly, Sabre, …)
 * through the MCP's /api/v2 endpoints, merged into PlanurStay's flight search next to LiteAPI.
 *
 * Money (pay upfront): the customer pays PlanurStay by card through our Stripe account. We only hold the
 * amount, book through the MCP (Travellez pays the airline with the company card), then charge the hold
 * once the airline confirms — or release it if the booking fails.
 *
 *   POST /api/mcp/flights/hold   { offerId, passengers, contact } → { prebookId, transactionId, secretKey, price, currency, processor: "stripe", publishableKey }
 *   POST /api/mcp/flights/book   { ref }  (after the card is authorized) → booking summary
 *   GET  /api/mcp/status          → which parts are switched on (no secrets)
 *
 * Env: TRAVELLEZ_MCP_URL, TRAVELLEZ_EMAIL, TRAVELLEZ_PASSWORD, MCP_FLIGHTS=on (show fares once booking is on) or
 *      preview (show fares to check them, without booking),
 *      MCP_BOOKING=on (allow booking; needs STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY),
 *      MCP_FLIGHT_MARKUP_PCT (default 3), MCP_SEARCH_TIMEOUT_MS (default 25000),
 *      MCP_FLIGHT_SUPPLIERS (default duffel), MCP_FX_BUFFER_PCT (default 2), MCP_HOTEL_TIMEOUT_MS (default 75000).
 */
const crypto = require("crypto");
const sup = require("./suppliers");

const env = (k) => String(process.env[k] || "").trim();
const base = () => env("TRAVELLEZ_MCP_URL").replace(/\/$/, "");
const connected = () => !!(base() && env("TRAVELLEZ_EMAIL") && env("TRAVELLEZ_PASSWORD"));
const flightsOn = () => connected() && ["on", "preview"].includes(env("MCP_FLIGHTS"));
const payOn = () => env("MCP_BOOKING") === "on" && !!env("STRIPE_SECRET_KEY") && !!env("STRIPE_PUBLISHABLE_KEY");
const bookingOn = () => flightsOn() && payOn();
const hotelsOn = () => connected() && ["on", "preview"].includes(env("MCP_HOTELS"));
const hotelsVisible = () => hotelsOn() && (env("MCP_HOTELS") === "preview" || payOn());
const hotelMarkup = () => { const m = parseFloat(env("MCP_HOTEL_MARKUP_PCT")); return Number.isFinite(m) && m >= 0 && m <= 40 ? m : 8; };
// Hotel suppliers whose rates are paid in full when booked (safe to charge the customer upfront).
// Other types (e.g. Sabre, whose rates are often "pay at hotel") stay out until Travellez marks prepaid rates.
const PREPAID_TYPES = () => new Set((env("MCP_HOTEL_TYPES") || "1,4").split(",").map(x => x.trim()).filter(Boolean));
const SUPPLIER = { 1: "duffel", 3: "sabre", 4: "ratehawk" };
const markup = () => { const m = parseFloat(env("MCP_FLIGHT_MARKUP_PCT")); return Number.isFinite(m) && m >= 0 && m <= 30 ? m : 3; };
const stripe = () => require("stripe")(env("STRIPE_SECRET_KEY"));
const ZERO_DEC = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XOF", "XAF", "PYG", "RWF"]);

// ─── Currency: Travellez prices in its account currency (USD); customers see and pay in their own ───
// Converted at the day's rate plus MCP_FX_BUFFER_PCT (default 2) to cover card/bank FX when we pay the supplier.
const fxBuffer = () => { const m = parseFloat(env("MCP_FX_BUFFER_PCT")); return Number.isFinite(m) && m >= 0 && m <= 10 ? m : 2; };
let fx = { at: 0, rates: null }, fxLoading = null;
async function fxRates() {
  if (fx.rates && Date.now() - fx.at < 6 * 3600 * 1000) return fx.rates;
  fxLoading = fxLoading || fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000) })
    .then(r => r.json()).then(j => { if (j?.rates?.USD) fx = { at: Date.now(), rates: j.rates }; })
    .catch(e => console.warn("FX rates:", e.message)).finally(() => { fxLoading = null; });
  await fxLoading;
  return fx.rates; // stale rates beat none; null only if we never got any
}
/** Multiplier from supplier currency to the customer's (buffer included), or null if unknown. */
async function fxRate(from, to) {
  from = String(from || "").toUpperCase(); to = String(to || from).toUpperCase();
  if (!from) return null;
  if (from === to) return 1;
  const rates = await fxRates();
  if (!rates?.[from] || !rates?.[to]) return null;
  return (rates[to] / rates[from]) * (1 + fxBuffer() / 100);
}

// ─── MCP sessions: one login per Travellez account, reused until the MCP says it expired ───
// "main" searches every supplier (Travellez shows each hotel once, under one supplier). The optional "sabre" account
// (TRAVELLEZ_SABRE_EMAIL / _PASSWORD) searches Sabre only, so Sabre's rates show for hotels Travellez files under RateHawk.
const ACCOUNTS = { main: ["TRAVELLEZ_EMAIL", "TRAVELLEZ_PASSWORD"], sabre: ["TRAVELLEZ_SABRE_EMAIL", "TRAVELLEZ_SABRE_PASSWORD"] };
const sabreAccount = () => connected() && !!(env("TRAVELLEZ_SABRE_EMAIL") && env("TRAVELLEZ_SABRE_PASSWORD"));
const sessions = {};
async function login(account) {
  const [ek, pk] = ACCOUNTS[account] || ACCOUNTS.main;
  const r = await fetch(`${base()}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: env(ek), password: env(pk) }), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`MCP login failed (${account}, ${r.status})`);
  sessions[account].token = j.access_token;
  return j.access_token;
}
async function getToken(force, account = "main") {
  const s = sessions[account] = sessions[account] || { token: null, loggingIn: null };
  if (s.token && !force) return s.token;
  s.loggingIn = s.loggingIn || login(account).finally(() => { s.loggingIn = null; });
  return s.loggingIn;
}
async function mcp(path, { method = "GET", body, query, timeoutMs = 60000, account = "main" } = {}) {
  const url = `${base()}${path}${query ? "?" + new URLSearchParams(query) : ""}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getToken(attempt > 0, account === "sabre" ? "sabre" : "main");
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 401 && attempt === 0) continue;
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  }
}

// ─── Travellez flight offer → PlanurStay journey (the shape the results page and checkout already use) ───
const minutesOf = (iso) => { if (typeof iso === "number" || /^\d+$/.test(String(iso ?? "").trim())) return +iso || 0; const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(String(iso || "")) || []; return (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0); };
const localMs = (t) => Date.parse(String(t || "").slice(0, 19) + "Z"); // wall-clock time at the airport
const sell = (net) => Math.ceil(net * (1 + markup() / 100) * 100) / 100;
const logo = (code) => code ? `https://assets.duffel.com/img/airlines/for-light-background/full-color-logo/${encodeURIComponent(code)}.svg` : null;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = (s) => { try { return JSON.parse(Buffer.from(String(s), "base64url").toString()); } catch { return null; } };

const fareCurrency = (fare) => String(fare.currency || fare.total_currency || fare.fare?.currency || "").toUpperCase();
// Local wall-clock time at the airport. Sabre's departure_time is UTC; its local time is date + departure_time_sabre.
const localTime = (s, k) => s[`${k}_date`] && s[`${k}_time_sabre`] ? `${s[`${k}_date`]}T${String(s[`${k}_time_sabre`]).slice(0, 8)}` : String(s[`${k}_time`] || "").slice(0, 19);

/** rates: supplier currency → multiplier into `currency` (from fxRate); fares we can't convert are dropped. */
function toJourney(f, requestId, flightType, currency, rates = {}) {
  const fare = (f.all_fares || [])[0] || {};
  const net = parseFloat(fare.total_amount), cur = fareCurrency(fare), show = String(currency || cur).toUpperCase();
  if (!(net > 0) || !f.id || !cur) return null;
  const rate = cur === show ? 1 : rates[cur];
  if (!(rate > 0)) return null;
  const dirs = ["OUTBOUND", "INBOUND"];
  const segments = [], connections = [], legDurations = [];
  (f.trip || []).forEach((trip, li) => {
    const dir = dirs[li] || `LEG${li + 1}`;
    const segs = trip.segments || [];
    segs.forEach((s, si) => {
      const al = s.airline || {}, op = s.operating_airline || al;
      // Departure and arrival are local times in different time zones, so never subtract them: use the supplier's duration
      const minutes = minutesOf(s.duration) || null;
      segments.push({
        direction: dir, departureTime: localTime(s, "departure"), arrivalTime: localTime(s, "arrival"),
        originCode: s.origin?.iata_code, destinationCode: s.destination?.iata_code, originName: s.origin?.name || s.origin?.city_name, destinationName: s.destination?.name || s.destination?.city_name,
        duration: minutes ? { minutes } : undefined, flight: { marketingNumber: String(s.flight_number || "") }, segmentKey: `${f.id}-${li}-${si}`,
        carrier: { marketingCode: al.iata_code, marketingName: al.name || al.iata_code, marketingLogo: logo(al.iata_code), operatingCode: op.iata_code, operatingName: op.name },
      });
      const next = segs[si + 1];
      if (next) {
        const arr = localTime(s, "arrival"), dep = localTime(next, "departure"); // same airport, so local times subtract safely
        const gap = Math.round((localMs(dep) - localMs(arr)) / 60000);
        connections.push({
          direction: dir, duration: { minutes: Math.max(0, gap) }, overnight: arr.slice(0, 10) !== dep.slice(0, 10),
          changeAirport: s.destination?.iata_code !== next.origin?.iata_code,
          arrivalAirportCode: s.destination?.iata_code, arrivalAirportName: s.destination?.name, arrivalTime: arr,
          departureAirportCode: next.origin?.iata_code, departureAirportName: next.origin?.name, departureTime: dep,
        });
      }
    });
    // Leg time from the supplier; otherwise flight times + layovers (both time-zone safe)
    const legMin = minutesOf(trip.duration) || (segs.every(x => minutesOf(x.duration))
      ? segs.reduce((t, x, k) => t + minutesOf(x.duration) + (segs[k + 1] ? Math.max(0, Math.round((localMs(localTime(segs[k + 1], "departure")) - localMs(localTime(x, "arrival"))) / 60000)) : 0), 0) : 0);
    legDurations.push({ direction: dir, duration: { minutes: Math.max(0, legMin) } });
  });
  if (!segments.length) return null;
  const c = fare.fare_conditions || {};
  // The offer lookup names suppliers differently from the search (search "myfarebox" = lookup "mystifly")
  const src0 = String(fare._source || f.cheapest_provider || f.provider || "duffel").toLowerCase();
  const price = sell(net * rate), source = src0 === "myfarebox" ? "mystifly" : src0;
  const offer = {
    // c = the currency the customer saw; the hold converts the live price into it again
    offerId: "tz:" + b64({ i: f.id, r: requestId, p: source, t: flightType, c: show }),
    expiration: null, supplier: source,
    pricing: { display: { total: price, currency: show, perPassenger: { adult: { total: null } } } },
    baggage: { hasCarryOnBag: !!c.includes_carry_on, hasCheckedBag: !!c.includes_checked_bags, included: [] },
    fare: { family: fare.fare?.fare_family || null },
    terms: { refundable: !!c.is_refundable, changeable: !!c.is_changeable },
    segmentFares: [],
  };
  return {
    journeyKey: "tz-" + f.id, supplier: offer.supplier,
    legDurations, totalDuration: { minutes: legDurations.reduce((a, l) => a + l.duration.minutes, 0) },
    connections, segments, cheapestOffer: { ...offer, segmentAmenities: [] }, offers: [offer],
  };
}

// Same flight = same flight numbers and first departure time on every leg, whoever sells it
function signature(j) {
  const legs = {};
  for (const s of j.segments || []) (legs[s.direction] = legs[s.direction] || []).push(s);
  return Object.keys(legs).sort().map(d => `${legs[d].map(s => `${s.carrier?.marketingCode || ""}${String(s.flight?.marketingNumber || "").replace(/^0+/, "")}`).join("+")}@${String(legs[d][0].departureTime || "").slice(0, 16)}`).join("|");
}
const priceOf = (j) => +(j.cheapestOffer?.pricing?.display?.total ?? Infinity);

/** Merge LiteAPI + MCP journeys: one card per physical flight, at the cheaper price. */
function mergeJourneys(liteJourneys, mcpJourneys) {
  const bySig = new Map(), out = [];
  for (const j of [...liteJourneys, ...mcpJourneys]) {
    const sig = signature(j), cur = j.cheapestOffer?.pricing?.display?.currency;
    const seen = bySig.get(sig);
    if (!seen) { bySig.set(sig, out.length); out.push(j); continue; }
    const other = out[seen];
    if (other.cheapestOffer?.pricing?.display?.currency === cur && priceOf(j) < priceOf(other)) out[seen] = j;
  }
  return out;
}

/** Flight search through the MCP. Never throws: returns [] if the MCP is off, slow or failing. */
async function searchFlights({ legs, adults = 1, currency }) {
  // Customers only see MCP fares they can actually book; MCP_FLIGHTS=preview shows them anyway (team testing)
  if (!flightsOn() || !(bookingOn() || env("MCP_FLIGHTS") === "preview")) return [];
  try {
    const r = await mcp("/api/v2/flights/search", {
      method: "POST", timeoutMs: +env("MCP_SEARCH_TIMEOUT_MS") || 25000,
      body: { slices: legs.map(l => ({ origin: l.origin, destination: l.destination, departure_date: l.date })), passengers: Array.from({ length: Math.max(1, Math.min(9, +adults || 1)) }, () => ({ type: "adult" })) },
    });
    if (!r.ok) { console.warn("MCP flight search:", r.status, (r.text || "").slice(0, 200)); return []; }
    const d = r.json || {}, results = d.results || [];
    const rates = {};
    for (const c of new Set(results.map(f => fareCurrency((f.all_fares || [])[0] || {})).filter(Boolean))) rates[c] = await fxRate(c, currency);
    // Customers only get fares from the suppliers in MCP_FLIGHT_SUPPLIERS (default duffel; add mystifly,sabre after one
    // real test booking each — they book without passenger ids). Preview shows all.
    const sellable = new Set((env("MCP_FLIGHT_SUPPLIERS") || "duffel").toLowerCase().split(",").map(x => x.trim()).filter(Boolean));
    return results.map(f => toJourney(f, d.request_id, d.flight_type || (legs.length === 2 ? "roundtrip" : "oneway"), currency, rates))
      .filter(j => j && !sup.flightSourceOff(j.supplier) && (env("MCP_FLIGHTS") === "preview" || sellable.has(j.supplier)));
  } catch (e) { console.warn("MCP flight search:", e.message); return []; }
}

// ─── Hotels (RateHawk/WorldOta, Duffel Stays) ───
const hotelSell = (net) => Math.ceil(net * (1 + hotelMarkup() / 100) * 100) / 100;
const hotelsSeen = new Map(); // tz hotel id → what the search told us (name, photos, address…), for the hotel page
const roomOffers = new Map(); // tzh offer id → rate details (the price is only trusted from here, never from the browser)
const HOTEL_TTL = 3 * 3600 * 1000, OFFER_TTL = 60 * 60 * 1000;
const sweepMaps = () => { const now = Date.now(); for (const [k, v] of hotelsSeen) if (now - v.at > HOTEL_TTL) hotelsSeen.delete(k); for (const [k, v] of roomOffers) if (now - v.at > OFFER_TTL) roomOffers.delete(k); };
// x: "s" = found through the Sabre-only account (its rates and bookings must use that account too)
const tzHotelId = (h) => "tz-" + b64({ s: h.id, a: h.accommodation_id, t: String(h.type || "1"), la: +(+h.lat).toFixed(5), lo: +(+h.lng).toFixed(5), ...(h.account === "sabre" ? { x: "s" } : {}) });
const accountOf = (k) => (k?.x === "s" ? "sabre" : "main");
const parseHotelId = (id) => String(id || "").startsWith("tz-") ? unb64(String(id).slice(3)) : null;
// RateHawk sends photos as one comma-joined string of URLs with a {size} placeholder
const photosOf = (h) => [h.photo, ...(h.photos || []).map(p => typeof p === "string" ? p : p?.url)]
  .flatMap(u => String(u || "").split(/,(?=https?:\/\/)/)).map(u => u.trim().replace(/\{size\}|%7Bsize%7D/gi, "1024x768"))
  .filter(u => /^https?:\/\//.test(u)).filter((u, i, a) => a.indexOf(u) === i);
const BOARD = { room_only: "Room only", breakfast: "Breakfast included", half_board: "Half board", full_board: "Full board", all_inclusive: "All inclusive" };

/** Hotel search through the MCP, in PlanurStay's result-card shape. Never throws. */
async function searchHotels({ lat, lng, radiusKm = 15, checkin, checkout, adults = 2, rooms = 1, currency }) {
  if (!hotelsVisible() || !Number.isFinite(+lat) || !Number.isFinite(+lng)) return [];
  try {
    // Travellez searches every hotel supplier before answering (often 30-40s); the stays route doesn't wait for it
    const body = {
      check_in: checkin, check_out: checkout, latitude: +lat, longitude: +lng, radius: Math.max(1, Math.min(50, Math.round(radiusKm))),
      guests: Array.from({ length: Math.max(1, Math.min(9, +adults || 2)) }, () => "adult"), rooms: Math.max(1, +rooms || 1),
      // Travellez answers 100 hotels a page, cheapest first; big cities have 1,000+ (pricier chains, incl. most Sabre hotels,
      // come after the first 300). All pages together take about as long as three.
      max_pages: Math.max(1, Math.min(20, +env("MCP_HOTEL_PAGES") || 15)),
    };
    const timeoutMs = +env("MCP_HOTEL_TIMEOUT_MS") || 75000;
    const withSabre = sabreAccount() && PREPAID_TYPES().has("3") && !sup.isOff("sabre_hotels");
    const [r, rs] = await Promise.all([
      mcp("/api/v2/hotels/search", { method: "POST", timeoutMs, body }).catch(e => ({ ok: false, text: e.message })),
      // Travellez caches searches by location + dates, not by account: search a point ~1 m north so the Sabre-only
      // account never gets (or gives) the main account's cached results
      withSabre ? mcp("/api/v2/hotels/search", { method: "POST", timeoutMs, body: { ...body, latitude: +(body.latitude + 0.00001).toFixed(6) }, account: "sabre" }).catch(e => ({ ok: false, text: e.message })) : null,
    ]);
    if (!r.ok) console.warn("MCP hotel search:", r.status, (r.text || "").slice(0, 200));
    if (rs && !rs.ok) console.warn("MCP hotel search (Sabre account):", rs.status, (rs.text || "").slice(0, 200));
    if (!r.ok && !rs?.ok) return [];
    sweepMaps();
    const nights = Math.max(1, Math.round((Date.parse(checkout) - Date.parse(checkin)) / 86400000));
    const results = [...(r.ok ? r.json?.results || [] : []), ...(rs?.ok ? (rs.json?.results || []).map(h => ({ ...h, _account: "sabre" })) : [])];
    const types = PREPAID_TYPES(), out = [], show = String(currency || "").toUpperCase();
    const rates = {};
    for (const c of new Set(results.map(h => String(h.cheapest_rate_currency || "").toUpperCase()).filter(Boolean))) rates[c] = await fxRate(c, show || c);
    for (const h of results) {
      const type = String(h.type || "1"), net = parseFloat(h.cheapest_rate_total_amount), cur = String(h.cheapest_rate_currency || "").toUpperCase();
      if (!types.has(type) || sup.hotelTypeOff(type) || !(net > 0) || !cur || !(rates[cur] > 0)) continue;
      const hlat = +(h.latitude ?? h.geographic_coordinates?.latitude), hlng = +(h.longitude ?? h.geographic_coordinates?.longitude);
      const id = tzHotelId({ ...h, type, lat: hlat, lng: hlng, account: h._account });
      const photos = photosOf(h), total = hotelSell(net * rates[cur]);
      hotelsSeen.set(id, { at: Date.now(), raw: h, photos, type, alt: [] });
      out.push({
        id, mcp: true, supplier: SUPPLIER[type] || `type${type}`, name: h.name, photo: photos[0] || null, thumb: photos[0] || null,
        address: h.address?.line_one || "", city: h.address?.city_name || "", country: h.address?.country_code || null,
        lat: hlat, lng: hlng, stars: +h.rating || 0, rating: +h.review_score || 0, reviews: 0, nights,
        total, publicTotal: total, perNight: total / nights, currency: show || cur, offerId: null,
        refundable: false, refundAny: false, meals: [], cancelUnknown: true,
      });
    }
    return mergeMcp(out);
  } catch (e) { console.warn("MCP hotel search:", e.message); return []; }
}

const normName = (n) => String(n || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\b(the|hotel|hotels|resort|by|and|&)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const kmBetween = (a1, o1, a2, o2) => { const R = 6371, r = Math.PI / 180, x = Math.sin((a2 - a1) * r / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin((o2 - o1) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
// ─── Photos: some supplier hotels (e.g. Sabre) come with few or no pictures. Top them up with the same hotel's
// photos from LiteAPI's hotel content (licensed for display), matched by name within 300 m. storefront-routes plugs in:
//   find(name, lat, lng) → [{ id, name, latitude, longitude, main_photo }]   gallery(liteId) → [url]
let photoSource = null;
const usePhotoSource = (src) => { photoSource = src; };
const sameName = (a, b) => { const x = normName(a), y = normName(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x)))); };
function liteTwin(cands, name, lat, lng) {
  let best = null, bestKm = 0.3;
  for (const c of cands || []) {
    if (!c?.main_photo || !sameName(c.name, name)) continue;
    const km = kmBetween(lat, lng, +c.latitude, +c.longitude);
    if (km < bestKm) { best = c; bestKm = km; }
  }
  return best;
}
async function findLite(name, lat, lng) {
  if (!photoSource || !name || !Number.isFinite(+lat) || !Number.isFinite(+lng)) return null;
  const look = (q) => photoSource.find(q, +lat, +lng).then(c => liteTwin(c, name, +lat, +lng), () => null);
  // Names differ between suppliers ("The Strand Palace" / "Strand Palace Hotel"): retry with the core words
  return (await look(name)) || (normName(name) !== String(name).toLowerCase() && normName(name).length >= 4 ? await look(normName(name)) : null);
}
/** Give photo-less MCP hotels the matching LiteAPI hotel's main photo (and remember it for the hotel page). Never throws. */
async function fillPhotos(list) {
  const bare = (list || []).filter(h => h.mcp && !h.photo).slice(0, 40);
  for (let i = 0; i < bare.length; i += 4) await Promise.all(bare.slice(i, i + 4).map(async h => {
    const t = await findLite(h.name, h.lat, h.lng);
    if (!t) return;
    h.photo = h.thumb = t.main_photo;
    const seen = hotelsSeen.get(h.id);
    if (seen) { seen.photos = [t.main_photo]; seen.liteId = t.id; }
  }));
  return list;
}

/** The same hotel found by both Travellez accounts (e.g. RateHawk on the main account, Sabre on the Sabre-only one) shows
 *  once, at the cheaper price; the hotel page lists the rooms of both (seen.alt). Same Sabre hotel twice → kept once. */
function mergeMcp(list) {
  const out = [];
  for (const m of list) {
    const twin = out.find(h => h.lat && h.lng && kmBetween(h.lat, h.lng, m.lat, m.lng) < 0.25 && normName(h.name) === normName(m.name));
    if (!twin) { out.push(m); continue; }
    if (twin.supplier === m.supplier) continue; // same supplier from both accounts: identical rates
    const [keep, other] = m.total < twin.total ? [m, twin] : [twin, m];
    const ks = hotelsSeen.get(keep.id), os = hotelsSeen.get(other.id);
    if (ks) ks.alt = [...new Set([...(ks.alt || []), other.id, ...(os?.alt || [])])];
    keep.suppliers = [...new Set([...(twin.suppliers || [twin.supplier]), m.supplier])];
    if (!keep.photo && other.photo) { keep.photo = keep.thumb = other.photo; if (ks && !ks.photos?.length) ks.photos = os?.photos || [other.photo]; }
    if (keep !== twin) out[out.indexOf(twin)] = keep;
  }
  return out;
}

/** One card per hotel: the same hotel from LiteAPI and the MCP shows once, at the lower price (its MCP rooms join the room list). */
function mergeHotels(lite, mcpList) {
  const out = [...lite];
  for (const m of mcpList) {
    const nm = normName(m.name);
    const twin = out.find(h => !h.mcp && h.lat && h.lng && kmBetween(h.lat, h.lng, m.lat, m.lng) < 0.25 && normName(h.name) === nm);
    if (!twin) { out.push(m); continue; }
    // The hotel page adds the rooms of the cheapest MCP twin (e.g. RateHawk over Duffel Stays for the same hotel)
    if (!twin.tz || m.total < twin._tzTotal) { twin.tz = m.id; twin._tzTotal = m.total; }
    if (twin.currency === m.currency && !twin.memberOnly && m.total < twin.total) {
      Object.assign(twin, { total: m.total, publicTotal: m.total, perNight: m.perNight, strikeTotal: null, memberPrice: false, packagePrice: false, via: "mcp" });
    }
  }
  return out;
}

/** Hotel page data for a hotel that only the MCP sells (built from the search and the room list). */
async function hotelDetails(id, stay) {
  const key = parseHotelId(id); if (!key) return null;
  const seen = hotelsSeen.get(id), h = seen?.raw || {};
  let rates = null;
  if (!seen && stay?.checkin) rates = await fetchRates(id, stay).catch(() => null);
  let photos = seen?.photos || [];
  // Fewer than 5 pictures: add the same hotel's LiteAPI gallery (found now if the search didn't need to)
  if (photos.length < 5 && photoSource && (h.name || rates?.hotel_name)) {
    try {
      let liteId = seen?.liteId;
      if (!liteId) liteId = (await findLite(h.name || rates?.hotel_name, key.la, key.lo))?.id;
      if (liteId) { photos = [...photos, ...(await photoSource.gallery(liteId))].filter((u, i, a) => u && a.indexOf(u) === i); if (seen) { seen.liteId = liteId; seen.photos = photos; } }
    } catch { /* keep what the supplier gave */ }
  }
  return {
    id, mcp: true, name: h.name || rates?.hotel_name || "Hotel", hotelDescription: "", main_photo: photos[0] || null,
    hotelImages: photos.map(u => ({ url: u, urlHd: u })), address: h.address?.line_one || "", city: h.address?.city_name || "", zip: h.address?.postal_code || "",
    country: h.address?.country_code || "", starRating: +h.rating || 0, rating: +h.review_score || 0, reviewCount: 0,
    location: { latitude: key.la, longitude: key.lo }, // Sabre sends codes ("wheelchair_access", "wireless_internet_connection_in_public_areas"): make them readable
    hotelFacilities: [...new Set((h.amenities || []).map(a => (typeof a === "string" ? a : a?.description || a?.type || "")).filter(a => a && !/pornographic/i.test(a))
      .map(a => /_/.test(a) ? a.replace(/_?\(generic\)$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim().replace(/^./, c => c.toUpperCase()) : a))],
    facilities: [], checkinCheckoutTimes: rates?.check_in_info ? { checkin: rates.check_in_info.check_in_after_time, checkout: rates.check_in_info.check_out_before_time } : null,
    hotelImportantInformation: "", chain: null, rooms: [],
  };
}

async function fetchRates(id, { checkin, checkout, adults = 2, rooms = 1 }) {
  const k = parseHotelId(id); if (!k) return null;
  // ids as text: RateHawk sends numbers
  const r = await mcp("/api/v2/hotels/rates", { method: "POST", timeoutMs: 40000, account: accountOf(k), body: {
    search_id: String(k.s ?? ""), accommodation_id: String(k.a ?? ""), provider_type: k.t, latitude: k.la, longitude: k.lo, check_in: checkin, check_out: checkout,
    guests: Array.from({ length: Math.max(1, Math.min(9, +adults || 2)) }, () => "adult"), rooms: Math.max(1, +rooms || 1),
  } });
  if (!r.ok) { console.warn("MCP hotel rates:", r.status, (r.text || "").slice(0, 200)); return null; }
  return r.json;
}

/** Rooms for an MCP hotel, in the shape the hotel page renders, plus the rooms of the same hotel from the other account. */
async function hotelRooms(id, stay) {
  const ids = [id, ...(hotelsSeen.get(id)?.alt || [])];
  const lists = await Promise.all(ids.map(x => roomsFor(x, stay).catch(() => [])));
  return lists.flat().sort((a, b) => a.total - b.total);
}
async function roomsFor(id, stay) {
  const k = parseHotelId(id);
  if (!k || !hotelsVisible() || !PREPAID_TYPES().has(k.t) || sup.hotelTypeOff(k.t)) return [];
  const d = await fetchRates(id, stay).catch(() => null);
  if (!d) return [];
  sweepMaps();
  const now = Date.now(), cur = String(stay.currency || "").toUpperCase();
  const offers = [], rates = {};
  for (const rt of d.rates || []) {
    const net = parseFloat(rt.total_amount), rc = String(rt.total_currency || rt.currency || "").toUpperCase(), rateId = rt.id || rt.rate_id;
    if (!(net > 0) || !rateId || !rc) continue;
    // Sabre mixes prepaid and guaranteed (pay at the hotel) rates. Prepaid: we charge upfront as usual. Guaranteed: the
    // guest pays the hotel; we only save their card (no-show / late-cancellation fees). None that need proof of
    // eligibility (military, government…) or aren't overnight (day use).
    if (k.t === "3" && /military|government|day use|senior|employee|aaa|member/i.test(`${rt.ratePlanType || ""} ${rt.ratePlan?.RatePlanName || ""}`)) continue;
    const payAtHotel = k.t === "3" && rt.ratePlan?.PrepaidIndicator !== true;
    if (payAtHotel && (env("MCP_PAY_AT_HOTEL") === "off" || sup.isOff("sabre_pay_at_hotel"))) continue;
    if (!(rc in rates)) rates[rc] = await fxRate(rc, cur || rc);
    if (!(rates[rc] > 0)) continue;
    // Free-cancellation deadline: Duffel lists full-refund dates in cancellation_timeline, RateHawk gives free_cancellation_before
    const free = [...(rt.cancellation_timeline || []).filter(c => parseFloat(c.refund_amount) >= net * 0.99).map(c => c.before),
      ...(rt.cancellation_time || []).map(c => c?.free_cancellation_before)].filter(t => Date.parse(t) > now).sort();
    const offerId = "tzh:" + crypto.randomBytes(12).toString("hex");
    // Pay at the hotel: the hotel's own price (no markup, nothing charged by us), converted without the FX buffer
    const total = payAtHotel ? Math.round(net * rates[rc] / (1 + (rc === (cur || rc) ? 0 : fxBuffer() / 100)) * 100) / 100 : hotelSell(net * rates[rc]);
    // net + currency = what the supplier charges; show = what the customer sees and pays in
    roomOffers.set(offerId, { at: now, hotelId: id, account: accountOf(k), rate_id: rateId, provider_type: k.t, net, currency: rc, show: cur || rc, payAtHotel, approx: total, stay: { checkin: stay.checkin, checkout: stay.checkout, adults: +stay.adults || 2, rooms: +stay.rooms || 1 }, room: rt.room_name });
    offers.push({
      offerId, mcp: true, supplier: SUPPLIER[k.t] || `type${k.t}`, mappedRoomId: null, payAtHotel,
      payAtHotelAmount: payAtHotel ? { amount: net, currency: rc } : null, // what the hotel will charge, in its currency
      name: [rt.room_name || "Room", rt.bed_type].filter(Boolean).join(" · "), board: BOARD[rt.board_type] || rt.board_type || rt.mealsIncluded?.MealPlanDescription || "Room only",
      total, currency: cur || rc, ssp: null, refundable: free.length > 0, cancelBy: free[free.length - 1] || null,
      // Anything the hotel collects at check-in (city tax etc.) on top of what we charge, in the currency it's collected in
      taxesExcluded: parseFloat(rt.due_at_accommodation_amount) > 0 ? [{ description: "Local taxes and fees", amount: parseFloat(rt.due_at_accommodation_amount), currency: String(rt.due_at_accommodation_currency || rc).toUpperCase() }] : [],
      taxesIncluded: [], cancelPolicy: [], hotelRemarks: [], nameFees: [], perks: [], publicTotal: total,
      remarks: rt.additional_fees_inclusive === false ? "Resort or other hotel fees may be charged by the hotel at check-in." : "",
    });
  }
  return offers.sort((a, b) => a.total - b.total);
}

function createMcp({ db, sendEmail, jwt, JWT_SECRET }) {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_bookings (
    ref TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payment_intent TEXT, amount REAL, currency TEXT, net REAL,
    offer_json TEXT, passengers_json TEXT, contact_json TEXT, supplier TEXT, supplier_booking_id TEXT, supplier_ref TEXT, error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // For My trips: who booked, their email, a readable name and the travel dates
  for (const col of ["user_id INTEGER", "email TEXT", "title TEXT", "start_date TEXT", "end_date TEXT"]) { try { db.exec(`ALTER TABLE mcp_bookings ADD COLUMN ${col}`); } catch { /* exists */ } }
  const uid = (req) => { try { return jwt && req ? jwt.verify(req.cookies?.token || "", JWT_SECRET).id || null : null; } catch { return null; } };
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const row = (ref) => db.prepare("SELECT * FROM mcp_bookings WHERE ref = ?").get(ref);
  const setRow = (ref, f) => { const k = Object.keys(f); db.prepare(`UPDATE mcp_bookings SET ${k.map(x => `${x} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE ref = ?`).run(...k.map(x => f[x]), ref); };
  const fail = (msg, status) => Object.assign(new Error(msg), { status });

  // Traveller from the checkout form → the passenger record Travellez expects (id comes from the live offer)
  function toPassenger(p, id, contact) {
    const gender = String(p.gender || "").toLowerCase().startsWith("f") ? "f" : "m";
    return {
      id, type: "adult", title: gender === "f" ? "ms" : "mr",
      given_name: [p.firstName, p.middleName].filter(Boolean).join(" ").trim(), family_name: String(p.lastName || "").trim(),
      email: contact.email, phone_number: contact.phone, born_on: p.birthday, gender,
      passport_number: p.documentNumber || undefined, passport_country: p.documentIssueCountry || undefined,
      passport_expiry: p.documentExpiry ? `${p.documentExpiry}T00:00:00.000Z` : undefined, nationality: p.nationality || undefined,
    };
  }

  async function hold(b, req) {
    if (!bookingOn()) throw fail("This fare can't be booked online yet.", 403);
    const o = unb64(String(b.offerId || "").replace(/^tz:/, ""));
    if (!o?.i || !o?.r) throw fail("Invalid offer", 400);
    if (sup.flightSourceOff(o.p)) throw fail("This fare is no longer available. Please search again.", 410);
    const pax = Array.isArray(b.passengers) ? b.passengers : [];
    const c = b.contact || {};
    const contact = { email: String(c.email || "").trim().toLowerCase(), phone: `+${String(c.phoneCountryCode || "1").replace(/\D/g, "")}${String(c.phoneNumber || "").replace(/\D/g, "")}` };
    if (!pax.length || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw fail("Traveller details are missing", 400);
    // Live price, passenger ids and expiry straight from the supplier
    const d = await mcp("/api/v2/flights/offer", { query: { offer_id: o.i, request_id: o.r, source: o.p } });
    if (!d.ok) throw fail(d.status === 404 ? "This fare has just expired. Please search again." : "We couldn't confirm this fare. Please search again.", 410);
    const off = d.json?.offer?.data || d.json?.offer || d.json?.data || {};
    const net = parseFloat(off.total_amount), netCur = String(off.total_currency || off.currency || "").toUpperCase();
    // Only Duffel hands out passenger ids; Mystifly and Sabre orders take the traveller details without one
    const ids = (off.passengers || []).map(x => x.id).filter(Boolean);
    const needIds = String(off.provider || o.p).toLowerCase() === "duffel";
    if (!(net > 0) || !netCur || (needIds && ids.length < pax.length)) throw fail("We couldn't confirm this fare. Please search again.", 410);
    // Charge in the currency the customer searched in (converted from the supplier's)
    const cur = String(o.c || netCur).toUpperCase(), rate = await fxRate(netCur, cur);
    if (!(rate > 0)) throw fail("We couldn't confirm this fare. Please search again.", 410);
    const price = sell(net * rate), ref = "FL-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const pi = await stripe().paymentIntents.create({
      amount: ZERO_DEC.has(cur) ? Math.round(price) : Math.round(price * 100), currency: cur.toLowerCase(), capture_method: "manual",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: `PlanurStay flight ${ref}`, receipt_email: contact.email, metadata: { type: "flight", ref, supplier: o.p },
    }, { idempotencyKey: `fl-${ref}` });
    const passengers = pax.map((p, i) => toPassenger(p, ids[i], contact));
    const sum = b.summary || {};
    db.prepare("INSERT INTO mcp_bookings (ref, kind, status, payment_intent, amount, currency, net, offer_json, passengers_json, contact_json, supplier, user_id, email, title, start_date, end_date) VALUES (?, 'flight', 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ref, pi.id, price, cur, net, JSON.stringify({ offer_id: o.i, offer_request_id: o.r, provider: off.provider || o.p, flight_type: o.t || "roundtrip", total_amount: String(off.total_amount), expires_at: off.expires_at, net_currency: netCur }), JSON.stringify(passengers), JSON.stringify(contact), o.p,
        uid(req), contact.email, String(sum.title || "Flight").slice(0, 120), day(sum.start), day(sum.end));
    return { prebookId: ref, transactionId: pi.id, secretKey: pi.client_secret, price, currency: cur, processor: "stripe", publishableKey: env("STRIPE_PUBLISHABLE_KEY"), expiresAt: off.expires_at || null };
  }

  const locks = new Set();
  async function book(refIn) {
    const ref = String(refIn || ""), r0 = row(ref);
    if (!r0) throw fail("Booking not found", 404);
    if (["confirmed", "pending_confirmation", "failed"].includes(r0.status)) return summary(r0);
    if (locks.has(ref)) throw fail("This booking is already being processed", 409);
    locks.add(ref);
    const s = stripe();
    try {
      const pi = await s.paymentIntents.retrieve(r0.payment_intent);
      if (pi.metadata?.ref !== ref) throw fail("Payment doesn't match this booking", 400);
      if (pi.status !== "requires_capture") throw fail("Your card hasn't been authorized yet", 402);
      const offer = JSON.parse(r0.offer_json), passengers = JSON.parse(r0.passengers_json);
      setRow(ref, { status: "booking" });
      const res = await mcp("/api/v2/flights/order", { method: "POST", timeoutMs: 120000, body: { ...offer, passengers, services: [], comment: `PlanurStay ${ref}` } }).catch(e => ({ ok: false, text: e.message }));
      const bookingId = res.ok ? (res.json?.booking_id || res.json?.flight_booking_id) : null;
      if (!bookingId) {
        await s.paymentIntents.cancel(pi.id).catch(e => console.warn("MCP flight PI cancel:", e.message));
        setRow(ref, { status: "failed", error: String(res.json?.detail || res.json?.message || res.text || "Booking failed").slice(0, 500) });
        console.warn("MCP flight order failed:", ref, res.status, (res.text || "").slice(0, 300));
        return summary(row(ref));
      }
      setRow(ref, { supplier_booking_id: String(bookingId) });
      let status = "pending", pnr = res.json?.confirmation_number || null;
      for (let i = 0; i < 6 && status !== "confirmed"; i++) {
        await new Promise(r => setTimeout(r, i === 0 ? 3000 : 3000));
        const v = await mcp(`/api/v2/flights/booking/${encodeURIComponent(bookingId)}`).catch(() => null);
        const bk = v?.json?.booking || v?.json || {};
        status = String(bk.booking_status || status).toLowerCase();
        pnr = bk.confirmation_number || bk.booking_reference || pnr;
        if (["failed", "cancelled", "canceled", "rejected"].includes(status)) break;
      }
      if (["failed", "cancelled", "canceled", "rejected"].includes(status)) {
        await s.paymentIntents.cancel(pi.id).catch(e => console.warn("MCP flight PI cancel:", e.message));
        setRow(ref, { status: "failed", error: `Airline status: ${status}` });
        return summary(row(ref));
      }
      // The order exists (confirmed, or still being ticketed): take the payment
      await s.paymentIntents.capture(pi.id);
      setRow(ref, { status: status === "confirmed" ? "confirmed" : "pending_confirmation", supplier_ref: pnr ? String(pnr) : null });
      mcp(`/api/v2/flights/booking/${encodeURIComponent(bookingId)}/email`, { method: "POST" }).catch(() => {}); // e-ticket
      notify(ref).catch(() => {});
      return summary(row(ref));
    } catch (e) {
      if (row(ref)?.status === "booking") setRow(ref, { status: "awaiting_payment" });
      throw e;
    } finally { locks.delete(ref); }
  }

  function summary(r) {
    if (!r) return null;
    const ok = r.status === "confirmed", failed = r.status === "failed";
    return {
      bookingId: r.ref, status: ok ? "CONFIRMED" : failed ? "FAILED" : "PENDING", bookingRef: r.supplier_ref || null, pnr: r.supplier_ref || null,
      price: r.amount, currency: r.currency, supplier: r.supplier,
      error: failed ? "The airline couldn't confirm this fare. The hold on your card has been released." : null,
    };
  }

  async function notify(ref) {
    const r = row(ref); if (!r || !sendEmail) return;
    const c = JSON.parse(r.contact_json || "{}"), p = JSON.parse(r.passengers_json || "[]");
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, x => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[x]));
    const money = (n, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n); } catch { return `${cur} ${n}`; } };
    await sendEmail({
      to: c.email, subject: `Flight booked: ${r.supplier_ref || r.ref}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0b1b3f"><div style="font-weight:800;font-size:18px;color:#1f5bff">PlanurStay</div>
        <h1 style="font-size:22px">${r.status === "confirmed" ? "Your flight is booked" : "We're confirming your flight"}</h1>
        <p>Airline reference: <b>${esc(r.supplier_ref || "coming by email")}</b><br>PlanurStay reference: <b>${esc(r.ref)}</b></p>
        <p>Travellers: ${p.map(x => esc(`${x.given_name} ${x.family_name}`)).join(", ")}</p>
        <p>Total paid: <b>${money(r.amount, r.currency)}</b></p>
        <p style="color:#4a5572;font-size:13px">Your e-ticket is sent separately. Check in with the airline using the airline reference.</p></div>`,
    });
    if (r.status !== "confirmed" && env("SUPPORT_EMAIL")) await sendEmail({ to: env("SUPPORT_EMAIL"), subject: `Flight needs checking: ${r.ref}`, html: `<p>MCP flight order ${esc(r.ref)} (${esc(r.supplier)}) wasn't confirmed within 20 seconds. Payment was captured. Please check it in Travellez.</p>` });
  }

  // ─── Hotels: pay upfront (hold → book through the MCP → charge, or release) ───
  async function holdHotel(b, req) {
    if (!hotelsOn() || !payOn()) throw fail("This room can't be booked online yet.", 403);
    const o = roomOffers.get(String(b.offerId || ""));
    if (!o || Date.now() - o.at > OFFER_TTL) throw fail("This price has expired. Please reload the hotel page to see the latest rooms.", 410);
    if (sup.hotelTypeOff(o.provider_type) || (o.payAtHotel && sup.isOff("sabre_pay_at_hotel"))) throw fail("This room is no longer available. Please choose another one.", 410);
    // Lock the latest price where the supplier supports it (some return an error for quotes: then the rate's price stands)
    let net = o.net;
    const q = await mcp("/api/v2/hotels/quote", { method: "POST", account: o.account, body: { rate_id: o.rate_id } }).catch(() => null);
    const qd = q?.ok && q.json?.success !== false ? (q.json?.quote?.data || q.json?.data || q.json?.quote || {}) : {};
    if (parseFloat(qd.total_amount) > 0 && String(qd.total_currency || o.currency).toUpperCase() === o.currency) net = parseFloat(qd.total_amount);
    const show = o.show || o.currency, rate = await fxRate(o.currency, show);
    if (!(rate > 0)) throw fail("This price has expired. Please reload the hotel page to see the latest rooms.", 410);
    if (o.payAtHotel) return holdPayAtHotel(o, net, show, b, req);
    const price = hotelSell(net * rate), ref = "HT-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const pi = await stripe().paymentIntents.create({
      amount: ZERO_DEC.has(show) ? Math.round(price) : Math.round(price * 100), currency: show.toLowerCase(), capture_method: "manual",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: `PlanurStay hotel ${ref}`, metadata: { type: "hotel", ref, supplier: SUPPLIER[o.provider_type] || o.provider_type },
    }, { idempotencyKey: `ht-${ref}` });
    const hotelName = hotelsSeen.get(o.hotelId)?.raw?.name || String(b.summary?.title || "Hotel stay");
    db.prepare("INSERT INTO mcp_bookings (ref, kind, status, payment_intent, amount, currency, net, offer_json, supplier, user_id, title, start_date, end_date) VALUES (?, 'hotel', 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ref, pi.id, price, show, net, JSON.stringify({ rate_id: o.rate_id, provider_type: o.provider_type, account: o.account, stay: o.stay, hotelId: o.hotelId, room: o.room, hotelName, net_currency: o.currency }), SUPPLIER[o.provider_type] || o.provider_type,
        uid(req), hotelName.slice(0, 120), day(o.stay.checkin), day(o.stay.checkout));
    return { prebookId: ref, transactionId: pi.id, secretKey: pi.client_secret, price, currency: show, processor: "stripe", publishableKey: env("STRIPE_PUBLISHABLE_KEY") };
  }

  // Pay at the hotel (Sabre guaranteed rates): nothing is charged. The guest's card is saved with Stripe (SetupIntent,
  // off-session) so PlanurStay can recover a no-show or late-cancellation fee the hotel charges to the company card
  // that guarantees the booking. Such fees are charged by staff from the Stripe dashboard (customer is tagged with the ref).
  async function holdPayAtHotel(o, net, show, b, req) {
    const ref = "HT-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const approx = o.approx ?? net;
    const s = stripe();
    const customer = await s.customers.create({ description: `PlanurStay pay-at-hotel ${ref}`, metadata: { ref, type: "hotel_guarantee" } }, { idempotencyKey: `htc-${ref}` });
    const si = await s.setupIntents.create({
      customer: customer.id, usage: "off_session", automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: `PlanurStay ${ref}: card guarantee for a pay-at-hotel booking (no-show / late cancellation only)`, metadata: { type: "hotel_guarantee", ref },
    }, { idempotencyKey: `hts-${ref}` });
    const hotelName = hotelsSeen.get(o.hotelId)?.raw?.name || String(b.summary?.title || "Hotel stay");
    db.prepare("INSERT INTO mcp_bookings (ref, kind, status, payment_intent, amount, currency, net, offer_json, supplier, user_id, title, start_date, end_date) VALUES (?, 'hotel', 'awaiting_payment', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ref, si.id, show, net, JSON.stringify({ rate_id: o.rate_id, provider_type: o.provider_type, account: o.account, stay: o.stay, hotelId: o.hotelId, room: o.room, hotelName, net_currency: o.currency,
        payAtHotel: true, approx, customer: customer.id }), SUPPLIER[o.provider_type] || o.provider_type, uid(req), hotelName.slice(0, 120), day(o.stay.checkin), day(o.stay.checkout));
    return { prebookId: ref, transactionId: si.id, secretKey: si.client_secret, price: 0, payAtHotel: true, payAtHotelAmount: { amount: net, currency: o.currency }, approx,
      currency: show, processor: "stripe", publishableKey: env("STRIPE_PUBLISHABLE_KEY") };
  }

  async function bookHotel(refIn, trav = {}) {
    const ref = String(refIn || ""), r0 = row(ref);
    if (!r0 || r0.kind !== "hotel") throw fail("Booking not found", 404);
    if (["confirmed", "pending_confirmation", "failed"].includes(r0.status)) return hotelSummary(r0);
    if (locks.has(ref)) throw fail("This booking is already being processed", 409);
    const t = {
      first_name: String(trav.firstName || "").trim().slice(0, 60), last_name: String(trav.lastName || "").trim().slice(0, 60),
      email: String(trav.email || "").trim().toLowerCase().slice(0, 120), phone: String(trav.phone || "").trim().slice(0, 30),
    };
    if (!t.first_name || !t.last_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.email)) throw fail("Guest details are missing", 400);
    if (!t.phone) t.phone = "+10000000000"; // phone is optional on PlanurStay; the supplier requires a value
    locks.add(ref);
    const s = stripe();
    try {
      const o = JSON.parse(r0.offer_json);
      const guarantee = o.payAtHotel && String(r0.payment_intent).startsWith("seti_");
      const pi = guarantee ? await s.setupIntents.retrieve(r0.payment_intent) : await s.paymentIntents.retrieve(r0.payment_intent);
      if (pi.metadata?.ref !== ref) throw fail("Payment doesn't match this booking", 400);
      if (pi.status !== (guarantee ? "succeeded" : "requires_capture")) throw fail(guarantee ? "Your card hasn't been saved yet" : "Your card hasn't been authorized yet", 402);
      setRow(ref, { status: "booking", contact_json: JSON.stringify(t), email: t.email });
      const res = await mcp("/api/v2/hotels/book", { method: "POST", timeoutMs: 120000, account: o.account, body: {
        rate_id: o.rate_id, provider_type: o.provider_type, amount: r0.net.toFixed(2), currency: o.net_currency || r0.currency,
        check_in: o.stay.checkin, check_out: o.stay.checkout, rooms: o.stay.rooms, guests: o.stay.adults, traveller: t, comment: `PlanurStay ${ref}`,
      } }).catch(e => ({ ok: false, text: e.message }));
      const bk = res.ok ? (res.json?.booking || res.json || {}) : {};
      const bookingId = res.ok ? (res.json?.booking_id || bk.booking_id || bk.id) : null;
      const st = String(bk.status || bk.booking_status || (bookingId ? "confirmed" : "failed")).toLowerCase();
      if (!bookingId || ["failed", "cancelled", "canceled", "rejected"].includes(st)) {
        if (guarantee) { if (pi.payment_method) await s.paymentMethods.detach(String(pi.payment_method)).catch(e => console.warn("MCP hotel card detach:", e.message)); }
        else await s.paymentIntents.cancel(pi.id).catch(e => console.warn("MCP hotel PI cancel:", e.message));
        setRow(ref, { status: "failed", error: String(res.json?.detail || res.json?.message || res.text || st).slice(0, 500) });
        console.warn("MCP hotel booking failed:", ref, res.status, (res.text || "").slice(0, 300));
        return hotelSummary(row(ref));
      }
      if (guarantee) {
        // Card stays saved for no-show / late-cancellation fees; tag the Stripe customer so staff can find it by ref
        await s.customers.update(o.customer, { email: t.email, name: `${t.first_name} ${t.last_name}`, invoice_settings: pi.payment_method ? { default_payment_method: String(pi.payment_method) } : undefined,
          metadata: { ref, type: "hotel_guarantee", hotel: String(o.hotelName || "").slice(0, 200), checkin: o.stay.checkin, checkout: o.stay.checkout, supplier_booking_id: String(bookingId) } }).catch(e => console.warn("Stripe customer update:", e.message));
      } else await s.paymentIntents.capture(pi.id);
      setRow(ref, { status: st === "confirmed" ? "confirmed" : "pending_confirmation", supplier_booking_id: String(bookingId), supplier_ref: String(bk.reference || bk.confirmation_number || bk.booking_reference || "") || null });
      notifyHotel(ref).catch(() => {});
      return hotelSummary(row(ref));
    } catch (e) {
      if (row(ref)?.status === "booking") setRow(ref, { status: "awaiting_payment" });
      throw e;
    } finally { locks.delete(ref); }
  }

  function hotelSummary(r) {
    const failed = r.status === "failed";
    const o = (() => { try { return JSON.parse(r.offer_json || "{}"); } catch { return {}; } })();
    return { bookingId: r.ref, status: r.status === "confirmed" ? "CONFIRMED" : failed ? "FAILED" : "PENDING", hotelConfirmationCode: r.supplier_ref || null,
      price: r.amount, currency: r.currency, supplier: r.supplier,
      ...(o.payAtHotel ? { payAtHotel: true, payAtHotelAmount: { amount: r.net, currency: o.net_currency }, approx: o.approx } : {}),
      error: failed ? (o.payAtHotel ? "The hotel couldn't confirm this room. Nothing was charged and your card wasn't kept." : "The hotel couldn't confirm this room. The hold on your card has been released.") : null };
  }

  async function notifyHotel(ref) {
    const r = row(ref); if (!r || !sendEmail) return;
    const c = JSON.parse(r.contact_json || "{}"), o = JSON.parse(r.offer_json || "{}");
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, x => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[x]));
    const money = (n, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n); } catch { return `${cur} ${n}`; } };
    const name = o.hotelName || hotelsSeen.get(o.hotelId)?.raw?.name || "your hotel";
    await sendEmail({ to: c.email, subject: `Hotel booked: ${name}, ${o.stay?.checkin}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0b1b3f"><div style="font-weight:800;font-size:18px;color:#1f5bff">PlanurStay</div>
        <h1 style="font-size:22px">${r.status === "confirmed" ? "Your room is booked" : "We're confirming your room"}</h1>
        <p><b>${esc(name)}</b>${o.room ? ` · ${esc(o.room)}` : ""}<br>${esc(o.stay?.checkin)} – ${esc(o.stay?.checkout)}</p>
        <p>Guest: ${esc(c.first_name)} ${esc(c.last_name)}<br>PlanurStay reference: <b>${esc(r.ref)}</b>${r.supplier_ref ? `<br>Hotel confirmation: <b>${esc(r.supplier_ref)}</b>` : ""}</p>
        ${o.payAtHotel
          ? `<p><b>Pay at the hotel:</b> ${money(r.net, o.net_currency)} (about ${money(o.approx, r.currency)}), charged by the hotel in its own currency. Nothing was charged by PlanurStay.</p>
             <p style="color:#555;font-size:13px">Your card is kept on file only to cover a no-show or late-cancellation fee under the hotel's cancellation policy.</p>`
          : `<p>Total paid: <b>${money(r.amount, r.currency)}</b></p>`}</div>` });
  }

  function register(app) {
    // MCP-only hotels (ids start with "tz-"): hotel page, rooms and bookings. Other ids fall through to LiteAPI.
    app.get("/api/hotels/:id", async (req, res, next) => {
      if (!String(req.params.id).startsWith("tz-")) return next();
      try { const d = await hotelDetails(req.params.id, { checkin: req.query.checkin, checkout: req.query.checkout }); if (!d) return res.status(404).json({ error: "Hotel not found" }); res.json(d); }
      catch (e) { res.status(500).json({ error: "Server error" }); }
    });
    // No LiteAPI highlights or reviews for MCP-only hotels: answer with the empty shapes the hotel page expects
    app.get("/api/hotels/:id/highlights", (req, res, next) => String(req.params.id).startsWith("tz-") ? res.json({ success: true, data: null }) : next());
    app.get("/api/hotels/:id/reviews", (req, res, next) => String(req.params.id).startsWith("tz-") ? res.json({ success: true, data: { reviews: [], types: [] } }) : next());
    app.post("/api/mcp/hotels/hold", async (req, res) => {
      try { res.json({ success: true, data: await holdHotel(req.body || {}, req) }); }
      catch (e) { if (!e.status) console.warn("MCP hotel hold:", e.message); res.status(e.status || 502).json({ error: e.status ? e.message : "We couldn't hold this room. Please try again." }); }
    });
    app.post("/api/mcp/hotels/book", async (req, res) => {
      try { res.json({ success: true, data: await bookHotel(req.body?.ref, req.body?.traveller) }); }
      catch (e) { if (!e.status) console.warn("MCP hotel book:", e.message); res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong while booking. If your card was charged, contact us with your reference." }); }
    });
    app.get("/api/mcp/status", (req, res) => res.json({ success: true, connected: connected(), flights: flightsOn(), hotels: hotelsOn(), booking: payOn() }));
    app.post("/api/mcp/flights/hold", async (req, res) => {
      try { res.json({ success: true, data: await hold(req.body || {}, req) }); }
      catch (e) { if (!e.status) console.warn("MCP flight hold:", e.message); res.status(e.status || 502).json({ error: e.status ? e.message : "We couldn't hold this fare. Please try again." }); }
    });
    app.post("/api/mcp/flights/book", async (req, res) => {
      try { res.json({ success: true, data: await book(req.body?.ref) }); }
      catch (e) { if (!e.status) console.warn("MCP flight book:", e.message); res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong while booking. If your card was charged, contact us with your reference." }); }
    });
  }
  return { register };
}

module.exports = { fxRates, usePhotoSource, fillPhotos, mcpCall: mcp, mcpConnected: connected, createMcp, searchFlights, mergeJourneys, toJourney, signature, searchHotels, mergeHotels, hotelRooms, _state: { flightsOn, bookingOn, hotelsOn, hotelsVisible } };
