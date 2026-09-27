/**
 * Car rentals through Travellez (Sabre inventory).
 *
 * How the money moves:
 *   1. The customer pays PlanurStay by card (Stripe). We only authorize (hold) the amount first.
 *   2. We book the car on Travellez with PlanurStay's own Travellez account; Travellez charges the
 *      company card saved on that account (the net price).
 *   3. Booking confirmed → we capture the customer's payment. Booking failed → we release the hold.
 *   Our margin is CAR_MARKUP_PCT (default 8%) on top of the Travellez price.
 *
 *   GET  /api/cars/config              → { enabled, bookingEnabled, publishableKey }
 *   POST /api/cars/search              { pickupCode, returnCode, pickupDate, pickupTime, returnDate, returnTime }
 *   POST /api/cars/checkout            { quoteId, driver } → { ref, clientSecret, amount, currency }
 *   POST /api/cars/book                { ref } (after the card is authorized) → booking result
 *   GET  /api/cars/booking/:ref        → booking summary (confirmation page)
 *
 * Env: TRAVELLEZ_EMAIL, TRAVELLEZ_PASSWORD (PlanurStay's Travellez account), TRAVELLEZ_API_BASE_URL,
 *      TRAVELLEZ_CARD_ID (optional; default = first saved card), CAR_MARKUP_PCT, CARS_BOOKING_ENABLED=true,
 *      STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY.
 * There is no Travellez test environment: bookings stay off until CARS_BOOKING_ENABLED=true.
 */
const crypto = require("crypto");

