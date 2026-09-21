/**
 * Booking Confirmation Engine — Nuitee LiteAPI complete end-to-end flow
 *
 * Handles the full booking lifecycle for both hotels and flights:
 *   1. Search (hotels or flights)
 *   2. Prebook (reserve + payment intent + addons/Uber vouchers)
 *   3. Payment (Stripe SDK or credit line)
 *   4. Book (complete the booking)
 *   5. Confirmation (full booking details + Uber voucher + loyalty)
 *
 * Confirmation response structure:
 *   - bookingId, bookingRef, status
 *   - hotel/flight details
 *   - pricing breakdown (base, taxes, fees, total, commission)
 *   - Uber voucher (if addons included): url, value, expiry, status
 *   - Loyalty info: guest loyalty status, cashback earned
 *   - Guest details
 *   - Confirmation ready for email/invoice
 */

const Database = require("better-sqlite3");
const hotelEngine = require("./modules/hotel-engine");
const flightEngine = require("./flight-engine");

// ─── Helpers ────────────────────────────────────────────────────────────────

function firstError(result) {
  if (result && result.error) {
    return {
      code:    result.error.code,
      message: result.error.message || "Operation failed",
      detail:  result.error.description || result.error.message,
      key:     result.error.key,
    };
  }
  if (result && result.status === "failed") {
    return {
      code:    500,
      message: result.message || "Operation failed",
      detail:  result,
    };
  }
  return null;
}

function extractUberVoucher(bookingData) {
  // Hotel booking: addonVoucherCode, addonVoucherId, addonValue, addonCurrency, addonExpiryDate, addonStatus
  if (bookingData.addonVoucherCode) {
    return {
      type:       "uber",
      url:        bookingData.addonVoucherCode,
      value:      bookingData.addonValue || bookingData.addonVoucherAmount || 0,
      currency:   bookingData.addonCurrency || "USD",
      voucherId:  bookingData.addonVoucherId,
      expiryDate: bookingData.addonExpiryDate,
      status:     bookingData.addonStatus || "SUCCESS",
    };
  }
  return null;
}

function extractLoyaltyInfo(bookingData, loyaltyEngine) {
  if (!loyaltyEngine) return null;
  // Check if guest has loyalty
  const guestId = bookingData.guest?.id || bookingData.holder?.guestId;
  if (guestId) {
    // Fetch loyalty status for the guest
    try {
      const loyalty = loyaltyEngine.getGuestLoyalty(guestId);
      if (loyalty && loyalty.data) {
        return {
          guestId,
          loyaltyStatus: loyalty.data.status,
          cashbackRate:  loyalty.data.cashback || 0,
          points:        loyalty.data.points || 0,
        };
      }
    } catch (e) {
      // Loyalty fetch failed, continue without it
      console.warn("Confirmation engine: loyalty fetch failed:", e.message);
    }
  }
  return null;
}

function buildConfirmationResponse(type, rawData, extras = {}) {
  const booking = rawData.data || rawData;
  const uber = extractUberVoucher(booking);
  const loyalty = extractLoyaltyInfo(booking, extras.loyaltyEngine);

  const base = {
    success:        true,
    type:           type,          // "hotel" | "flight"
    bookingId:      booking.bookingId || booking.liteapi_booking_id || booking.bookingRef,
    bookingRef:     booking.bookingRef || booking.liteapi_booking_ref || booking.pnr,
    status:         booking.status || "CONFIRMED",
    createdAt:      booking.createdAt || booking.timestamp || new Date().toISOString(),
    currency:       booking.currency || "USD",
    pricing:        extractPricing(booking, type),
    guest:          extractGuest(booking, type),
    hotel:          type === "hotel" ? extractHotel(booking) : null,
    flight:         type === "flight" ? extractFlight(booking) : null,
    uberVoucher:    uber,
    loyalty:        loyalty,
    voucher:        booking.voucherCode ? { code: booking.voucherCode, discount: booking.voucherTotalAmount || 0 } : null,
    payment:        extractPayment(booking),
    notes:          extras.notes || [],
  };

  if (type === "hotel") {
    base.hotel = {
      ...base.hotel,
      confirmationCode: booking.hotelConfirmationCode || booking.confirmationNumber,
      checkin:          booking.checkin,
      checkout:         booking.checkout,
      roomType:         booking.roomType || booking.roomTypes?.[0]?.name,
      nights:           calculateNights(booking.checkin, booking.checkout),
      chainCode:        booking.chainCode || booking.hotel?.chainCode,
      chainName:        booking.chainName || booking.hotel?.chainName,
      address:          booking.hotel?.address,
      city:             booking.hotel?.city,
      country:          booking.hotel?.country,
      image:            booking.hotel?.photo?.url || booking.hotel?.image,
      rating:           booking.hotel?.rating,
      lat:              booking.hotel?.latitude,
      lng:              booking.hotel?.longitude,
    };
  }

  if (type === "flight") {
    base.flight = {
      segments:      booking.flight?.segments || booking.segs || [],
      airline:       booking.flight?.airline || booking.carrier,
      departure:     booking.flight?.departure || booking.departure,
      arrival:       booking.flight?.arrival || booking.arrival,
      flightNumber:  booking.flightNumber || booking.flight?.number,
      journeyKey:    booking.flight?.journeyKey,
      cabinClass:    booking.cabinClass || booking.flight?.cabinClass,
      fareFamily:    booking.fareFamily || booking.flight?.fareFamily,
    };
  }

  return base;
}

