/**
 * Add-ons Engine — Uber vouchers + eSIM add-ons for bookings
 *
 * Uber Vouchers:
 *   - Values: $10, $20, $30, $40, $50, $60, $70, $80, $90, $100 (USD only)
 *   - Passed as addons[] in prebook
 *   - Voucher URL returned in booking response
 *
 * eSIM Add-ons:
 *   - Requires country-specific package lookup
 *   - Passed as addons[] in prebook
 */

const liteApi = require("liteapi-node-sdk");

// ─── Uber Vouchers ────────────────────────────────────────────────────────────

/**
 * Get available Uber voucher values
 * Returns the standard increments: $10-$100 in $10 steps
 */
function getUberVoucherOptions() {
  const values = [];
  for (let v = 10; v <= 100; v += 10) {
    values.push({ value: v, currency: "USD", label: `$${v}` });
  }
  return values;
}

/**
 * Validate an Uber voucher request
 */
function validateUberAddon(addon) {
  if (!addon || addon.addon !== "uber") {
    return { valid: false, error: { code: 400, message: "addon type must be 'uber'" } };
  }
  if (!addon.value || addon.value < 10 || addon.value > 100 || addon.value % 10 !== 0) {
    return { valid: false, error: { code: 400, message: "Uber voucher value must be $10-$100 in $10 increments" } };
  }
  if (!addon.currency || addon.currency !== "USD") {
    return { valid: false, error: { code: 400, message: "Uber vouchers only support USD currently" } };
  }
  return { valid: true };
}

/**
 * Build the addons array for a prebook request
 * Usage: pass this to hotelEngine.createPrebook or flightEngine.createPrebook
 */
function buildUberAddon(value, currency = "USD") {
  const validation = validateUberAddon({ addon: "uber", value, currency });
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }
  return {
    success: true,
    addon: {
      addon:  "uber",
      value:  value,
      currency: currency,
    }
  };
}

// ─── eSIM Add-ons ─────────────────────────────────────────────────────────────

/**
 * Get eSIM packages for a country
 * API: GET /addons/esimly/packages/{countryCode}
 * Country code is 2-letter ISO (e.g. "US", "GB", "ES", "FR")
 */
async function getEsimPackages(countryCode) {
  if (!countryCode || countryCode.length !== 2) {
    return { success: false, error: { code: 400, message: "2-letter country code required" } };
  }

  const key = process.env.SAND_API_KEY || process.env.PROD_API_KEY;
  if (!key) return { success: false, error: { code: 500, message: "No API key configured" } };

  try {
    const res = await fetch(
      `https://api.liteapi.travel/v3.0/addons/esimly/packages/${countryCode}`,
      {
        method: "GET",
        headers: {
          "X-API-Key": key,
          "Accept": "application/json",
        },
      }
    );
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: { code: res.status, message: data.error?.message || "Failed to fetch eSIM packages" } };
    }
    // Transform to clean format
    const packages = (data.data || []).map(p => ({
      packageId:     p.package_id,
      name:          p.name,
      dataSizeMb:    p.data_size_mb,
      validityDays:  p.validity_days,
      price:         p.price,
      currency:      p.currency || "USD",
      description:   p.description,
    }));
    return { success: true, data: packages };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Validate an eSIM addon request
 */
function validateEsimAddon(addon) {
  if (!addon || addon.addon !== "esimply") {
    return { valid: false, error: { code: 400, message: "addon type must be 'esimply'" } };
  }
  if (!addon.packageId || !addon.countryCode || addon.countryCode.length !== 2) {
    return { valid: false, error: { code: 400, message: "packageId and countryCode required for eSIM addon" } };
  }
  return { valid: true };
}

/**
 * Build the addons array for an eSIM prebook request
 */
function buildEsimAddon(packageId, countryCode, quantity = 1) {
  const validation = validateEsimAddon({ addon: "esimply", packageId, countryCode });
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }
  return {
    success: true,
    addon: {
      addon:        "esimply",
      packageId:    packageId,
      countryCode:  countryCode,
      quantity:     quantity,
    }
  };
}

/**
 * Build a combined addons array for prebook
 * Supports multiple Uber vouchers and/or eSIM packages
 */
function buildAddons(options) {
  const addons = [];
  const errors = [];

  if (options.uber && Array.isArray(options.uber)) {
    for (const u of options.uber) {
      const v = validateUberAddon({ addon: "uber", value: u.value, currency: u.currency });
      if (v.valid) {
        addons.push({ addon: "uber", value: u.value, currency: u.currency || "USD" });
      } else {
        errors.push(v.error);
      }
    }
  } else if (options.uber && typeof options.uber === "object") {
    // Single Uber voucher
    const v = validateUberAddon(options.uber);
    if (v.valid) {
      addons.push({ addon: "uber", value: options.uber.value, currency: options.uber.currency || "USD" });
    } else {
      errors.push(v.error);
    }
  }

  if (options.esim && Array.isArray(options.esim)) {
    for (const e of options.esim) {
      const v = validateEsimAddon({ addon: "esimply", packageId: e.packageId, countryCode: e.countryCode });
      if (v.valid) {
        addons.push({
          addon:       "esimply",
          packageId:   e.packageId,
          countryCode: e.countryCode,
          quantity:    e.quantity || 1,
        });
      } else {
        errors.push(v.error);
      }
    }
  } else if (options.esim && typeof options.esim === "object") {
    const v = validateEsimAddon(options.esim);
    if (v.valid) {
      addons.push({
        addon:       "esimply",
        packageId:   options.esim.packageId,
        countryCode: options.esim.countryCode,
        quantity:    options.esim.quantity || 1,
      });
    } else {
      errors.push(v.error);
    }
  }

  if (errors.length > 0) {
    return { success: false, error: errors[0], errors };
  }

  return { success: true, addons };
}

// ─── Parse addons from booking response ──────────────────────────────────────

/**
 * Extract Uber voucher details from a booking response
 * Returns the voucher URL and details if present
 */
function extractUberVoucherFromBooking(booking) {
  // The booking response from LiteAPI returns addon details
  if (booking.addonVoucherCode) {
    return {
      type:        "uber",
      url:         booking.addonVoucherCode,
      value:       booking.addonValue || 0,
      currency:     booking.addonCurrency || "USD",
      voucherId:   booking.addonVoucherId,
      expiryDate:  booking.addonExpiryDate,
      status:      booking.addonStatus || "SUCCESS",
    };
  }
  return null;
}

/**
 * Extract eSIM order details from a booking response
 */
function extractEsimFromBooking(booking) {
  if (booking.esimOrderId) {
    return {
      type:       "esim",
      orderId:    booking.esimOrderId,
      iccid:      booking.esimIccid,
      status:     booking.esimStatus,
    };
  }
  return null;
}

module.exports = {
  // Uber
  getUberVoucherOptions,
  validateUberAddon,
  buildUberAddon,

  // eSIM
  getEsimPackages,
  validateEsimAddon,
  buildEsimAddon,

  // Combined
  buildAddons,

  // Response parsing
  extractUberVoucherFromBooking,
  extractEsimFromBooking,
};
