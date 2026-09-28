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
 *      MCP_FLIGHT_MARKUP_PCT (default 3), MCP_SEARCH_TIMEOUT_MS (default 25000).
 */
const crypto = require("crypto");

const env = (k) => String(process.env[k] || "").trim();
const base = () => env("TRAVELLEZ_MCP_URL").replace(/\/$/, "");
const connected = () => !!(base() && env("TRAVELLEZ_EMAIL") && env("TRAVELLEZ_PASSWORD"));
const flightsOn = () => connected() && ["on", "preview"].includes(env("MCP_FLIGHTS"));
const bookingOn = () => flightsOn() && env("MCP_BOOKING") === "on" && !!env("STRIPE_SECRET_KEY") && !!env("STRIPE_PUBLISHABLE_KEY");
const markup = () => { const m = parseFloat(env("MCP_FLIGHT_MARKUP_PCT")); return Number.isFinite(m) && m >= 0 && m <= 30 ? m : 3; };
const stripe = () => require("stripe")(env("STRIPE_SECRET_KEY"));
const ZERO_DEC = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XOF", "XAF", "PYG", "RWF"]);

// ─── MCP session: one login, reused until the MCP says it expired ───
let token = null, loggingIn = null;
async function login() {
  const r = await fetch(`${base()}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: env("TRAVELLEZ_EMAIL"), password: env("TRAVELLEZ_PASSWORD") }), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`MCP login failed (${r.status})`);
  token = j.access_token;
  return token;
}
async function getToken(force) {
  if (token && !force) return token;
  loggingIn = loggingIn || login().finally(() => { loggingIn = null; });
  return loggingIn;
}
async function mcp(path, { method = "GET", body, query, timeoutMs = 60000 } = {}) {
  const url = `${base()}${path}${query ? "?" + new URLSearchParams(query) : ""}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getToken(attempt > 0);
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 401 && attempt === 0) continue;
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  }
}

// ─── Travellez flight offer → PlanurStay journey (the shape the results page and checkout already use) ───
const minutesOf = (iso) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(String(iso || "")) || []; return (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0); };
const localMs = (t) => Date.parse(String(t || "").slice(0, 19) + "Z"); // wall-clock time at the airport
const sell = (net) => Math.ceil(net * (1 + markup() / 100) * 100) / 100;
const logo = (code) => code ? `https://assets.duffel.com/img/airlines/for-light-background/full-color-logo/${encodeURIComponent(code)}.svg` : null;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = (s) => { try { return JSON.parse(Buffer.from(String(s), "base64url").toString()); } catch { return null; } };

function toJourney(f, requestId, flightType, currency) {
  const fare = (f.all_fares || [])[0] || {};
  const net = parseFloat(fare.total_amount);
  if (!(net > 0) || !f.id) return null;
  if (currency && fare.currency && String(fare.currency).toUpperCase() !== String(currency).toUpperCase()) return null;
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
        direction: dir, departureTime: String(s.departure_time || "").slice(0, 19), arrivalTime: String(s.arrival_time || "").slice(0, 19),
        originCode: s.origin?.iata_code, destinationCode: s.destination?.iata_code, originName: s.origin?.name || s.origin?.city_name, destinationName: s.destination?.name || s.destination?.city_name,
        duration: minutes ? { minutes } : undefined, flight: { marketingNumber: String(s.flight_number || "") }, segmentKey: `${f.id}-${li}-${si}`,
        carrier: { marketingCode: al.iata_code, marketingName: al.name || al.iata_code, marketingLogo: logo(al.iata_code), operatingCode: op.iata_code, operatingName: op.name },
      });
      const next = segs[si + 1];
      if (next) {
        const gap = Math.round((localMs(next.departure_time) - localMs(s.arrival_time)) / 60000);
        connections.push({
          direction: dir, duration: { minutes: Math.max(0, gap) }, overnight: String(s.arrival_time).slice(0, 10) !== String(next.departure_time).slice(0, 10),
          changeAirport: s.destination?.iata_code !== next.origin?.iata_code,
          arrivalAirportCode: s.destination?.iata_code, arrivalAirportName: s.destination?.name, arrivalTime: s.arrival_time,
          departureAirportCode: next.origin?.iata_code, departureAirportName: next.origin?.name, departureTime: next.departure_time,
        });
      }
    });
    // Leg time from the supplier; otherwise flight times + layovers (both time-zone safe)
    const legMin = minutesOf(trip.duration) || (segs.every(x => minutesOf(x.duration))
      ? segs.reduce((t, x, k) => t + minutesOf(x.duration) + (segs[k + 1] ? Math.max(0, Math.round((localMs(segs[k + 1].departure_time) - localMs(x.arrival_time)) / 60000)) : 0), 0) : 0);
    legDurations.push({ direction: dir, duration: { minutes: Math.max(0, legMin) } });
  });
  if (!segments.length) return null;
  const c = fare.fare_conditions || {};
  const price = sell(net);
  const offer = {
    offerId: "tz:" + b64({ i: f.id, r: requestId, p: f.provider || "duffel", t: flightType }),
    expiration: null, supplier: f.provider || "duffel",
    pricing: { display: { total: price, currency: fare.currency, perPassenger: { adult: { total: null } } } },
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
    const d = r.json || {};
    return (d.results || []).map(f => toJourney(f, d.request_id, d.flight_type || (legs.length === 2 ? "roundtrip" : "oneway"), currency)).filter(Boolean);
  } catch (e) { console.warn("MCP flight search:", e.message); return []; }
}