function extractPricing(booking, type) {
  const p = {
    subtotal:      0,
    taxes:         0,
    fees:          0,
    total:         0,
    currency:      "USD",
    commission:    0,
    markup:        0,
    perPassenger:  null,
  };

  if (type === "hotel") {
    p.subtotal =  booking.price || 0;
    p.total    =  booking.sellingPriceToUser || booking.price || 0;
    p.currency =  booking.currency || "USD";
    p.commission = booking.commission || booking.sellingPriceToUser || 0;
    if (booking.roomTypes?.[0]) {
      const rt = booking.roomTypes[0];
      p.taxes = rt.pricing?.taxes || 0;
      p.fees  = rt.pricing?.fees  || 0;
    }
    if (booking.addonsTotalAmount) {
      p.total += booking.addonsTotalAmount;
    }
  }

  if (type === "flight") {
    const pricing = booking.pricing || booking.bookings?.[0]?.pricing;
    if (pricing) {
      p.subtotal =   pricing.subtotal    || 0;
      p.total    =   pricing.totalAmount || pricing.total || booking.price || 0;
      p.currency =   pricing.currency    || "USD";
      p.taxes    =   pricing.seatsAmount + pricing.baggageAmount;
    } else {
      p.total    =   booking.price || 0;
      p.currency =   booking.currency || "USD";
    }
    // Per-passenger breakdown
    if (booking.flight?.pricing?.display?.perPassenger) {
      p.perPassenger = booking.flight.pricing.display.perPassenger;
    }
  }

  return p;
}

function extractGuest(booking, type) {
  let g = null;
  if (type === "hotel") {
    g = booking.holder || booking.guest || booking.guests?.[0];
  }
  if (type === "flight") {
    g = booking.contact || booking.guest;
  }
  if (!g) return null;

  return {
    firstName:    g.firstName,
    lastName:     g.lastName,
    email:        g.email,
    phone:        g.phoneNumber || g.phone,
    fullName:     `${g.firstName || ""} ${g.lastName || ""}`.trim(),
    guestId:      g.id,
    nationality:  g.nationality,
  };
}

function extractHotel(booking) {
  const h = booking.hotel || {};
  return {
    name:     h.name,
    id:       h.id || booking.hotelId,
    chain:    h.chainCode ? { code: h.chainCode, name: h.chainName } : null,
    address:  h.address,
    city:     h.city,
    country:  h.country,
    rating:   h.rating,
    image:    h.photo?.url || h.image,
    lat:      h.latitude,
    lng:      h.longitude,
  };
}

function extractFlight(booking) {
  const f = booking.flight || {};
  return {
    segments:   f.segments || [],
    airline:    f.airline || f.carrier,
    departure:  f.departure,
    arrival:    f.arrival,
    flightNumber: f.flightNumber,
  };
}

function extractPayment(booking) {
  return {
    method:    booking.paymentMethod || booking.payment?.method || "TRANSACTION_ID",
    amount:    booking.price || 0,
    currency:  booking.currency || "USD",
    transactionId: booking.transactionId,
  };
}