function createCars({ db, sendEmail }) {
  const env = (k) => String(process.env[k] || "").trim();
  const base = () => (env("TRAVELLEZ_API_BASE_URL") || "https://api.travellez.com").replace(/\/$/, "");
  const searchOn = () => !!(env("TRAVELLEZ_EMAIL") && env("TRAVELLEZ_PASSWORD"));
  const bookingOn = () => searchOn() && env("CARS_BOOKING_ENABLED") === "true" && !!env("STRIPE_SECRET_KEY") && !!env("STRIPE_PUBLISHABLE_KEY");
  const markup = () => { const m = parseFloat(env("CAR_MARKUP_PCT")); return Number.isFinite(m) && m >= 0 && m <= 50 ? m : 8; };
  const stripe = () => (env("STRIPE_SECRET_KEY") ? require("stripe")(env("STRIPE_SECRET_KEY")) : null);

  db.exec(`CREATE TABLE IF NOT EXISTS car_bookings (
    ref TEXT PRIMARY KEY, status TEXT NOT NULL, payment_intent TEXT, amount REAL, currency TEXT, net REAL,
    quote_json TEXT, driver_json TEXT, travellez_booking_id TEXT, travellez_car_id TEXT, supplier_ref TEXT, error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  // ─── Travellez session (one PlanurStay account; token re-used until it expires) ───
  let token = null, tokenExp = 0, loggingIn = null;
  const jwtExp = (t) => { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).exp * 1000 || 0; } catch { return 0; } };
  const headers = (t) => ({ accept: "application/json", "content-type": "application/json", origin: "https://launch.travellez.com", referer: "https://launch.travellez.com/", ...(t ? { authorization: `Bearer ${t}` } : {}) });
  async function login() {
    const r = await fetch(`${base()}/auth/login`, { method: "POST", headers: headers(), body: JSON.stringify({ email: env("TRAVELLEZ_EMAIL"), password: env("TRAVELLEZ_PASSWORD") }), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Travellez login failed (${r.status})`);
    token = j.access_token; tokenExp = jwtExp(token) || Date.now() + 50 * 60 * 1000;
    return token;
  }
  async function getToken(force) {
    if (!force && token && Date.now() < tokenExp - 5 * 60 * 1000) return token;
    loggingIn = loggingIn || login().finally(() => { loggingIn = null; });
    return loggingIn;
  }
  // One call to Travellez; logs in again once if the token was rejected.
  async function tz(path, { method = "GET", body, params, timeoutMs = 90000 } = {}) {
    const url = `${base()}${path}${params ? "?" + new URLSearchParams(params) : ""}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await getToken(attempt > 0);
      const r = await fetch(url, { method, headers: headers(t), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 401 && attempt === 0) continue;
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { ok: r.ok, status: r.status, json, text };
    }
  }

  // ─── Quotes: the Sabre rate key and net price stay on the server; the browser only gets a quote id ───
  const quotes = new Map(); // quoteId → quote
  const QUOTE_TTL = 29 * 60 * 1000; // Travellez/Sabre hold a car rate for about 30 minutes
  const sweep = () => { const now = Date.now(); for (const [k, q] of quotes) if (now - q.at > QUOTE_TTL) quotes.delete(k); };
  const ZERO_DEC = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XOF", "XAF", "PYG", "RWF"]);
  const sell = (net) => Math.ceil(net * (1 + markup() / 100) * 100) / 100;

  // ACRISS car code (e.g. "CDAR") → words people understand
  const CAT = { M: "Mini", N: "Mini elite", E: "Economy", H: "Economy elite", C: "Compact", D: "Compact elite", I: "Intermediate", J: "Intermediate elite", S: "Standard", R: "Standard elite", F: "Full-size", G: "Full-size elite", P: "Premium", U: "Premium elite", L: "Luxury", W: "Luxury elite", O: "Oversize", X: "Special" };
  const BODY = { B: "2-door", C: "2/4-door", D: "4-door", W: "Wagon", V: "Van", L: "Limousine", S: "Sport", T: "Convertible", F: "SUV", J: "Off-road", X: "Special", P: "Pickup", Q: "Pickup", Z: "Special offer", E: "Coupe", M: "Minivan", R: "Recreational", H: "Motor home", Y: "2-wheeler", N: "Roadster", G: "Crossover", K: "Commercial van" };
  const acriss = (code = "") => {
    const c = String(code).toUpperCase();
    const FUEL = { D: "Diesel", Q: "Diesel", H: "Hybrid", I: "Hybrid", E: "Electric", C: "Electric", L: "LPG", S: "LPG", A: "Hydrogen", B: "Hydrogen", M: "Multi-fuel", F: "Multi-fuel", V: "Petrol", Z: "Petrol", U: "Ethanol", X: "Ethanol" };
    return { fuel: FUEL[c[3]] || null, category: CAT[c[0]] || null, body: BODY[c[1]] || null, automatic: ["A", "B", "D"].includes(c[2]) ? true : ["M", "N", "C"].includes(c[2]) ? false : null, ac: c[3] ? !["N", "Q", "X", "S", "C", "E", "H", "I", "K", "L"].includes(c[3]) : null };
  };
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

  function toCar(raw, ctx) {
    const rate = (raw.VehRentalRate || [])[0]; if (!rate) return null;
    const v = rate.Vehicle || {}, vendor = raw.Vendor || {};
    let net = null, base = null, currency = null, mileage = null;
    for (const ch of rate.VehicleCharges?.VehicleCharge || []) {
      if (ch.ChargeType === "ApproximateTotalPrice") { net = num(ch.Amount); currency = ch.CurrencyCode || currency; }
      else if (ch.ChargeType === "BaseRateTotal") { base = num(ch.Amount); currency = currency || ch.CurrencyCode; mileage = ch.MileageAllowance || mileage; }
    }
    if (net == null) net = base;
    if (!net || net <= 0 || !rate.RateKey) return null;
    const sb = v.SeatBeltsAndBagsInfo || {};
    const bags = (sb.BagsInfo?.Bags || []).reduce((a, b) => a + (parseInt(b.Quantity) || 0), 0) || null;
    const info = acriss(v.VehType);
    const quoteId = crypto.randomBytes(12).toString("hex");
    const days = Math.max(1, Math.ceil((Date.parse(`${ctx.returnDate}T${ctx.returnTime}`) - Date.parse(`${ctx.pickupDate}T${ctx.pickupTime}`)) / 86400000));
    const price = sell(net);
    const car = {
      quoteId, vendor: vendor.Name || vendor.Code || "Car rental", vendorCode: vendor.Code || null, logo: /^https:\/\//.test(vendor.Logo || "") ? vendor.Logo : null,
      model: v.VehMakeAndModel || "Standard vehicle", code: v.VehType || null, ...info,
      doors: num(v.VehNumOfDoors), seats: num(sb.SeatBelts?.Quantity), bags,
      unlimitedMileage: !mileage || /^unl/i.test(String(mileage)), pickup: raw.PickUpLocation?.LocationCode || ctx.pickupCode, dropoff: raw.ReturnLocation?.LocationCode || ctx.returnCode,
      price, perDay: Math.round(price / days * 100) / 100, currency: currency || "USD", days,
      expiresAt: new Date(Date.now() + QUOTE_TTL).toISOString(),
      // Order summary like Travellez: our markup sits in the base fare; taxes and charges are shown as they are
      breakdown: base != null && base < net ? { base: Math.round((price - (net - base)) * 100) / 100, chargesTax: Math.round((net - base) * 100) / 100 } : null,
    };
    quotes.set(quoteId, { at: Date.now(), net, rateKey: rate.RateKey, rateCode: rate.RateCode, ctx, car });
    return car;
  }

  const code3 = (v) => (/^[A-Za-z]{3}$/.test(String(v || "")) ? String(v).toUpperCase() : null);
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const time = (v) => (/^\d{2}:\d{2}$/.test(String(v || "")) ? String(v) : null);

  async function search(b) {
    const ctx = { pickupCode: code3(b.pickupCode), returnCode: code3(b.returnCode) || code3(b.pickupCode), pickupDate: day(b.pickupDate), returnDate: day(b.returnDate), pickupTime: time(b.pickupTime) || "10:00", returnTime: time(b.returnTime) || "10:00" };
    if (!ctx.pickupCode || !ctx.pickupDate || !ctx.returnDate) throw Object.assign(new Error("Choose a pickup airport and dates"), { status: 400 });
    if (Date.parse(`${ctx.returnDate}T${ctx.returnTime}`) <= Date.parse(`${ctx.pickupDate}T${ctx.pickupTime}`)) throw Object.assign(new Error("Drop-off must be after pick-up"), { status: 400 });
    if (Date.parse(ctx.pickupDate) < Date.now() - 86400000) throw Object.assign(new Error("Pick-up date is in the past"), { status: 400 });
    sweep();
    const payload = { pickup_date: ctx.pickupDate, return_date: ctx.returnDate, pickup_time: ctx.pickupTime, return_time: ctx.returnTime, pickup_location_code: ctx.pickupCode, return_location_code: ctx.returnCode };
    const cars = [];
    for (let page = 1; page <= 3; page++) {
      const r = await tz("/vehicle/car-search", { method: "POST", body: payload, params: { page, page_size: 100, sort_by: "price_asc" } });
      if (!r.ok) { if (page === 1) { console.warn("Travellez car search:", r.status, (r.text || "").slice(0, 300)); throw Object.assign(new Error("Car search is unavailable right now. Please try again."), { status: 502 }); } break; }
      const av = r.json?.available_cars || {};
      for (const raw of av.data || []) { const c = toCar(raw, ctx); if (c) cars.push(c); }
      if (page >= (av.pagination?.total_pages || 1)) break;
    }
    return { cars: cars.sort((a, b) => a.price - b.price), ctx, markupPct: markup() };
  }

  // ─── Booking ───
  function row(ref) { return db.prepare("SELECT * FROM car_bookings WHERE ref = ?").get(ref); }
  function setRow(ref, fields) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE car_bookings SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE ref = ?`).run(...keys.map(k => fields[k]), ref);
  }
  const cleanDriver = (d = {}) => ({
    firstName: String(d.firstName || "").trim().slice(0, 60), lastName: String(d.lastName || "").trim().slice(0, 60),
    email: String(d.email || "").trim().toLowerCase().slice(0, 120), phone: String(d.phone || "").trim().slice(0, 30),
    dob: day(d.dob), gender: /^[mf]$/i.test(d.gender || "") ? d.gender.toLowerCase() : null,
    note: String(d.note || "").replace(/\s+/g, " ").trim().slice(0, 300),
  });
  function driverError(d, pickupDate) {
    if (!d.firstName || !d.lastName) return "Enter the driver's name as on their licence";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return "Enter a valid email";
    if (d.phone.replace(/\D/g, "").length < 7) return "Enter a valid phone number";
    if (!d.dob) return "Enter the driver's date of birth";
    const age = (Date.parse(pickupDate) - Date.parse(d.dob)) / (365.25 * 86400000);
    if (age < 21) return "The driver must be at least 21 at pick-up";
    if (!d.gender) return "Select the driver's gender";
    return null;
  }

  async function checkout(b) {
    if (!bookingOn()) throw Object.assign(new Error("Car booking isn't open yet."), { status: 403 });
    const q = quotes.get(String(b.quoteId || ""));
    if (!q || Date.now() - q.at > QUOTE_TTL) throw Object.assign(new Error("This price has expired. Please search again."), { status: 410 });
    const d = cleanDriver(b.driver);
    const err = driverError(d, q.ctx.pickupDate); if (err) throw Object.assign(new Error(err), { status: 400 });
    const ref = "CAR-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const cur = q.car.currency.toUpperCase();
    const amount = ZERO_DEC.has(cur) ? Math.round(q.car.price) : Math.round(q.car.price * 100);
    const pi = await stripe().paymentIntents.create({
      amount, currency: cur.toLowerCase(), capture_method: "manual",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: `PlanurStay car rental ${ref}: ${q.car.vendor} ${q.car.model}, ${q.ctx.pickupCode} ${q.ctx.pickupDate}–${q.ctx.returnDate}`,
      receipt_email: d.email, metadata: { type: "car", ref },
    }, { idempotencyKey: `car-${ref}` });
    db.prepare("INSERT INTO car_bookings (ref, status, payment_intent, amount, currency, net, quote_json, driver_json) VALUES (?, 'awaiting_payment', ?, ?, ?, ?, ?, ?)")
      .run(ref, pi.id, q.car.price, cur, q.net, JSON.stringify({ rateKey: q.rateKey, rateCode: q.rateCode, ctx: q.ctx, car: q.car }), JSON.stringify(d));
    return { ref, clientSecret: pi.client_secret, amount: q.car.price, currency: cur };
  }

  async function companyCard() {
    if (env("TRAVELLEZ_CARD_ID")) return env("TRAVELLEZ_CARD_ID");
    const r = await tz("/users/stripe/cards");
    const list = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
    const card = list.find(c => c.is_default || c.default) || list[0];
    if (!card?.id) throw new Error("No company card saved on the PlanurStay Travellez account");
    return card.id;
  }

  const locks = new Set();
  async function book(refIn) {
    const ref = String(refIn || "");
    const r0 = row(ref); if (!r0) throw Object.assign(new Error("Booking not found"), { status: 404 });
    if (["confirmed", "pending_confirmation", "failed"].includes(r0.status)) return summary(r0);
    if (locks.has(ref)) throw Object.assign(new Error("This booking is already being processed"), { status: 409 });
    locks.add(ref);
    const s = stripe();
    try {
      const pi = await s.paymentIntents.retrieve(r0.payment_intent);
      if (pi.metadata?.ref !== ref) throw Object.assign(new Error("Payment doesn't match this booking"), { status: 400 });
      if (pi.status !== "requires_capture") throw Object.assign(new Error("Your card hasn't been authorized yet"), { status: 402 });
      const q = JSON.parse(r0.quote_json), d = JSON.parse(r0.driver_json);
      setRow(ref, { status: "booking" });
      let res;
      try {
        const cardId = await companyCard();
        res = await tz("/vehicle/booking", { method: "POST", timeoutMs: 120000, body: {
          first_name: d.firstName, last_name: d.lastName, email: d.email, phone_number: d.phone, date_of_birth: d.dob, gender: d.gender,
          phone_user_type: "B", additional_note: `PlanurStay ${ref}${d.note ? ` · ${d.note}` : ""}`, rateId: q.rateKey, payment_token: cardId, requested_by_comment: "",
          in_policy: true, is_personal: true, is_redeemed: false,
          pick_up_date: q.ctx.pickupDate, pick_up_time: q.ctx.pickupTime, return_date: q.ctx.returnDate, return_time: q.ctx.returnTime,
          rate_code: q.rateCode, image: "",
        } });
      } catch (e) { res = { ok: false, status: 0, text: e.message }; }
      const bookingId = res.ok ? res.json?.booking_id : null;
      if (!bookingId) {
        // Nothing was booked: release the customer's hold
        await s.paymentIntents.cancel(pi.id).catch(e => console.warn("Car PI cancel:", e.message));
        setRow(ref, { status: "failed", error: String(res.json?.message || res.json?.detail || res.text || "Booking failed").slice(0, 500) });
        console.warn("Travellez car booking failed:", ref, res.status, (res.text || "").slice(0, 300));
        return summary(row(ref));
      }
      setRow(ref, { travellez_booking_id: String(bookingId), travellez_car_id: res.json?.car_id ? String(res.json.car_id) : null });
      // Wait for the supplier to confirm (Travellez processes bookings asynchronously)
      let status = "pending", supplierRef = null;
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, i === 0 ? 4000 : 3000));
        const v = await tz(`/booking/cab/${encodeURIComponent(bookingId)}`).catch(() => null);
        status = String(v?.json?.booking_status || status).toLowerCase();
        supplierRef = v?.json?.booking_reference || supplierRef;
        if (["confirmed", "failed", "cancelled", "canceled", "rejected"].includes(status)) break;
      }
      if (["failed", "cancelled", "canceled", "rejected"].includes(status)) {
        await s.paymentIntents.cancel(pi.id).catch(e => console.warn("Car PI cancel:", e.message));
        setRow(ref, { status: "failed", error: `Supplier status: ${status}` });
        return summary(row(ref));
      }
      // A booking exists (confirmed, or still being confirmed by the supplier): take the payment
      await s.paymentIntents.capture(pi.id);
      const final = status === "confirmed" ? "confirmed" : "pending_confirmation";
      setRow(ref, { status: final, supplier_ref: supplierRef ? String(supplierRef) : null });
      notify(ref).catch(() => {});
      return summary(row(ref));
    } catch (e) {
      if (row(ref)?.status === "booking") setRow(ref, { status: "awaiting_payment" });
      throw e;
    } finally { locks.delete(ref); }
  }

  function summary(r) {
    if (!r) return null;
    const q = JSON.parse(r.quote_json || "{}"), d = JSON.parse(r.driver_json || "{}");
    return { ref: r.ref, status: r.status, amount: r.amount, currency: r.currency, supplierRef: r.supplier_ref, car: q.car, ctx: q.ctx,
      driver: { firstName: d.firstName, lastName: d.lastName, email: d.email }, error: r.status === "failed" ? "The rental company couldn't confirm this car. You have not been charged." : null };
  }

  async function notify(ref) {
    const s = summary(row(ref)); if (!s || !sendEmail) return;
    const money = (n, c) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n); } catch { return `${c} ${n}`; } };
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0b1b3f">
      <div style="font-weight:800;font-size:18px;color:#1f5bff">PlanurStay</div>
      <h1 style="font-size:22px">${s.status === "confirmed" ? "Your car is booked" : "We're confirming your car"}</h1>
      <p><b>${esc(s.car.vendor)}</b> · ${esc(s.car.model)}${s.car.category ? ` (${esc(s.car.category)})` : ""}</p>
      <p>Pick-up: <b>${esc(s.ctx.pickupCode)}</b>, ${esc(s.ctx.pickupDate)} at ${esc(s.ctx.pickupTime)}<br>Drop-off: <b>${esc(s.ctx.returnCode)}</b>, ${esc(s.ctx.returnDate)} at ${esc(s.ctx.returnTime)}</p>
      <p>Driver: ${esc(s.driver.firstName)} ${esc(s.driver.lastName)}<br>PlanurStay reference: <b>${esc(s.ref)}</b>${s.supplierRef ? `<br>Rental confirmation: <b>${esc(s.supplierRef)}</b>` : ""}</p>
      <p>Total paid: <b>${money(s.amount, s.currency)}</b></p>
      <p style="color:#4a5572;font-size:13px">Bring the driver's licence, a credit card in the driver's name and this reference to the rental desk. ${s.status === "confirmed" ? "" : "The rental company is still confirming; we'll email you as soon as it's done."}</p></div>`;
    await sendEmail({ to: s.driver.email, subject: `Car rental ${s.status === "confirmed" ? "confirmed" : "received"}: ${s.car.vendor}, ${s.ctx.pickupCode} ${s.ctx.pickupDate}`, html });
    if (s.status !== "confirmed" && env("SUPPORT_EMAIL")) await sendEmail({ to: env("SUPPORT_EMAIL"), subject: `Car booking needs checking: ${s.ref}`, html: `<p>Travellez booking for ${esc(s.ref)} wasn't confirmed within 20 seconds. Payment was captured. Please check it in Travellez.</p>` });
  }

  function register(app) {
    app.get("/api/cars/config", (req, res) => res.json({ success: true, enabled: searchOn(), bookingEnabled: bookingOn(), publishableKey: bookingOn() ? env("STRIPE_PUBLISHABLE_KEY") : null }));
    app.post("/api/cars/search", async (req, res) => {
      if (!searchOn()) return res.status(503).json({ error: "Car rentals aren't available yet." });
      try { res.json({ success: true, data: await search(req.body || {}) }); }
      catch (e) { if (!e.status) console.warn("Car search:", e.message); res.status(e.status || 502).json({ error: e.status ? e.message : "Car search is unavailable right now. Please try again." }); }
    });
    app.post("/api/cars/checkout", async (req, res) => {
      try { res.json({ success: true, data: await checkout(req.body || {}) }); }
      catch (e) { if (!e.status) console.warn("Car checkout:", e.message); res.status(e.status || 500).json({ error: e.status ? e.message : "We couldn't start the payment. Please try again." }); }
    });
    app.post("/api/cars/book", async (req, res) => {
      try { res.json({ success: true, data: await book(req.body?.ref) }); }
      catch (e) { if (!e.status) console.warn("Car book:", e.message); res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong while booking. If your card was charged, contact us with your reference." }); }
    });
    app.get("/api/cars/booking/:ref", (req, res) => {
      const s = summary(row(String(req.params.ref)));
      if (!s) return res.status(404).json({ error: "Booking not found" });
      res.json({ success: true, data: s });
    });
  }
  return { register, _test: { toCar, acriss, sell, quotes } };
}

module.exports = { createCars };