function createMcp({ db, sendEmail }) {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_bookings (
    ref TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payment_intent TEXT, amount REAL, currency TEXT, net REAL,
    offer_json TEXT, passengers_json TEXT, contact_json TEXT, supplier TEXT, supplier_booking_id TEXT, supplier_ref TEXT, error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
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

  async function hold(b) {
    if (!bookingOn()) throw fail("This fare can't be booked online yet.", 403);
    const o = unb64(String(b.offerId || "").replace(/^tz:/, ""));
    if (!o?.i || !o?.r) throw fail("Invalid offer", 400);
    const pax = Array.isArray(b.passengers) ? b.passengers : [];
    const c = b.contact || {};
    const contact = { email: String(c.email || "").trim().toLowerCase(), phone: `+${String(c.phoneCountryCode || "1").replace(/\D/g, "")}${String(c.phoneNumber || "").replace(/\D/g, "")}` };
    if (!pax.length || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw fail("Traveller details are missing", 400);
    // Live price, passenger ids and expiry straight from the supplier
    const d = await mcp("/api/v2/flights/offer", { query: { offer_id: o.i, request_id: o.r, source: o.p } });
    if (!d.ok) throw fail(d.status === 404 ? "This fare has just expired. Please search again." : "We couldn't confirm this fare. Please search again.", 410);
    const off = d.json?.offer?.data || d.json?.offer || d.json?.data || {};
    const net = parseFloat(off.total_amount), cur = String(off.total_currency || off.currency || "").toUpperCase();
    const ids = (off.passengers || []).map(x => x.id).filter(Boolean);
    if (!(net > 0) || !cur || ids.length < pax.length) throw fail("We couldn't confirm this fare. Please search again.", 410);
    const price = sell(net), ref = "FL-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const pi = await stripe().paymentIntents.create({
      amount: ZERO_DEC.has(cur) ? Math.round(price) : Math.round(price * 100), currency: cur.toLowerCase(), capture_method: "manual",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: `PlanurStay flight ${ref}`, receipt_email: contact.email, metadata: { type: "flight", ref, supplier: o.p },
    }, { idempotencyKey: `fl-${ref}` });
    const passengers = pax.map((p, i) => toPassenger(p, ids[i], contact));
    db.prepare("INSERT INTO mcp_bookings (ref, kind, status, payment_intent, amount, currency, net, offer_json, passengers_json, contact_json, supplier) VALUES (?, 'flight', 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ref, pi.id, price, cur, net, JSON.stringify({ offer_id: o.i, offer_request_id: o.r, provider: o.p, flight_type: o.t || "roundtrip", total_amount: String(off.total_amount), expires_at: off.expires_at }), JSON.stringify(passengers), JSON.stringify(contact), o.p);
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

  function register(app) {
    app.get("/api/mcp/status", (req, res) => res.json({ success: true, connected: connected(), flights: flightsOn(), booking: bookingOn() }));
    app.post("/api/mcp/flights/hold", async (req, res) => {
      try { res.json({ success: true, data: await hold(req.body || {}) }); }
      catch (e) { if (!e.status) console.warn("MCP flight hold:", e.message); res.status(e.status || 502).json({ error: e.status ? e.message : "We couldn't hold this fare. Please try again." }); }
    });
    app.post("/api/mcp/flights/book", async (req, res) => {
      try { res.json({ success: true, data: await book(req.body?.ref) }); }
      catch (e) { if (!e.status) console.warn("MCP flight book:", e.message); res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong while booking. If your card was charged, contact us with your reference." }); }
    });
  }
  return { register };
}

module.exports = { createMcp, searchFlights, mergeJourneys, toJourney, signature, _state: { flightsOn, bookingOn } };