function calculateNights(checkin, checkout) {
  if (!checkin || !checkout) return 0;
  const d1 = new Date(checkin);
  const d2 = new Date(checkout);
  const diff = Math.abs(d2 - d1);
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

// ─── Hotel Confirmation Flow ────────────────────────────────────────────────

async function hotelConfirmationFlow(params, userId = null, db = null) {
  const { searchParams, prebookParams, paymentParams, holder, guests } = params;

  // ── Step 1: Search hotels ──
  const placesResult = await hotelEngine.searchPlaces(searchParams.query);
  if (!placesResult.success) {
    return { success: false, error: { code: 400, message: "Hotel search failed: " + placesResult.error?.message } };
  }
  const hotelId = placesResult.data?.[0]?.id;
  if (!hotelId) {
    return { success: false, error: { code: 404, message: "No hotels found for query: " + searchParams.query } };
  }

  // ── Step 2: Get rates ──
  const ratesResult = await hotelEngine.getRates({
    hotelIds: [hotelId],
    checkin:  searchParams.checkin,
    checkout: searchParams.checkout,
    adults:   searchParams.adults || 1,
    currency: searchParams.currency || "USD",
    guestNationality: searchParams.guestNationality || "US",
    ...searchParams.rateOptions,
  });
  if (!ratesResult.success) {
    return { success: false, error: { code: 400, message: "Rates search failed: " + ratesResult.error?.message } };
  }
  const rate = ratesResult.data?.[0];
  if (!rate) {
    return { success: false, error: { code: 404, message: "No rates found for this hotel" } };
  }
  // Rate structure: { hotelId, roomTypes: [{ offerId, roomTypeId, ... }] }
  const roomType = rate.roomTypes?.[0];
  if (!roomType || !roomType.offerId) {
    return { success: false, error: { code: 404, message: "No available room types with offers for this hotel" } };
  }
  const offerId = roomType.offerId;

  // ── Step 3: Prebook ──
  const prebookResult = await hotelEngine.createPrebook({
    offerId:            offerId,
    usePaymentSdk:      prebookParams.usePaymentSdk !== false,
    voucherCode:        prebookParams.voucherCode,
    guestNationality:   searchParams.guestNationality || "US",
    currency:           searchParams.currency || "USD",
    addons:             prebookParams.addons,
  }, userId, db);

  if (!prebookResult.success) {
    return { success: false, error: { code: prebookResult.error?.code || 500, message: "Prebook failed: " + prebookResult.error?.message } };
  }
  const prebook = prebookResult.data;

  // For sandbox testing: usePaymentSdk=false → WALLET payment (no Stripe needed)
  // usePaymentSdk=true → Stripe payment intent (requires frontend Stripe confirmation)
  // In sandbox, the simplest path that returns Uber vouchers is usePaymentSdk=true
  // with a user-provided transactionId (simulating confirmed Stripe payment).
  let transactionId = prebook.transactionId;
  if (!prebook.usePaymentSdk) {
    transactionId = paymentParams?.transactionId || ('sandbox-txn-' + Date.now());
  }

  // ── Step 5: Complete booking ──
  const bookingResult = await hotelEngine.completeBooking({
    prebookId:      prebook.prebookId,
    transactionId:  transactionId,
    holder:         holder,
    guests:         guests,
    payment:        { method: prebook.usePaymentSdk ? "TRANSACTION_ID" : "WALLET" },
  }, userId, db);

  if (!bookingResult.success) {
    return { success: false, error: { code: bookingResult.error?.code || 500, message: "Booking failed: " + bookingResult.error?.message } };
  }
  const booking = bookingResult.data;

  // ── Step 6: Build confirmation ──
  const confirmation = buildConfirmationResponse("hotel", booking, {
    notes: [],
    prebookId: prebook.prebookId,
    offerId,
    roomType,
    loyaltyEngine: params.loyaltyEngine,
    loyalty: params.loyalty,  // pre-fetched loyalty data, optional
  });

  // Add hotel-specific details
  confirmation.hotel = {
    ...confirmation.hotel,
    name:          booking.hotel?.name || "Hotel",
    checkin:       booking.checkin,
    checkout:      booking.checkout,
    roomType:      roomType?.name || rate.roomType?.name,
    nights:        calculateNights(booking.checkin, booking.checkout),
    chainCode:     booking.hotel?.chainCode,
    chainName:     booking.hotel?.chainName,
    address:       booking.hotel?.address,
    city:          booking.hotel?.city,
    country:       booking.hotel?.country,
    image:         booking.hotel?.photo?.url,
    rating:        booking.hotel?.rating,
  };

  // Add Uber voucher if present
  if (prebook.addons && prebook.addons.some(a => a.addon === "uber")) {
    if (booking.addonVoucherCode) {
      confirmation.uberVoucher = {
        type:       "uber",
        url:        booking.addonVoucherCode,
        value:      booking.addonValue || 0,
        currency:   booking.addonCurrency || "USD",
        voucherId:  booking.addonVoucherId,
        expiryDate: booking.addonExpiryDate,
        status:     booking.addonStatus || "SUCCESS",
      };
      confirmation.notes.push("Uber voucher included — see voucher URL for redemption");
    }
  }

  // Add loyalty info
  if (params.loyaltyEngine && holder?.guestId) {
    try {
      const loyalty = await params.loyaltyEngine.getGuestLoyalty(holder.guestId);
      if (loyalty.success && loyalty.data) {
        confirmation.loyalty = {
          guestId:        holder.guestId,
          status:         loyalty.data.status,
          cashbackRate:   loyalty.data.cashback,
          points:         loyalty.data.points,
          cashbackEarned: (confirmation.pricing.total * (loyalty.data.cashback / 100)).toFixed(2),
        };
        confirmation.notes.push(`Loyalty cashback (${loyalty.data.cashback}%): $${confirmation.loyalty.cashbackEarned}`);
      }
    } catch (e) {
      console.warn("Confirmation: loyalty lookup failed:", e.message);
    }
  }

  // Add voucher info
  if (prebook.voucherCode) {
    confirmation.voucher = {
      code:      prebook.voucherCode,
      discount:  prebook.voucherTotalAmount || 0,
    };
  }

  return {
    success:        true,
    type:           "hotel",
    bookingId:      booking.bookingId,
    bookingRef:     booking.bookingRef,
    status:         booking.status,
    prebookId:      prebook.prebookId,
    offerId:        offerId,
    roomType:       roomType,
    hotel:          confirmation.hotel,
    pricing:        confirmation.pricing,
    guest:          confirmation.guest,
    uberVoucher:    confirmation.uberVoucher,
    loyalty:        confirmation.loyalty,
    voucher:        confirmation.voucher,
    payment:        confirmation.payment,
    notes:          confirmation.notes,
    rawBooking:     booking,
    _confirmation:  confirmation,
  };
}

// ─── Flight Confirmation Flow ────────────────────────────────────────────────

async function flightConfirmationFlow(params, userId = null, db = null) {
  const { searchParams, prebookParams, paymentParams, contact, passengers } = params;

  // ── Step 1: Search flights ──
  const searchResult = await flightEngine.searchFlights({
    legs:         searchParams.legs,
    adults:       searchParams.adults || 1,
    currency:     searchParams.currency || "USD",
    country:      searchParams.country || "US",
  });
  if (!searchResult.success) {
    return { success: false, error: { code: 400, message: "Flight search failed: " + searchResult.error?.message } };
  }
  // Response shape can be:
  //   { data: [{ journeys: [...] }] }  (standard)
  //   { "0": { journeys: [...] }, "1": {...} }  (array-like object)
  const raw = searchResult.data;
  let offerId = null;
  const journeys = (raw?.data && Array.isArray(raw.data)) ? raw.data
               : (raw && typeof raw === 'object' && !Array.isArray(raw))
                 ? Object.values(raw).filter(v => v && typeof v === 'object' && Array.isArray(v.journeys))
                 : [];
  for (const journey of journeys) {
    if (journey.cheapestOffer?.offerId) { offerId = journey.cheapestOffer.offerId; break; }
    if (Array.isArray(journey.offers) && journey.offers.length > 0) { offerId = journey.offers[0].offerId; break; }
    // Also check inside journeys array
    if (Array.isArray(journey.journeys)) {
      for (const j of journey.journeys) {
        if (j.cheapestOffer?.offerId) { offerId = j.cheapestOffer.offerId; break; }
        if (Array.isArray(j.offers) && j.offers.length > 0) { offerId = j.offers[0].offerId; break; }
      }
      if (offerId) break;
    }
  }

  // ── Step 2: Prebook ──
  const prebookResult = await flightEngine.createPrebook({
    offerId:            offerId,
    usePaymentSdk:      prebookParams.usePaymentSdk !== false,
    contact:            contact,
    passengers:         passengers,
    voucherCode:        prebookParams.voucherCode,
    travelPurpose:      prebookParams.travelPurpose,
    payment:            prebookParams.payment,
    addons:             prebookParams.addons,
    includeCreditBalance: prebookParams.includeCreditBalance,
  }, userId, db);

  if (!prebookResult.success) {
    return { success: false, error: { code: prebookResult.error?.code || 500, message: "Prebook failed: " + prebookResult.error?.message } };
  }
  const prebook = prebookResult.data;

  // ── Step 3: (Optional) Attach services ──
  if (prebookParams.services && prebookParams.services.length > 0) {
    const svcResult = await flightEngine.attachServices(prebook.prebookId, prebookParams.services);
    if (!svcResult.success) {
      return { success: false, error: { code: 500, message: "Service attachment failed: " + svcResult.error?.message } };
    }
    prebook.servicesAttachable = svcResult.data;
  }

  // ── Step 4: Payment ──
  // When usePaymentSdk is true, the prebook returns a Stripe transactionId.
  // When false and credit line is enabled, use CREDIT method.
  // Otherwise (sandbox/testing), accept a provided transactionId.
  const useStripe = prebook.usePaymentSdk === true || prebookParams.usePaymentSdk !== false;
  let transactionId = prebook.transactionId;
  let paymentMethod = prebookParams.payment?.method || "TRANSACTION_ID";

  if (!useStripe && !prebook.transactionId) {
    // No Stripe intent — check if credit line payment is viable
    if (prebook.creditLine && prebook.creditLine.available) {
      paymentMethod = "CREDIT";
      transactionId = paymentParams?.transactionId || undefined;
    } else {
      // Sandbox/fallback: use provided or generated transactionId
      transactionId = paymentParams?.transactionId || ('flight-sandbox-txn-' + Date.now());
    }
  }

  // ── Step 5: Complete booking ──
  const bookingResult = await flightEngine.completeBooking({
    prebookId:      prebook.prebookId,
    transactionId:  transactionId,
    payment:        {
      method:        paymentParams?.paymentMethod || "TRANSACTION_ID",
      transactionId: transactionId,
    },
  }, userId, db);

  if (!bookingResult.success) {
    return { success: false, error: { code: bookingResult.error?.code || 500, message: "Booking failed: " + bookingResult.error?.message } };
  }
  const booking = bookingResult.data;

  // ── Step 6: Build confirmation ──
  const confirmation = buildConfirmationResponse("flight", booking, {
    notes: [],
    prebookId: prebook.prebookId,
    loyaltyEngine: params.loyaltyEngine,
  });

  // Add flight-specific details
  if (booking.journey) {
    confirmation.flight = {
      segments:       booking.journey.segments || [],
      journeyKey:     booking.journey.journeyKey,
      cabinClass:     booking.journey.cabinClass,
      fareFamily:     booking.journey.fare?.family,
      seatsRemaining: booking.journey.fare?.seatsRemaining,
      terms:          booking.journey.terms,
    };
  }

  // Pricing breakdown
  if (booking.pricing) {
    confirmation.pricing = {
      subtotal:       booking.pricing.subtotal || 0,
      servicesAmount: booking.pricing.servicesAmount || 0,
      seatsAmount:    booking.pricing.seatsAmount || 0,
      baggageAmount:  booking.pricing.baggageAmount || 0,
      totalAmount:    booking.pricing.totalAmount || booking.pricing.total || booking.price || 0,
      currency:       booking.pricing.currency || "USD",
    };
  }

  // Per-passenger
  if (booking.journey?.pricing?.display?.perPassenger) {
    confirmation.perPassenger = booking.journey.pricing.display.perPassenger;
  }

  // Add Uber voucher if present
  if (prebook.addons && prebook.addons.some(a => a.addon === "uber")) {
    if (booking.addonVoucherCode) {
      confirmation.uberVoucher = {
        type:       "uber",
        url:        booking.addonVoucherCode,
        value:      booking.addonValue || booking.addonsValue || 0,
        currency:   booking.addonCurrency || "USD",
        voucherId:  booking.addonVoucherId,
        expiryDate: booking.addonExpiryDate,
        status:     booking.addonStatus || "SUCCESS",
      };
      confirmation.notes.push("Uber voucher included — see voucher URL for redemption");
    }
  }

  // Add loyalty info
  if (params.loyaltyEngine && contact?.guestId) {
    try {
      const loyalty = await params.loyaltyEngine.getGuestLoyalty(contact.guestId);
      if (loyalty.success && loyalty.data) {
        confirmation.loyalty = {
          guestId:        contact.guestId,
          status:         loyalty.data.status,
          cashbackRate:   loyalty.data.cashback,
          points:         loyalty.data.points,
          cashbackEarned: (confirmation.pricing?.totalAmount || 0) * (loyalty.data.cashback / 100),
        };
        confirmation.notes.push(`Loyalty cashback (${loyalty.data.cashback}%): $${confirmation.loyalty.cashbackEarned}`);
      }
    } catch (e) {
      console.warn("Confirmation: loyalty lookup failed:", e.message);
    }
  }

  return {
    success:        true,
    type:           "flight",
    bookingId:      booking.bookingId,
    bookingRef:     booking.bookingRef || booking.pnr,
    status:         booking.status,
    prebookId:      prebook.prebookId,
    offerId:        offerId,
    journey:        booking.journey,
    pricing:        confirmation.pricing,
    perPassenger:   confirmation.perPassenger,
    segments:       booking.journey?.segments,
    guest:          confirmation.guest,
    contact:        contact,
    passengers:     booking.passengers,
    uberVoucher:    confirmation.uberVoucher,
    loyalty:        confirmation.loyalty,
    voucher:        prebook.voucherCode ? { code: prebook.voucherCode, discount: prebook.voucherTotalAmount } : null,
    payment:        confirmation.payment,
    services:       booking.servicesAttachable,
    notes:          confirmation.notes,
    rawBooking:     booking,
    _confirmation:  confirmation,
  };
}

// ─── Get Booking (existing booking lookup) ───────────────────────────────────

async function getHotelConfirmation(bookingId, db = null) {
  const result = await hotelEngine.getBooking(bookingId);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success:        true,
    type:           "hotel",
    bookingId:      result.data.bookingId,
    bookingRef:     result.data.bookingRef,
    status:         result.data.status,
    hotel:          extractHotel(result.data),
    pricing:        extractPricing(result.data, "hotel"),
    guest:          extractGuest(result.data, "hotel"),
    uberVoucher:    extractUberVoucher(result.data),
    rawBooking:     result.data,
  };
}

