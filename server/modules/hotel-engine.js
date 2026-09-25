/**
 * Hotel Booking Engine — Nuitee LiteAPI hotel checkout flow
 *
 * Flow:
 *   1. GET  /api/hotels/places      → autocomplete hotel search
 *   2. POST /api/hotels/rates       → search rates for hotels
 *   3. POST /api/hotels/prebook     → prebook a rate (reserves + payment intent)
 *   4. POST /api/hotels/book        → complete booking with payment
 *
 * Features:
 *   - Uber Vouchers via addons field in prebook
 *   - Idempotency guard (check DB before booking)
 *   - Retry logic on transient errors (502/503/timeout)
 *   - Voucher code support
 *   - Guest loyalty tracking (guestId returned in booking)
 */

const Database = require("better-sqlite3");

const BASE_URL = "https://api.liteapi.travel/v3.0";
const PREBOOK_URL = "https://book.liteapi.travel/v3.0";

const { liteApiKey: apiKey } = require("./api-key");

function liteFetch(path, body, method = "POST", usePrebookHost = false) {
  const url = (usePrebookHost ? PREBOOK_URL : BASE_URL) + path;
  const timeoutMs = 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    method,
    signal: controller.signal,
    headers: {
      "X-API-Key": apiKey(),
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

function firstError(result) {
  if (result && result.error) {
    return {
      code:    result.error.code,
      message: result.error.message || "Hotel operation failed",
      detail:  result.error.description || result.error.message,
      key:     result.error.key,
    };
  }
  if (result && result.status === "failed") {
    const msg = result.message || result.error?.message || "Hotel operation failed";
    return { code: 500, message: msg, detail: result };
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
      console.warn(`Hotel engine: transient error, retry ${attempt}/${maxAttempts} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── Hotel Search / Autocomplete ─────────────────────────────────────────────

async function searchPlaces(query) {
  if (!query || query.trim().length < 2) {
    return { success: false, error: { code: 400, message: "Query must be at least 2 characters" } };
  }
  // LiteAPI: GET /data/hotels — hotel search/autocomplete
  // Must provide at least one filter: countryCode, lat/lng, placeId, IATA, or hotelIds
  const result = await liteFetch(`/data/hotels?countryCode=US&cityName=${encodeURIComponent(query)}&offset=0&limit=10`, null, "GET");
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Places search failed" };
    return { success: false, error: err };
  }
  const data = Array.isArray(result.json) ? result.json : (result.json.data || []);
  return { success: true, data };
}

// ─── Rates Search ────────────────────────────────────────────────────────────

async function getRates(params) {
  if (!params.hotelIds && !params.placeId && !params.aiSearch) {
    return { success: false, error: { code: 400, message: "hotelIds, placeId, or aiSearch required" } };
  }
  if (!params.checkin || !params.checkout) {
    return { success: false, error: { code: 400, message: "checkin and checkout dates required (YYYY-MM-DD)" } };
  }

  const body = {
    hotelIds:         params.hotelIds       || undefined,
    placeId:          params.placeId        || undefined,
    aiSearch:         params.aiSearch       || undefined,
    occupancies:      params.occupancies    || [{ adults: params.adults || 1, rooms: params.rooms || 1 }],
    currency:         params.currency       || "USD",
    guestNationality: params.guestNationality || "US",
    checkin:          params.checkin,
    checkout:         params.checkout,
    roomMapping:      true,
    maxRatesPerHotel: params.maxRatesPerHotel || 5,
    includeHotelData: params.includeHotelData !== false,
    margin:           params.margin || 0,
  };

  const result = await liteFetch("/hotels/rates", body);
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Rates search failed" };
    return { success: false, error: err };
  }
  // Response: array of hotel rate objects, each with roomTypes[]
  // Flatten: extract first roomType's offerId at top level for easier consumption
  const raw = result.json.data || result.json;
  const rates = Array.isArray(raw) ? raw : [];
  const flattened = rates.map(rate => {
    const rt = rate.roomTypes?.[0];
    return {
      ...rate,
      offerId:    rt?.offerId    || rate.offerId,
      roomType:   rt || rate.roomType,
      roomTypeId: rt?.roomTypeId || rate.roomTypeId,
      pricing:    rt?.pricing    || rate.pricing,
    };
  });
  return { success: true, data: flattened };
}

// ─── Prebook ──────────────────────────────────────────────────────────────────

async function createPrebook(body, userId = null, db) {
  if (!body.offerId) {
    return { success: false, error: { code: 400, message: "offerId is required", key: "bodyRequest.offerId" } };
  }

  const prebookPayload = {
    offerId:       body.offerId,
    usePaymentSdk: body.usePaymentSdk !== false,
    occupancies:   body.occupancies || [{ adults: 1, rooms: 1 }],
    currency:      body.currency || "USD",
    guestNationality: body.guestNationality || "US",
  };
  if (body.voucherCode)      prebookPayload.voucherCode = body.voucherCode;
  if (body.guestNationality) prebookPayload.guestNationality = body.guestNationality;
  if (body.currency)         prebookPayload.currency = body.currency;
  if (body.addons && Array.isArray(body.addons) && body.addons.length > 0) {
    prebookPayload.addons = body.addons;
  }

  let result;
  try {
    result = await withRetry(async () => {
      const r = await liteFetch("/rates/prebook", prebookPayload, "POST", true);
      if (!r.ok) {
        const err = firstError(r.json) || { code: r.status, message: "Prebook failed" };
        throw { ...err, status: r.status };
      }
      return r;
    });
  } catch (err) {
    const e = firstError(err) || { code: err.status || 500, message: "Prebook failed: " + (err.message || "unknown") };
    return { success: false, error: e };
  }

  // Response: { data: { prebookId, offerId, hotelId, price, currency, commission, transactionId, secretKey, paymentTypes, voucherCode, ... } }
  const data = result.json.data || result.json;
  if (!data || !data.prebookId) {
    return { success: false, error: { code: 500, message: "Unexpected prebook response", detail: result.json } };
  }

  if (db) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO hotel_prebooks (user_id, prebook_id, offer_id, currency, total_amount, transaction_id, secret_key, payment_types)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId || null,
        data.prebookId,
        data.offerId,
        data.currency,
        data.price,
        data.transactionId || null,
        data.secretKey || null,
        JSON.stringify(data.paymentTypes || [])
      );
    } catch (dbErr) {
      console.error("Hotel engine: DB insert prebook failed:", dbErr.message);
    }
  }

  return {
    success: true,
    data: {
      prebookId:            data.prebookId,
      offerId:              data.offerId,
      hotelId:              data.hotelId,
      price:                data.price,
      currency:             data.currency,
      commission:           data.commission,
      transactionId:        data.transactionId,
      secretKey:            data.secretKey,
      paymentTypes:         data.paymentTypes,
      voucherCode:          data.voucherCode,
      voucherTotalAmount:   data.voucherTotalAmount,
      sellingPriceToUser:   data.sellingPriceToUser,
      roomTypes:            data.roomTypes,
      addons:               data.addonsRequest || body.addons,
      addonsTotalAmount:    data.addonsTotalAmount,
    },
  };
}

// ─── Book ─────────────────────────────────────────────────────────────────────

async function completeBooking(body, userId = null, db) {
  if (!body.prebookId) {
    return { success: false, error: { code: 400, message: "prebookId required", key: "bodyRequest.prebookId" } };
  }
  if (!body.transactionId && !body.payment?.transactionId && body.payment?.method === "TRANSACTION_ID") {
    return { success: false, error: { code: 400, message: "transactionId required for TRANSACTION_ID payment", key: "bodyRequest.transactionId" } };
  }
  if (!body.holder || !body.holder.firstName || !body.holder.lastName || !body.holder.email) {
    return { success: false, error: { code: 400, message: "holder with firstName, lastName, email required", key: "bodyRequest.holder" } };
  }

  // Idempotency: check if already booked
  if (db) {
    const existing = db.prepare("SELECT * FROM bookings WHERE prebook_id = ? LIMIT 1").get(body.prebookId);
    if (existing) return { success: true, data: existing, alreadyBooked: true };
    const prebook = db.prepare("SELECT * FROM hotel_prebooks WHERE prebook_id = ?").get(body.prebookId);
    if (!prebook) {
      const anyBk = db.prepare("SELECT * FROM bookings WHERE liteapi_booking_id IN (SELECT liteapi_booking_id FROM bookings WHERE prebook_id = ?) LIMIT 1").get(body.prebookId);
      if (anyBk) return { success: true, data: anyBk, alreadyBooked: true };
    }
  }

  const bookPayload = {
    prebookId: body.prebookId,
    holder: {
      firstName:    body.holder.firstName,
      lastName:     body.holder.lastName,
      email:        body.holder.email,
      phoneNumber:  body.holder.phoneNumber || body.holder.phone || undefined,
    },
    payment: {
      method:        body.payment?.method || "TRANSACTION_ID",
      transactionId: body.payment?.transactionId || body.transactionId || undefined,
    },
  };
  if (body.guests && Array.isArray(body.guests) && body.guests.length > 0) {
    bookPayload.guests = body.guests.map(g => ({
      occupancyNumber: g.occupancyNumber || 1,
      firstName:       g.firstName || body.holder.firstName,
      lastName:        g.lastName  || body.holder.lastName,
      email:           g.email     || body.holder.email,
      phone:           g.phone     || undefined,
      remarks:         g.remarks   || undefined,
    }));
  }

  let result;
  try {
    result = await withRetry(async () => {
      const r = await liteFetch("/rates/book", bookPayload, "POST", true);
      if (!r.ok) {
        const err = firstError(r.json) || { code: r.status, message: "Booking failed" };
        throw { ...err, status: r.status };
      }
      return r;
    });
  } catch (err) {
    const e = firstError(err) || { code: err.status || 500, message: "Booking failed: " + (err.message || "unknown") };
    return { success: false, error: e };
  }

  // Response: { data: { bookingId, hotelConfirmationCode, hotel: { name, ... }, checkin, checkout, price, currency, ... } }
  const data = result.json.data || result.json;
  if (!data || (!data.bookingId && !data.hotelConfirmationCode)) {
    return { success: false, error: { code: 500, message: "Unexpected booking response", detail: result.json } };
  }

  if (db) {
    try {
      db.prepare(`
        INSERT OR REPLACE INTO bookings (liteapi_booking_id, prebook_id, user_id, liteapi_type, status, hotel_name, checkin, checkout, price, currency, guest_name, guest_email)
        VALUES (?, ?, ?, 'hotel', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.bookingId,
        body.prebookId,
        userId || null,
        data.status || "CONFIRMED",
        data.hotel?.name || data.hotelName || "Unknown",
        data.checkin,
        data.checkout,
        data.price || data.sellingPriceToUser || 0,
        data.currency,
        `${body.holder.firstName} ${body.holder.lastName}`,
        body.holder.email
      );
      if (body.prebookId) db.prepare("DELETE FROM hotel_prebooks WHERE prebook_id = ?").run(body.prebookId);
    } catch (dbErr) {
      console.error("Hotel engine: DB insert booking failed:", dbErr.message);
    }
  }

  return { success: true, data };
}

// ─── Get Booking ─────────────────────────────────────────────────────────────

async function getBooking(bookingId) {
  if (!bookingId) return { success: false, error: { code: 400, message: "bookingId required" } };
  const result = await liteFetch(`/bookings/${encodeURIComponent(bookingId)}`, null, "GET");
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch booking" };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

// ─── Get Hotel Details ────────────────────────────────────────────────────────

async function getHotelDetails(hotelId) {
  if (!hotelId) return { success: false, error: { code: 400, message: "hotelId required" } };
  const result = await liteFetch(`/data/hotel?hotelId=${encodeURIComponent(hotelId)}&timeout=1.5`, null, "GET");
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch hotel details" };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

module.exports = {
  searchPlaces,
  getRates,
  createPrebook,
  completeBooking,
  getBooking,
  getHotelDetails,
};
