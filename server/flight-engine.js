/**
 * Flight Booking Engine — Nuitee LiteAPI flight checkout flow
 *
 * Flow:
 *   1. POST /api/flights/search     → search flights (rates)
 *   2. POST /api/flights/prebook    → create prebook (reserves offer + payment intent)
 *   3. POST /api/flights/prebook/services → attach seats/baggage (optional)
 *   4. POST /api/flights/book       → complete booking
 *
 * Features:
 *   - Uber Vouchers via addons field in prebook
 *   - Idempotency guard (check DB before booking)
 *   - Retry logic on transient errors (502/503/timeout)
 *   - Voucher code support
 *   - Seat/baggage service attachment
 *   - Credit line / payment bypass support
 */

const Database = require("better-sqlite3");

function apiKeyEnv() {
  return require("./modules/api-key").liteApiKey() || null;
}

function bookBaseUrl() {
  return !require("./modules/api-key").isSandbox()
    ? "https://book.liteapi.travel/v3.0"
    : "https://sandbox.book.liteapi.travel/v3.0";
}

function apiBaseUrl() {
  return "https://api.liteapi.travel/v3.0";
}

function liteFetch(path, body, method = "POST", useApiHost = false) {
  // /flights/prebooks goes to api.liteapi.travel
  // /flights/bookings goes to book.liteapi.travel (POST) or api.liteapi.travel (GET by id)
  // /flights/rates goes to api.liteapi.travel
  const toBookHost = path.startsWith("/flights/bookings") && method === "POST" && !path.includes("/bookings/");
  const toApiHost = path.startsWith("/flights/prebooks") || path.startsWith("/flights/rates") || path.startsWith("/flights/bookings/");
  const url = ((useApiHost || toApiHost) && !toBookHost ? apiBaseUrl() : bookBaseUrl()) + path;
  // Flight prebook can be slow in sandbox — use 60s timeout
  // Prebooks and multi-airline searches can be slow; give them longer than simple lookups
  const timeoutMs = path.startsWith("/flights/prebooks") || path.startsWith("/flights/rates") ? 60000 : 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    method,
    signal: controller.signal,
    headers: {
      "X-API-Key": apiKeyEnv() || "",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(res => {
    clearTimeout(timer);
    return res.json().then(json => ({ ok: res.ok, status: res.status, json }));
  }).catch(err => {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { ok: false, status: 408, json: { error: { code: 408, message: "Request timeout" } } };
    }
    throw err;
  });
}

