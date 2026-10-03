/**
 * Car rentals through Travellez (Sabre inventory).
 *
 * How the money moves:
 *   1. The customer pays PlanurStay by card (Stripe). We only authorize (hold) the amount first.
 *   2. We book the car on Travellez with PlanurStay's own Travellez account; Travellez charges the
 *      company card saved on that account (the net price).
 *   3. Booking confirmed → we capture the customer's payment. Booking failed → we release the hold.
 *   Our margin is CAR_MARKUP_PCT (default 3%) on top of the Travellez price.
 *   Cancellation (like Rentalcars / Discover Cars): free until CAR_FREE_CANCEL_HOURS (default 48) before pick-up,
 *   no refund after that or for no-shows. Travellez refunds us until pick-up, so late cancellations don't cost us.
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

function createCars({ db, sendEmail, jwt, JWT_SECRET }) {
  const env = (k) => String(process.env[k] || "").trim();
  const base = () => (env("TRAVELLEZ_API_BASE_URL") || "https://api.travellez.com").replace(/\/$/, "");
  // Off when switched off in /admin (supplier close-out): the Cars page and menu link disappear
  const searchOn = () => !!(env("TRAVELLEZ_EMAIL") && env("TRAVELLEZ_PASSWORD")) && !require("./suppliers").isOff("sabre_cars");
  // With the Travellez MCP connected, cars go through it like flights and hotels (CARS_VIA=direct keeps the old route)
  const mcpMod = require("./mcp");
  const viaMcp = () => mcpMod.mcpConnected() && env("CARS_VIA") !== "direct";
  // How cars are paid. "counter" (default): Sabre pay-at-pick-up rates; we reserve and the customer pays the rental
  // company at the desk, so there's no markup and no card charge on PlanurStay. "prepay": we charge the customer
  // (price + CAR_MARKUP_PCT) through Stripe; only for rates Travellez actually prepays.
  const payMode = () => (env("CARS_PAYMENT") === "prepay" ? "prepay" : "counter");
  const bookingOn = () => searchOn() && env("CARS_BOOKING_ENABLED") === "true" && (payMode() === "counter" || (!!env("STRIPE_SECRET_KEY") && !!env("STRIPE_PUBLISHABLE_KEY")));
  // Vendors that pay us commission (Sabre vendor codes). Economy Rent a Car (EY) is the confirmed one.
  const commissionVendors = () => new Set((env("CAR_COMMISSION_VENDORS") || "EY").split(",").map(v => v.trim().toUpperCase()).filter(Boolean));
  const markup = () => { const m = parseFloat(env("CAR_MARKUP_PCT")); return Number.isFinite(m) && m >= 0 && m <= 50 ? m : 3; };
  const cancelHours = () => { const h = parseInt(env("CAR_FREE_CANCEL_HOURS")); return Number.isFinite(h) && h >= 0 && h <= 240 ? h : 48; };
  // Free-cancellation deadline in the pick-up location's local time ("YYYY-MM-DD HH:MM"), or null if pick-up is too soon.
  // Pick-up times are local to the airport, so we compare using the airport-local clock we were given.
  function cancelDeadline(ctx) {
    const [y, mo, d] = ctx.pickupDate.split("-").map(Number), [h, mi] = ctx.pickupTime.split(":").map(Number);
    const t = Date.UTC(y, mo - 1, d, h, mi) - cancelHours() * 3600000;
    const x = new Date(t), p = (n) => String(n).padStart(2, "0");
    const local = `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
    // Without the airport's time zone, treat "now" generously (UTC−10, the latest North American clock) so we never
    // promise free cancellation that has already passed locally.
    return t > Date.now() - 10 * 3600000 ? local : null;
  }
  const stripe = () => (env("STRIPE_SECRET_KEY") ? require("stripe")(env("STRIPE_SECRET_KEY")) : null);

  db.exec(`CREATE TABLE IF NOT EXISTS car_bookings (
    ref TEXT PRIMARY KEY, status TEXT NOT NULL, payment_intent TEXT, amount REAL, currency TEXT, net REAL,
    quote_json TEXT, driver_json TEXT, travellez_booking_id TEXT, travellez_car_id TEXT, supplier_ref TEXT, error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  try { db.exec("ALTER TABLE car_bookings ADD COLUMN user_id INTEGER"); } catch { /* exists */ }
  const uid = (req) => { try { return jwt && req ? jwt.verify(req.cookies?.token || "", JWT_SECRET).id || null : null; } catch { return null; } };
  const fraud = require("./fraud").init({ db, sendEmail });

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
  const sell = (net) => (payMode() === "counter" ? net : Math.ceil(net * (1 + markup() / 100) * 100) / 100);

  // ACRISS car code (e.g. "CDAR") → words people understand
  const CAT = { M: "Mini", N: "Mini elite", E: "Economy", H: "Economy elite", C: "Compact", D: "Compact elite", I: "Intermediate", J: "Intermediate elite", S: "Standard", R: "Standard elite", F: "Full-size", G: "Full-size elite", P: "Premium", U: "Premium elite", L: "Luxury", W: "Luxury elite", O: "Oversize", X: "Special" };
  const BODY = { B: "2-door", C: "2/4-door", D: "4-door", W: "Wagon", V: "Van", L: "Limousine", S: "Sport", T: "Convertible", F: "SUV", J: "Off-road", X: "Special", P: "Pickup", Q: "Pickup", Z: "Special offer", E: "Coupe", M: "Minivan", R: "Recreational", H: "Motor home", Y: "2-wheeler", N: "Roadster", G: "Crossover", K: "Commercial van" };
  const acriss = (code = "") => {
    const c = String(code).toUpperCase();
    const FUEL = { D: "Diesel", Q: "Diesel", H: "Hybrid", I: "Hybrid", E: "Electric", C: "Electric", L: "LPG", S: "LPG", A: "Hydrogen", B: "Hydrogen", M: "Multi-fuel", F: "Multi-fuel", V: "Petrol", Z: "Petrol", U: "Ethanol", X: "Ethanol" };
    return { fuel: FUEL[c[3]] || null, category: CAT[c[0]] || null, body: BODY[c[1]] || null, automatic: ["A", "B", "D"].includes(c[2]) ? true : ["M", "N", "C"].includes(c[2]) ? false : null, ac: c[3] ? !["N", "Q", "X", "S", "C", "E", "H", "I", "K", "L"].includes(c[3]) : null };
  };
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

  // One car card from either source (Sabre fields straight from Travellez, or the MCP's simplified list)
  function makeCar(c, ctx) {
    const { net, base = null, currency, mileage, rateKey, rateCode } = c;
    if (!net || net <= 0 || !rateKey) return null;
    const info = acriss(c.vehType);
    const quoteId = crypto.randomBytes(12).toString("hex");
    const days = Math.max(1, Math.ceil((Date.parse(`${ctx.returnDate}T${ctx.returnTime}`) - Date.parse(`${ctx.pickupDate}T${ctx.pickupTime}`)) / 86400000));
    const price = sell(net);
    const car = {
      quoteId, vendor: c.vendorName || c.vendorCode || "Car rental", vendorCode: c.vendorCode || null, logo: /^https:\/\//.test(c.logo || "") ? c.logo : null,
      model: c.model || "Standard vehicle", code: c.vehType || null, ...info,
      doors: num(c.doors), seats: num(c.seats) >= 2 ? num(c.seats) : null, bags: c.bags || null, // Sabre sometimes sends 1 seat: unknown
      unlimitedMileage: !mileage || /^unl/i.test(String(mileage)), pickup: c.pickup || ctx.pickupCode, dropoff: c.dropoff || ctx.returnCode,
      price, perDay: Math.round(price / days * 100) / 100, currency: currency || "USD", days,
      expiresAt: new Date(Date.now() + QUOTE_TTL).toISOString(),
      payAtPickup: payMode() === "counter",
      commission: commissionVendors().has(String(c.vendorCode || "").toUpperCase()),
      freeCancelUntil: payMode() === "counter" ? null : cancelDeadline(ctx), freeCancelHours: cancelHours(),
      // Order summary like Travellez: our markup sits in the base fare; taxes and charges are shown as they are
      breakdown: base != null && base < net ? { base: Math.round((price - (net - base)) * 100) / 100, chargesTax: Math.round((net - base) * 100) / 100 } : null,
    };
    quotes.set(quoteId, { at: Date.now(), net, rateKey, rateCode, ctx, car });
    return car;
  }

  // Raw Sabre car from Travellez
  function toCar(raw, ctx) {
    const rate = (raw.VehRentalRate || [])[0]; if (!rate) return null;
    const v = rate.Vehicle || {}, vendor = raw.Vendor || {};
    let net = null, base = null, currency = null, mileage = null;
    for (const ch of rate.VehicleCharges?.VehicleCharge || []) {
      if (ch.ChargeType === "ApproximateTotalPrice") { net = num(ch.Amount); currency = ch.CurrencyCode || currency; }
      else if (ch.ChargeType === "BaseRateTotal") { base = num(ch.Amount); currency = currency || ch.CurrencyCode; mileage = ch.MileageAllowance || mileage; }
    }
    const sb = v.SeatBeltsAndBagsInfo || {};
    return makeCar({ net: net ?? base, base, currency, mileage, rateKey: rate.RateKey, rateCode: rate.RateCode, vendorName: vendor.Name, vendorCode: vendor.Code, logo: vendor.Logo,
      vehType: v.VehType, model: v.VehMakeAndModel, doors: v.VehNumOfDoors, seats: sb.SeatBelts?.Quantity,
      bags: (sb.BagsInfo?.Bags || []).reduce((a, bg) => a + (parseInt(bg.Quantity) || 0), 0) || null,
      pickup: raw.PickUpLocation?.LocationCode, dropoff: raw.ReturnLocation?.LocationCode }, ctx);
  }

  // Car from the MCP's /api/v2/cars/search (the agent's simplified list)
  function toCarFromMcp(c, ctx) {
    const bags = Array.isArray(c.bags) ? c.bags.reduce((a, bg) => a + (parseInt(bg?.Quantity ?? bg?.quantity) || 0), 0) || null : num(c.bags);
    return makeCar({ net: num(c.total_price) ?? num(c.base_rate), base: num(c.base_rate), currency: c.currency, mileage: c.mileage, rateKey: c.rate_key, rateCode: c.rate_code,
      vendorName: c.vendor_name, vendorCode: c.vendor_code, logo: c.vendor_logo, vehType: c.vehicle_type, model: c.vehicle_model, doors: c.doors, seats: c.seats, bags,
      pickup: c.pickup_location, dropoff: c.return_location }, ctx);
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
    if (viaMcp()) {
      const r = await mcpMod.mcpCall("/api/v2/cars/search", { method: "POST", timeoutMs: 90000, body: {
        pickup_date: ctx.pickupDate, return_date: ctx.returnDate, pickup_time: ctx.pickupTime, return_time: ctx.returnTime,
        pickup_location_code: ctx.pickupCode, return_location_code: ctx.returnCode } }).catch(e => ({ ok: false, text: e.message }));
      if (!r.ok) { console.warn("MCP car search:", r.status, (r.text || "").slice(0, 300)); throw Object.assign(new Error("Car search is unavailable right now. Please try again."), { status: 502 }); }
      for (const c of r.json?.results || []) { const car = toCarFromMcp(c, ctx); if (car) cars.push(car); }
      return { cars: (await forDisplay(cars, b.currency)).sort((a, b) => a.price - b.price), ctx, payment: payMode() };
    }
    for (let page = 1; page <= 3; page++) {
      const r = await tz("/vehicle/car-search", { method: "POST", body: payload, params: { page, page_size: 100, sort_by: "price_asc" } });
      if (!r.ok) { if (page === 1) { console.warn("Travellez car search:", r.status, (r.text || "").slice(0, 300)); throw Object.assign(new Error("Car search is unavailable right now. Please try again."), { status: 502 }); } break; }
      const av = r.json?.available_cars || {};
      for (const raw of av.data || []) { const c = toCar(raw, ctx); if (c) cars.push(c); }
      if (page >= (av.pagination?.total_pages || 1)) break;
    }
    return { cars: (await forDisplay(cars, b.currency)).sort((a, b) => a.price - b.price), ctx, payment: payMode() };
  }

  // Pay at pick-up: vendors quote in different currencies (USD, CAD…), so the list shows an approximate price in the
  // visitor's currency (today's rate, no buffer) plus what the counter will charge. The stored quote keeps the real amount.
  async function forDisplay(cars, currency) {
    const to = String(currency || "").toUpperCase();
    if (payMode() !== "counter" || !/^[A-Z]{3}$/.test(to)) return cars;
    const rates = await mcpMod.fxRates().catch(() => null);
    const conv = (n, r) => n == null ? n : Math.round(n * r * 100) / 100;
    return cars.map(c => {
      const from = String(c.currency || "").toUpperCase(), r = from === to ? 1 : rates?.[from] && rates?.[to] ? rates[to] / rates[from] : null;
      if (!r || from === to) return c;
      return { ...c, price: conv(c.price, r), perDay: conv(c.perDay, r), currency: to, counterPrice: c.price, counterCurrency: from,
        breakdown: c.breakdown ? { base: conv(c.breakdown.base, r), chargesTax: conv(c.breakdown.chargesTax, r) } : null };
    });
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

  async function checkout(b, req) {
    if (!bookingOn() || payMode() !== "prepay") throw Object.assign(new Error("Car booking isn't open yet."), { status: 403 });
    const q = quotes.get(String(b.quoteId || ""));
    if (!q || Date.now() - q.at > QUOTE_TTL) throw Object.assign(new Error("This price has expired. Please search again."), { status: 410 });
    const d = cleanDriver(b.driver);
    const err = driverError(d, q.ctx.pickupDate); if (err) throw Object.assign(new Error(err), { status: 400 });
    const ref = "CAR-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const cur = q.car.currency.toUpperCase();
    const amount = ZERO_DEC.has(cur) ? Math.round(q.car.price) : Math.round(q.car.price * 100);
    const chk = await fraud.preCheck({ req, amount: q.car.price, currency: cur, email: d.email, userId: uid(req) });
    const pi = await stripe().paymentIntents.create({
      amount, currency: cur.toLowerCase(), capture_method: "manual",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" }, ...fraud.holdOptions(chk.threeDs),
      description: `PlanurStay car rental ${ref}: ${q.car.vendor} ${q.car.model}, ${q.ctx.pickupCode} ${q.ctx.pickupDate}–${q.ctx.returnDate}`,
      receipt_email: d.email, metadata: { type: "car", ref },
    }, { idempotencyKey: `car-${ref}` });
    db.prepare("INSERT INTO car_bookings (ref, status, payment_intent, amount, currency, net, quote_json, driver_json, user_id) VALUES (?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?)")
      .run(ref, pi.id, q.car.price, cur, q.net, JSON.stringify({ rateKey: q.rateKey, rateCode: q.rateCode, ctx: q.ctx, car: q.car }), JSON.stringify(d), uid(req));
    fraud.tag("car_bookings", ref, req, d.email);
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

  // Book the car on Travellez and wait for the supplier's answer. Returns { status, bookingId, supplierRef, error }.
  async function placeBooking(ref, q, d) {
    if (viaMcp()) return placeBookingMcp(ref, q, d);
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
      console.warn("Travellez car booking failed:", ref, res.status, (res.text || "").slice(0, 300));
      return { status: "failed", error: String(res.json?.message || res.json?.detail || res.text || "Booking failed").slice(0, 500) };
    }
    setRow(ref, { travellez_booking_id: String(bookingId), travellez_car_id: res.json?.car_id ? String(res.json.car_id) : null });
    // Travellez processes bookings asynchronously: wait for the supplier to confirm
    let status = "pending", supplierRef = null;
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 4000 : 3000));
      const v = await tz(`/booking/cab/${encodeURIComponent(bookingId)}`).catch(() => null);
      status = String(v?.json?.booking_status || status).toLowerCase();
      supplierRef = v?.json?.booking_reference || supplierRef;
      if (["confirmed", "failed", "cancelled", "canceled", "rejected"].includes(status)) break;
    }
    if (["failed", "cancelled", "canceled", "rejected"].includes(status)) return { status: "failed", bookingId, error: `Supplier status: ${status}` };
    return { status: status === "confirmed" ? "confirmed" : "pending_confirmation", bookingId, supplierRef };
  }

  // Same booking through the MCP's /api/v2/cars (it picks the account's saved card itself)
  async function placeBookingMcp(ref, q, d) {
    const res = await mcpMod.mcpCall("/api/v2/cars/book", { method: "POST", timeoutMs: 120000, body: {
      rate_key: q.rateKey, rate_code: q.rateCode, note: `PlanurStay ${ref}${d.note ? ` · ${d.note}` : ""}`,
      driver: { first_name: d.firstName, last_name: d.lastName, email: d.email, phone: d.phone, born_on: d.dob, gender: d.gender },
      pick_up_date: q.ctx.pickupDate, pick_up_time: q.ctx.pickupTime, return_date: q.ctx.returnDate, return_time: q.ctx.returnTime,
    } }).catch(e => ({ ok: false, text: e.message }));
    const bookingId = res.ok ? res.json?.booking_id : null;
    if (!bookingId) {
      console.warn("MCP car booking failed:", ref, res.status, (res.text || "").slice(0, 300));
      return { status: "failed", error: String(res.json?.detail || res.json?.message || res.text || "Booking failed").slice(0, 500) };
    }
    setRow(ref, { travellez_booking_id: String(bookingId), travellez_car_id: res.json?.car_id ? String(res.json.car_id) : null });
    let status = "pending", supplierRef = null;
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 4000 : 3000));
      const v = await mcpMod.mcpCall(`/api/v2/cars/booking/${encodeURIComponent(bookingId)}`).catch(() => null);
      status = String(v?.json?.booking_status || v?.json?.booking?.booking_status || status).toLowerCase();
      supplierRef = v?.json?.booking_reference || v?.json?.booking?.booking_reference || supplierRef;
      if (["confirmed", "failed", "cancelled", "canceled", "rejected"].includes(status)) break;
    }
    if (["failed", "cancelled", "canceled", "rejected"].includes(status)) return { status: "failed", bookingId, error: `Supplier status: ${status}` };
    return { status: status === "confirmed" ? "confirmed" : "pending_confirmation", bookingId, supplierRef };
  }

  // Pay at pick-up: reserve only. Nothing is charged on PlanurStay.
  async function reserve(b, req) {
    if (!bookingOn() || payMode() !== "counter") throw Object.assign(new Error("Car booking isn't open yet."), { status: 403 });
    const q = quotes.get(String(b.quoteId || ""));
    if (!q || Date.now() - q.at > QUOTE_TTL) throw Object.assign(new Error("This price has expired. Please search again."), { status: 410 });
    const d = cleanDriver(b.driver);
    const err = driverError(d, q.ctx.pickupDate); if (err) throw Object.assign(new Error(err), { status: 400 });
    if (q.reservedRef) return summary(row(q.reservedRef)); // double-click / retry: same reservation
    const ref = "CAR-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    q.reservedRef = ref;
    db.prepare("INSERT INTO car_bookings (ref, status, payment_intent, amount, currency, net, quote_json, driver_json, user_id) VALUES (?, 'booking', NULL, ?, ?, ?, ?, ?, ?)")
      .run(ref, q.car.price, q.car.currency.toUpperCase(), q.net, JSON.stringify({ rateKey: q.rateKey, rateCode: q.rateCode, ctx: q.ctx, car: q.car }), JSON.stringify(d), uid(req));
    const out = await placeBooking(ref, q, d);
    setRow(ref, { status: out.status, supplier_ref: out.supplierRef ? String(out.supplierRef) : null, error: out.error || null });
    if (out.status === "failed") q.reservedRef = null; // let them try again or pick another car
    else notify(ref).catch(() => {});
    return summary(row(ref));
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
      // Card risk check (fraud.js): a risky card is released and nothing is booked
      const rv = await fraud.review(s, pi, { ref, kind: "Car", table: "car_bookings" });
      if (!rv.ok) {
        await s.paymentIntents.cancel(pi.id).catch(e => console.warn("Car PI cancel:", e.message));
        setRow(ref, { status: "failed", error: "Payment review: " + rv.reason });
        return summary(row(ref));
      }
      const q = JSON.parse(r0.quote_json), d = JSON.parse(r0.driver_json);
      setRow(ref, { status: "booking" });
      const out = await placeBooking(ref, q, d);
      if (out.status === "failed") {
        // Nothing was booked (or the supplier rejected it): release the customer's hold
        await s.paymentIntents.cancel(pi.id).catch(e => console.warn("Car PI cancel:", e.message));
        setRow(ref, { status: "failed", error: out.error });
        return summary(row(ref));
      }
      const status = out.status === "confirmed" ? "confirmed" : "pending", supplierRef = out.supplierRef;
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
    const counter = !r.payment_intent;
    return { ref: r.ref, status: r.status, amount: r.amount, currency: r.currency, supplierRef: r.supplier_ref, car: q.car, ctx: q.ctx, freeCancelUntil: q.car?.freeCancelUntil || null, payAtPickup: counter,
      driver: { firstName: d.firstName, lastName: d.lastName, email: d.email }, error: r.status === "failed" ? String(r.error || "").startsWith("Payment review:") ? fraud.REVIEW_MSG : `The rental company couldn't confirm this car.${counter ? "" : " You have not been charged."}` : null };
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
      ${s.payAtPickup
        ? `<p><b>Nothing to pay now.</b> Pay the rental company at pick-up: approximately <b>${money(s.amount, s.currency)}</b> including mandatory taxes and fees. Extras (fuel, insurance, extra drivers) are charged at the desk.</p>
      <p>Cancel free any time before pick-up by replying to this email with your reference. If you don't cancel and don't pick up the car, the rental company's no-show rules apply.</p>`
        : `<p>Total paid: <b>${money(s.amount, s.currency)}</b></p>
      <p>${s.freeCancelUntil ? `<b>Free cancellation until ${esc(s.freeCancelUntil)}</b> (local time at pick-up). After that, or if you don't pick up the car, there's no refund.` : "<b>This booking is non-refundable</b> because pick-up is less than 48 hours away."} To cancel, reply to this email with your reference.</p>`}
      <p style="color:#4a5572;font-size:13px">Bring the driver's licence, a credit card in the driver's name and this reference to the rental desk. ${s.status === "confirmed" ? "" : "The rental company is still confirming; we'll email you as soon as it's done."}</p></div>`;
    await sendEmail({ to: s.driver.email, subject: `Car rental ${s.status === "confirmed" ? "confirmed" : "received"}: ${s.car.vendor}, ${s.ctx.pickupCode} ${s.ctx.pickupDate}`, html });
    if (s.status !== "confirmed" && env("SUPPORT_EMAIL")) await sendEmail({ to: env("SUPPORT_EMAIL"), subject: `Car booking needs checking: ${s.ref}`, html: `<p>Travellez booking for ${esc(s.ref)} wasn't confirmed within 20 seconds.${s.payAtPickup ? "" : " Payment was captured."} Please check it in Travellez.</p>` });
  }

  function register(app) {
    app.get("/api/cars/config", (req, res) => res.json({ success: true, enabled: searchOn(), bookingEnabled: bookingOn(), payment: payMode(), publishableKey: bookingOn() && payMode() === "prepay" ? env("STRIPE_PUBLISHABLE_KEY") : null }));
    app.post("/api/cars/reserve", async (req, res) => {
      try { res.json({ success: true, data: await reserve(req.body || {}, req) }); }
      catch (e) { if (!e.status) console.warn("Car reserve:", e.message); res.status(e.status || 500).json({ error: e.status ? e.message : "We couldn't reserve this car. Please try again." }); }
    });
    app.post("/api/cars/search", async (req, res) => {
      if (!searchOn()) return res.status(503).json({ error: "Car rentals aren't available yet." });
      try { res.json({ success: true, data: await search(req.body || {}) }); }
      catch (e) { if (!e.status) console.warn("Car search:", e.message); res.status(e.status || 502).json({ error: e.status ? e.message : "Car search is unavailable right now. Please try again." }); }
    });
    app.post("/api/cars/checkout", async (req, res) => {
      try { res.json({ success: true, data: await checkout(req.body || {}, req) }); }
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
