/**
 * Voucher Engine — Full voucher CRUD via LiteAPI
 *
 * Endpoints (from Postman collection / Vouchers API Guide):
 *   POST   /vouchers              — Create voucher
 *   GET    /vouchers              — List all vouchers
 *   GET    /vouchers/:id          — Get voucher by ID
 *   PUT    /vouchers/:id          — Update voucher
 *
 * Base URL: https://da.liteapi.travel (from docs)
 * Auth: X-API-Key header
 */

const VOUCHER_BASE = "https://da.liteapi.travel";
function apiKey() { return require("./modules/api-key").liteApiKey(); }

function daFetch(path, method = "GET", body = null) {
  const url = VOUCHER_BASE + path;
  return fetch(url, {
    method,
    headers: {
      "X-API-Key": apiKey() || "",
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(res => res.json().then(json => ({ ok: res.ok, status: res.status, json })));
}

function firstError(result) {
  if (result && result.error) {
    return { code: result.error.code, message: result.error.message || "Voucher error" };
  }
  return null;
}

// ─── Create Voucher ───────────────────────────────────────────────────────────

async function createVoucher(body) {
  if (!body.voucher_code) {
    return { success: false, error: { code: 400, message: "voucher_code required" } };
  }
  if (!body.discount_type || body.discount_type !== "percentage") {
    return { success: false, error: { code: 400, message: "discount_type must be 'percentage'" } };
  }
  if (body.discount_value == null) {
    return { success: false, error: { code: 400, message: "discount_value required" } };
  }

  const result = await daFetch("/vouchers", "POST", {
    voucher_code:           body.voucher_code,
    discount_type:          body.discount_type,
    discount_value:         body.discount_value,
    minimum_spend:          body.minimum_spend || 0,
    maximum_discount_amount: body.maximum_discount_amount || 0,
    currency:               body.currency || "USD",
    validity_start:         body.validity_start || new Date().toISOString().split("T")[0],
    validity_end:           body.validity_end || "2027-12-31",
    usages_limit:           body.usages_limit || 999,
    status:                 body.status || "active",
    terms_and_conditions:   body.terms_and_conditions || "",
  });

  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to create voucher" };
    return { success: false, error: err };
  }
  const voucher = result.json.voucher || result.json;
  return { success: true, data: voucher };
}

// ─── List Vouchers ────────────────────────────────────────────────────────────

async function listVouchers() {
  const result = await daFetch("/vouchers", "GET");
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch vouchers" };
    return { success: false, error: err };
  }
  const items = result.json.vouchers || result.json.data || result.json;
  return { success: true, data: Array.isArray(items) ? items : [items] };
}

// ─── Get Voucher by ID ────────────────────────────────────────────────────────

async function getVoucherById(id) {
  if (!id) {
    return { success: false, error: { code: 400, message: "Voucher ID required" } };
  }
  const result = await daFetch(`/vouchers/${encodeURIComponent(id)}`, "GET");
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Voucher not found" };
    return { success: false, error: err };
  }
  const voucher = result.json.voucher || result.json;
  return { success: true, data: voucher };
}

// ─── Update Voucher ───────────────────────────────────────────────────────────

async function updateVoucher(id, body) {
  if (!id) {
    return { success: false, error: { code: 400, message: "Voucher ID required" } };
  }

  const updatePayload = {};
  if (body.voucher_code != null)          updatePayload.voucher_code          = body.voucher_code;
  if (body.discount_type != null)         updatePayload.discount_type         = body.discount_type;
  if (body.discount_value != null)        updatePayload.discount_value        = body.discount_value;
  if (body.minimum_spend != null)         updatePayload.minimum_spend         = body.minimum_spend;
  if (body.maximum_discount_amount != null) updatePayload.maximum_discount_amount = body.maximum_discount_amount;
  if (body.currency != null)              updatePayload.currency              = body.currency;
  if (body.validity_start != null)        updatePayload.validity_start        = body.validity_start;
  if (body.validity_end != null)          updatePayload.validity_end          = body.validity_end;
  if (body.usages_limit != null)          updatePayload.usages_limit          = body.usages_limit;
  if (body.status != null)                updatePayload.status                = body.status;
  if (body.terms_and_conditions != null)  updatePayload.terms_and_conditions  = body.terms_and_conditions;

  if (Object.keys(updatePayload).length === 0) {
    return { success: false, error: { code: 400, message: "No fields to update" } };
  }

  const result = await daFetch(`/vouchers/${encodeURIComponent(id)}`, "PUT", updatePayload);
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to update voucher" };
    return { success: false, error: err };
  }
  return { success: true, data: result.json };
}

module.exports = {
  createVoucher,
  listVouchers,
  getVoucherById,
  updateVoucher,
};