function firstError(body) {
  if (body && body.error) {
    return {
      code:    body.error.code,
      message: body.error.message,
      detail:  body.error.description || body.error.message,
      key:     body.error.key,
    };
  }
  return null;
}

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isTransient = !err.status || (err.status >= 500 && err.status < 600);
      if (!isTransient || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`Flight engine: transient error, retry ${attempt}/${maxAttempts} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function ensureFlightSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flight_prebooks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER,
      prebook_id    TEXT UNIQUE NOT NULL,
      offer_id      TEXT NOT NULL,
      currency      TEXT,
      total_amount  REAL,
      transaction_id TEXT,
      secret_key    TEXT,
      payment_types TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS flight_bookings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER,
      booking_id       TEXT UNIQUE,
      prebook_id       TEXT,
      liteapi_booking_ref TEXT,
      status           TEXT,
      currency         TEXT,
      total_amount     REAL,
      passenger_count  INTEGER,
      journey_key      TEXT,
      segments_json    TEXT,
      services_json    TEXT,
      addons_json      TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
}

async function searchFlights(body) {
  if (!body.legs || body.legs.length === 0) {
    return { success: false, error: { code: 400, message: "legs required", key: "bodyRequest.legs" } };
  }
  for (let i = 0; i < body.legs.length; i++) {
    const leg = body.legs[i];
    if (!leg.origin)     return { success: false, error: { code: 400, message: `Leg ${i+1} missing origin`, key: `bodyRequest.legs[${i}].origin` } };
    if (!leg.destination) return { success: false, error: { code: 400, message: `Leg ${i+1} missing destination`, key: `bodyRequest.legs[${i}].destination` } };
    if (!leg.date)        return { success: false, error: { code: 400, message: `Leg ${i+1} missing date`, key: `bodyRequest.legs[${i}].date` } };
  }

  const payload = {
    legs:     body.legs,
    adults:   body.adults || 1,
    currency: body.currency || "USD",
    country:  body.country || "US",
  };

  const result = await liteFetch("/flights/rates", payload, "POST", true);
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Flight search failed", detail: result.json };
    return { success: false, error: err };
  }
  return { success: true, data: result.json };
}

async function createPrebook(body, userId = null, db) {
  const required = ["offerId", "contact", "passengers"];
  for (const field of required) {
    if (!body[field]) {
      return { success: false, error: { code: 43001, message: `Missing required field: ${field}`, key: `bodyRequest.${field}` } };
    }
  }
  if (!body.contact.email || !body.contact.email.includes("@")) {
    return { success: false, error: { code: 400, message: "Valid contact email required", key: "bodyRequest.contact.email" } };
  }
  if (!body.contact.phoneNumber) {
    return { success: false, error: { code: 400, message: "Phone number required", key: "bodyRequest.contact.phoneNumber" } };
  }
  if (!Array.isArray(body.passengers) || body.passengers.length === 0) {
    return { success: false, error: { code: 400, message: "At least one passenger is required", key: "bodyRequest.passengers" } };
  }
  for (let i = 0; i < body.passengers.length; i++) {
    const p = body.passengers[i];
    if (!p.firstName || !p.lastName) {
      return { success: false, error: { code: 400, message: `Passenger ${i+1} missing name`, key: `bodyRequest.passengers[${i}].firstName` } };
    }
    if (!p.birthday) {
      return { success: false, error: { code: 400, message: `Passenger ${i+1} missing birthday`, key: `bodyRequest.passengers[${i}].birthday` } };
    }
    if (!p.documentNumber) {
      return { success: false, error: { code: 400, message: `Passenger ${i+1} missing documentNumber`, key: `bodyRequest.passengers[${i}].documentNumber` } };
    }
    if (!p.gender) {
      p.gender = 'M';
    } else if (p.gender === 'MALE') {
      p.gender = 'M';
    } else if (p.gender === 'FEMALE') {
      p.gender = 'F';
    }
  }

  // Normalize passenger fields to LiteAPI expected values
  const normalizedPassengers = body.passengers.map(p => {
    const np = { ...p };
    if (!np.gender) {
      np.gender = 'M';
    } else if (np.gender === 'MALE') {
      np.gender = 'M';
    } else if (np.gender === 'FEMALE') {
      np.gender = 'F';
    }
    if (!np.documentType) {
      np.documentType = 'passport';
    } else {
      np.documentType = np.documentType.toLowerCase();
    }
    if (!np.nationality) {
      np.nationality = 'US';
    }
    if (!np.documentIssueCountry) {
      np.documentIssueCountry = 'US';
    }
    if (!np.documentExpiry) {
      np.documentExpiry = '2030-12-31';
    }
    // Map documentExpiration → documentExpiry if provided under wrong name
    if (p.documentExpiration && !np.documentExpiry) {
      np.documentExpiry = p.documentExpiration;
    }
    // Ensure phone has country code
    if (body.contact && body.contact.phoneNumber) {
      const ph = body.contact.phoneNumber;
      if (!ph.startsWith('+') && !ph.startsWith('00')) {
        body.contact.phoneNumber = '+1' + ph.replace(/^\D+/g, '');
      }
    }
    if (body.contact && body.contact.phoneCountryCode) {
      const cc = String(body.contact.phoneCountryCode).replace(/\D/g, '');
      if (cc) body.contact.phoneCountryCode = cc;
    }
    // Ensure phoneCountryCode is set on contact
    if (body.contact && !body.contact.phoneCountryCode) {
      body.contact.phoneCountryCode = '1';
    }
    return np;
  });

  const prebookPayload = {
    offerId:       body.offerId,
    usePaymentSdk: body.usePaymentSdk !== false,
    contact:       body.contact,
    passengers:    normalizedPassengers,
  };
  if (body.includeCreditBalance) prebookPayload.includeCreditBalance = true;
  if (body.travelPurpose)        prebookPayload.travelPurpose = body.travelPurpose;
  if (body.voucherCode)          prebookPayload.voucherCode = body.voucherCode;
  if (body.payment)              prebookPayload.payment = body.payment;
  if (body.addons && Array.isArray(body.addons) && body.addons.length > 0) {
    prebookPayload.addons = body.addons;
  }

  let result;
  try {
    result = await withRetry(async () => {
      const r = await liteFetch("/flights/prebooks", prebookPayload);
      if (!r.ok) {
        const err = firstError(r.json) || { code: r.status, message: "Prebook request failed", detail: r.json };
        throw { ...err, status: r.status };
      }
      return r;
    });
  } catch (err) {
    const e = firstError(err) || { code: err.status || 500, message: "Prebook failed: " + (err.message || "unknown") };
    return { success: false, error: e };
  }

  const data = result.json.data && result.json.data[0] ? result.json.data[0] : result.json;
  if (!data || !data.prebookId) {
    const err = firstError(result.json) || { code: 500, message: "Unexpected prebook response shape", detail: result.json };
    return { success: false, error: err };
  }

  if (db) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO flight_prebooks (user_id, prebook_id, offer_id, currency, total_amount, transaction_id, secret_key, payment_types)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId || null, data.prebookId, data.offerId, data.currency, data.price, data.transactionId || null, data.secretKey || null, JSON.stringify(data.paymentTypes || []));
    } catch (dbErr) {
      console.error("Flight engine: DB insert prebook failed:", dbErr.message);
    }
  }

  return {
    success: true,
    data: {
      prebookId:          data.prebookId,
      booking:            data.booking,
      price:              data.price,
      currency:           data.currency,
      transactionId:      data.transactionId,
      secretKey:          data.secretKey,
      publishableKey:     data.publishableKey,
      servicesAttachable: data.servicesAttachable,
      voucherCode:        data.voucherCode,
      voucherTotalAmount: data.voucherTotalAmount,
      paymentTypes:       data.paymentTypes,
      offerId:            data.offerId,
      creditLine:         data.creditLine,
      addons:             data.addonsRequest || body.addons,
      addonsTotalAmount:  data.addonsTotalAmount,
    },
  };
}

async function attachServices(prebookId, services) {
  if (!prebookId) return { success: false, error: { code: 400, message: "prebookId required", key: "prebookId" } };
  if (!Array.isArray(services) || services.length === 0) {
    return { success: false, error: { code: 400, message: "At least one service to attach", key: "services" } };
  }
  const result = await liteFetch(`/flights/prebooks/${encodeURIComponent(prebookId)}/services`, { prebookId, services });
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Attach services failed", detail: result.json };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

async function completeBooking(body, userId = null, db) {
  if (!body.prebookId) {
    return { success: false, error: { code: 400, message: "prebookId required", key: "bodyRequest.prebookId" } };
  }
  if (!body.payment || !body.payment.method) {
    return { success: false, error: { code: 400, message: "payment.method required (TRANSACTION_ID | CREDIT | THIRD_PARTY)", key: "bodyRequest.payment.method" } };
  }
  const validMethods = ["TRANSACTION_ID", "CREDIT", "THIRD_PARTY"];
  if (!validMethods.includes(body.payment.method)) {
    return { success: false, error: { code: 400, message: `payment.method must be one of: ${validMethods.join(", ")}`, key: "bodyRequest.payment.method" } };
  }
  if (body.payment.method === "TRANSACTION_ID" && !body.payment.transactionId) {
    return { success: false, error: { code: 400, message: "transactionId required for TRANSACTION_ID payment", key: "bodyRequest.payment.transactionId" } };
  }
  if (body.payment.method === "THIRD_PARTY" && !body.payment.token) {
    return { success: false, error: { code: 400, message: "payment.token required for THIRD_PARTY payment", key: "bodyRequest.payment.token" } };
  }

  // Idempotency: check if already booked
  if (db) {
    const existing = db.prepare("SELECT * FROM flight_bookings WHERE prebook_id = ? LIMIT 1").get(body.prebookId);
    if (existing) return { success: true, data: existing, alreadyBooked: true };
    const prebook = db.prepare("SELECT * FROM flight_prebooks WHERE prebook_id = ?").get(body.prebookId);
    if (!prebook) {
      const anyBk = db.prepare("SELECT * FROM flight_bookings WHERE booking_id IN (SELECT liteapi_booking_ref FROM flight_bookings WHERE prebook_id = ?) LIMIT 1").get(body.prebookId);
      if (anyBk) return { success: true, data: anyBk, alreadyBooked: true };
    }
  }

  const bookPayload = {
    prebookId: body.prebookId,
    payment: {
      method:        body.payment.method,
      transactionId: body.payment.transactionId || undefined,
      token:         body.payment.token || undefined,
    },
  };
  if (body.holder) bookPayload.holder = body.holder;
  if (body.guests)  bookPayload.guests  = body.guests;

  let result;
  try {
    result = await withRetry(async () => {
      const r = await liteFetch("/flights/bookings", bookPayload);
      if (!r.ok) {
        const err = firstError(r.json) || { code: r.status, message: "Booking completion failed", detail: r.json };
        throw { ...err, status: r.status };
      }
      return r;
    });
  } catch (err) {
    const e = firstError(err) || { code: err.status || 500, message: "Booking failed: " + (err.message || "unknown") };
    return { success: false, error: e };
  }

  const data = result.json.data || result.json;
  // Flight bookings response: { data: [{ booking: {...}, message: "..." }] }
  // Extract the booking object from inside the array
  if (Array.isArray(data) && data.length > 0 && data[0].booking) {
    return {
      success: true,
      data: data[0].booking,
      alreadyBooked: data[0].message && data[0].message.includes('already exists'),
    };
  }
  if (!data || (!data.bookingId && !data.pnr && !data.bookingRef)) {
    const err = firstError(result.json) || { code: 500, message: "Unexpected booking response shape", detail: result.json };
    return { success: false, error: err };
  }

  if (db && data.bookingId) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO flight_bookings (user_id, booking_id, prebook_id, liteapi_booking_ref, status, currency, total_amount, passenger_count, journey_key, segments_json, services_json, addons_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId || null,
        data.bookingId || null,
        body.prebookId || null,
        data.bookingRef || data.pnr || null,
        data.status || "CONFIRMED",
        data.pricing?.currency || data.currency || "USD",
        (data.pricing?.totalAmount ?? data.price ?? 0),
        (data.passengers ? data.passengers.length : 0),
        (data.journey ? data.journey.journeyKey : null),
        (data.journey ? JSON.stringify(data.journey.segments || []) : null),
        (data.bookedServices ? JSON.stringify(data.bookedServices) : null),
        (data.addons ? JSON.stringify(data.addons) : null)
      );
      if (body.prebookId) db.prepare("DELETE FROM flight_prebooks WHERE prebook_id = ?").run(body.prebookId);
    } catch (dbErr) {
      console.error("Flight engine: DB insert booking failed:", dbErr.message);
    }
  }

  return { success: true, data };
}

async function getPrebook(prebookId) {
  if (!prebookId) return { success: false, error: { code: 400, message: "prebookId required", key: "prebookId" } };
  const result = await liteFetch(`/flights/prebooks/${encodeURIComponent(prebookId)}`, null, "GET");
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch prebook", detail: result.json };
    return { success: false, error: err };
  }
  const data = result.json.data && result.json.data[0] ? result.json.data[0] : result.json;
  return { success: true, data };
}

async function getBooking(bookingId) {
  if (!bookingId) return { success: false, error: { code: 400, message: "bookingId required", key: "bookingId" } };
  const result = await liteFetch(`/flights/bookings/${encodeURIComponent(bookingId)}`, null, "GET");
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch booking", detail: result.json };
    return { success: false, error: err };
  }
  const data = result.json.data && result.json.data[0] ? result.json.data[0] : result.json;
  return { success: true, data };
}

// ─── Build Flight Confirmation Response ──────────────────────────────────────

// ─── Baggage & Transfer Notes ────────────────────────────────────────

function extractBaggage(b) {
  const journey = b.journey || b.flight || {};
  // Try to get baggage from cheapestOffer
  const offers = journey.cheapestOffer ? [journey.cheapestOffer] : (journey.offers || []);
  const offer = offers[0] || {};
  const bg = offer.baggage || {};
  const included = bg.included || [];
  const paid = bg.paid || [];

  return {
    hasCarryOn: bg.hasCarryOnBag !== false,
    hasChecked: bg.hasCheckedBag === true,
    includedBags: included.map(i => ({
      type: i.bagType,
      description: i.description,
      pieces: i.pieces || 1,
      price: i.pricing?.display?.amount ?? 0,
    })),
    paidBags: paid.map(p => ({
      type: p.bagType,
      description: p.description,
      price: p.pricing?.display?.amount ?? 0,
      weight: p.weightKg || p.size || null,
    })),
    totalPrice: offer.pricing?.display?.total || b.price || 0,
    currency: b.currency || "USD",
    fareFamily: offer.fare?.family || journey.fareFamily || null,
    refundable: offer.terms?.refundable || false,
    changesAllowed: offer.terms?.changeable || false,
  };
}

function buildTransferNotes(flight, baggage) {
  const notes = [];
  const segments = flight.segments || [];

  // Check for terminal changes
  for (let i = 0; i < segments.length - 1; i++) {
    const curr = segments[i];
    const next = segments[i + 1];
    const currTerm = curr.departureTerminal || curr.arrivalTerminal;
    const nextTerm = next.departureTerminal || next.arrivalTerminal;
    if (currTerm && nextTerm && currTerm !== nextTerm) {
      notes.push({
        type: "terminal",
        severity: "warning",
        message: `Terminal change at ${curr.arrivalAirport}: ${currTerm} → ${nextTerm}`,
      });
    }
  }

  // Check for different airlines (potential baggage collect/recheck)
  const carriers = [...new Set(segments.map(s => s.carrierCode).filter(Boolean))];
  if (carriers.length > 1) {
    notes.push({
      type: "baggage",
      severity: "info",
      message: "Multiple airlines — baggage transfer depends on interline agreement. Confirm at check-in.",
    });
  }

  // Fare-based baggage note
  if (baggage && !baggage.hasChecked) {
    notes.push({
      type: "baggage",
      severity: "info",
      message: "Checked bag not included in fare. Add at checkout or at airport.",
    });
  }

  return notes;
}

function buildFlightConfirmation(bookingData, extras = {}) {
  const b = bookingData.data || bookingData;
  const uber = extractUberVoucher(b);
  const pricing = extractFlightPricing(b);
  const flight = extractFlightDetails(b);
  const baggage = extractBaggage(b);
  const transferNotes = buildTransferNotes(flight, baggage);

  return {
    success: true,
    type: "flight",
    bookingId: b.bookingId || b.liteapi_booking_id,
    bookingRef: b.bookingRef || b.pnr || b.liteapi_booking_ref,
    status: b.status || "CONFIRMED",
    createdAt: b.createdAt || b.timestamp || new Date().toISOString(),
    currency: b.currency || "USD",
    pricing: pricing,
    guest: extractGuest(b),
    flight: flight,
    baggage: baggage,
    transferNotes: transferNotes,
    uberVoucher: uber,
    loyalty: extras.loyalty || null,
    voucher: b.voucherCode ? { code: b.voucherCode, discount: b.voucherTotalAmount || 0 } : null,
    payment: extractPayment(b),
    notes: extras.notes || [],
  };
}

function extractFlightPricing(b) {
  const p = b.pricing || b.bookings?.[0]?.pricing || {};
  return {
    subtotal:   p.subtotal || 0,
    taxes:      p.taxes || 0,
    fees:       p.fees || 0,
    total:      p.totalAmount || p.total || b.price || 0,
    currency:   p.currency || b.currency || "USD",
    commission: b.commission || 0,
    perPassenger: p.display?.perPassenger || null,
  };
}

function extractGuest(b) {
  const contact = b.contact || b.holder || b.guest || b.passengers?.[0];
  if (!contact) return null;
  return {
    firstName:   contact.firstName,
    lastName:    contact.lastName,
    email:       contact.email,
    phone:       contact.phoneNumber || contact.phone,
    guestId:     contact.id || contact.guestId,
  };
}

function extractFlightDetails(b) {
  const journey = b.journey || b.flight || b.booking?.journey || {};
  const segments = journey.segments || b.segments || b.segs || [];
  const carrier = journey.carrier || b.carrier || segments[0]?.carrier || {};
  return {
    segments: segments.map(s => ({
      departureAirport:    s.departureAirport?.code || s.from,
      arrivalAirport:      s.arrivalAirport?.code || s.to,
      departureTime:       s.departureTime || s.departure,
      arrivalTime:         s.arrivalTime || s.arrival,
      carrierCode:         s.carrier?.marketingCode || carrier.marketingCode,
      carrierName:         s.carrier?.marketingName || carrier.marketingName,
      flightNumber:        s.flightNumber || s.flightNumber,
      aircraft:            s.aircraft,
      duration:            s.duration,
      departureTerminal:   s.departureTerminal,
      arrivalTerminal:     s.arrivalTerminal,
    })),
    airline: {
      code:  carrier.marketingCode || carrier.code,
      name:  carrier.marketingName || carrier.name,
      logo:  carrier.marketingLogo,
    },
    departure: {
      airport:    journey.departureAirport?.code || segments[0]?.departureAirport?.code,
      time:       journey.departureTime || segments[0]?.departureTime,
      terminal:   journey.departureTerminal || segments[0]?.departureTerminal,
    },
    arrival: {
      airport:    journey.arrivalAirport?.code || segments[0]?.arrivalAirport?.code,
      time:       journey.arrivalTime || segments[0]?.arrivalTime,
      terminal:   journey.arrivalTerminal || segments[0]?.arrivalTerminal,
    },
    flightNumber: journey.flightNumber || b.flightNumber || segments[0]?.flightNumber,
    cabinClass:   b.cabinClass || journey.cabinClass,
    fareFamily:   b.fareFamily || journey.fareFamily,
    journeyKey:   journey.journeyKey,
  };
}

function extractPayment(b) {
  return {
    method:       b.paymentMethod || b.payment?.method || "TRANSACTION_ID",
    amount:       b.price || 0,
    currency:     b.currency || "USD",
    transactionId: b.transactionId,
  };
}

function extractUberVoucher(b) {
  if (b.addonVoucherCode) {
    return {
      type:      "uber",
      url:       b.addonVoucherCode,
      value:     b.addonValue || 0,
      currency:  b.addonCurrency || "USD",
      voucherId: b.addonVoucherId,
      expiryDate: b.addonExpiryDate,
      status:    b.addonStatus || "SUCCESS",
    };
  }
  return null;
}

// ─── Flight Confirmation Flow (end-to-end) ────────────────────────────────────

async function flightConfirmationFlow(params, userId = null, db = null) {
  const { searchParams, prebookParams, paymentParams, contact, passengers } = params;

  // Step 1: Search flights
  const searchResult = await searchFlights(searchParams);
  if (!searchResult.success) {
    return { success: false, error: { code: 400, message: "Flight search failed: " + searchResult.error?.message } };
  }
  const raw = searchResult.data;
  // Response shape: { data: [{ journeys: [{ cheapestOffer: { offerId } }] }] }
  // Dig through nested structure to find the first offerId
  let offerId = null;
  if (raw?.data && Array.isArray(raw.data)) {
    for (const item of raw.data) {
      if (item.cheapestOffer?.offerId) { offerId = item.cheapestOffer.offerId; break; }
      if (item.offers && Array.isArray(item.offers) && item.offers[0]?.offerId) { offerId = item.offers[0].offerId; break; }
      if (Array.isArray(item.journeys)) {
        for (const j of item.journeys) {
          if (j.cheapestOffer?.offerId) { offerId = j.cheapestOffer.offerId; break; }
          if (j.offers && Array.isArray(j.offers) && j.offers[0]?.offerId) { offerId = j.offers[0].offerId; break; }
        }
        if (offerId) break;
      }
    }
  }
  if (!offerId) {
    return { success: false, error: { code: 400, message: "No offer found in flight result" } };
  }

  // Step 2: Prebook
  const prebookResult = await createPrebook({
    offerId,
    usePaymentSdk: prebookParams.usePaymentSdk !== false,
    voucherCode: prebookParams.voucherCode,
    contact: contact || {},
    passengers: passengers || [],
    addons: prebookParams.addons,
  }, userId, db);

  if (!prebookResult.success) {
    return { success: false, error: { code: prebookResult.error?.code || 500, message: "Prebook failed: " + prebookResult.error?.message } };
  }
  const prebook = prebookResult.data;

  // Step 3: Handle payment
  let transactionId = prebook.transactionId;
  if (!prebook.usePaymentSdk) {
    transactionId = paymentParams?.transactionId || ('flight-sandbox-txn-' + Date.now());
  }

  // Step 4: Book
  const bookingResult = await completeBooking({
    prebookId: prebook.prebookId,
    transactionId,
    contact: contact || {},
    passengers: passengers || [],
    payment: { method: prebook.usePaymentSdk ? "TRANSACTION_ID" : "WALLET" },
  }, userId, db);

  if (!bookingResult.success) {
    return { success: false, error: { code: bookingResult.error?.code || 500, message: "Booking failed: " + bookingResult.error?.message } };
  }
  const booking = bookingResult.data;

  // Step 5: Build confirmation
  const loyaltyData = extras.loyaltyEngine ? await extras.loyaltyEngine.getGuestLoyalty(contact?.guestId || contact?.id) : null;

  return buildFlightConfirmation(booking, {
    notes: [],
    loyalty: loyaltyData?.success && loyaltyData.data ? { guestId: loyaltyData.data.id, cashbackRate: loyaltyData.data.cashback, points: loyaltyData.data.points } : null,
    loyaltyEngine: extras.loyaltyEngine,
  });
}

module.exports = {
  searchFlights,
  createPrebook,
  attachServices,
  completeBooking,
  getPrebook,
  getBooking,
  ensureFlightSchema,
  _rawFetch: liteFetch,
  _baseUrl: bookBaseUrl,
  buildFlightConfirmation,
  flightConfirmationFlow,
};