async function getFlightConfirmation(bookingId, db = null) {
  const result = await flightEngine.getBooking(bookingId);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success:        true,
    type:           "flight",
    bookingId:      result.data.bookingId || result.data.pnr,
    bookingRef:     result.data.bookingRef || result.data.pnr,
    status:         result.data.status,
    flight:         extractFlight(result.data),
    pricing:        extractPricing(result.data, "flight"),
    guest:          extractGuest(result.data, "flight"),
    uberVoucher:    extractUberVoucher(result.data),
    rawBooking:     result.data,
  };
}

// ─── Voucher Redemption Info ─────────────────────────────────────────────────

function getVoucherRedemptionInfo(voucher) {
  if (!voucher) return null;
  return {
    voucher,
    redemptionSteps: [
      "Open the Uber app",
      "Go to the 'Add Promo Code' section",
      `Or click the voucher URL directly: ${voucher.url}`,
      "The credit will be applied to your next ride",
    ],
    expiryNotice: voucher.expiryDate
      ? `This voucher expires on ${new Date(voucher.expiryDate).toLocaleDateString()}`
      : "No expiry date specified",
    terms: "Voucher is non-transferable and valid for Uber rides only",
  };
}

// ─── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  // Main confirmation flows
  hotelConfirmationFlow,
  flightConfirmationFlow,

  // Lookup existing bookings
  getHotelConfirmation,
  getFlightConfirmation,

  // Helpers
  buildConfirmationResponse,
  extractUberVoucher,
  getVoucherRedemptionInfo,
  calculateNights,

  // Raw engine access
  hotelEngine,
  flightEngine,
};
