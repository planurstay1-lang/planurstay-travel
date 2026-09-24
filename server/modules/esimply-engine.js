/**
 * eSIMply Engine — Nuitee LiteAPI eSIM API
 *
 * Requires `users.esimply_access` on your API key.
 *
 * Endpoints:
 *   GET    /esimply/destinations     → browse eSIM destinations + data packages
 *   POST   /esimply/orders           → purchase an eSIM (create order)
 *   GET    /esimply/orders           → list order history (filter by destination, date, clientReference)
 *   GET    /esimply/orders/:orderId  → single order details
 *   POST   /esimply/orders/:orderId/topup → top up an existing eSIM
 *   GET    /esimply/orders/:orderId/usage → usage details for an eSIM
 *
 * All calls go to https://api.liteapi.travel/v3.0
 */

const BASE = "https://api.liteapi.travel/v3.0";

async function apiCall(path, method = "GET", body = null) {
  const url = `${BASE}${path}`;
  const headers = {
    "X-API-Key": process.env.SAND_API_KEY || process.env.PROD_API_KEY || "",
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

function firstError(body) {
  if (body && body.error) {
    return {
      code:    body.error.code,
      message: body.error.message || "eSIMply operation failed",
      detail:  body.error.description || body.error.message,
    };
  }
  return null;
}

// ─── Destinations ─────────────────────────────────────────────────────────────

/**
 * Browse available eSIM destinations and data packages.
 *
 * Optional query params:
 *   countryCode       – ISO country code (e.g. "US", "FR")
 *   carrier           – carrier name filter
 *   minDataGb         – minimum data in GB
 *   maxPrice          – maximum price
 */
async function listDestinations(params = {}) {
  const query = new URLSearchParams();
  if (params.countryCode) query.set("countryCode", params.countryCode);
  if (params.carrier)     query.set("carrier",     params.carrier);
  if (params.minDataGb)   query.set("minDataGb",   params.minDataGb);
  if (params.maxPrice)    query.set("maxPrice",    params.maxPrice);
  if (params.page)        query.set("page",        params.page);
  if (params.limit)       query.set("limit",       params.limit);

  const path = "/data/esimply/destinations" + (query.toString() ? `?${query.toString()}` : "");
  const result = await apiCall(path);

  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch destinations" };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * Purchase an eSIM.
 *
 * Required body:
 *   destinationId  – from listDestinations
 *   dataPackageId  – data package to purchase
 *   clientReference? – your own reference (for lookup later)
 *   contact        – { firstName, lastName, email, phone }
 *   simInfo        – { iccid? } (if replacing an existing SIM)
 */
async function purchaseEsim(body) {
  if (!body.destinationId || !body.dataPackageId) {
    return { success: false, error: { code: 400, message: "destinationId and dataPackageId required", key: "bodyRequest.destinationId" } };
  }
  if (!body.contact || !body.contact.email) {
    return { success: false, error: { code: 400, message: "contact with email required", key: "bodyRequest.contact.email" } };
  }

  const result = await apiCall("/esimply/orders", "POST", body);
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to purchase eSIM", detail: result.json };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

/**
 * List eSIM order history.
 *
 * Optional query params:
 *   destinationId    – filter by destination
 *   startDate        – ISO date (e.g. "2026-01-01")
 *   endDate          – ISO date
 *   clientReference  – your own reference
 *   page / limit
 */
async function listOrders(params = {}) {
  const query = new URLSearchParams();
  if (params.destinationId) query.set("destinationId", params.destinationId);
  if (params.startDate)     query.set("startDate",     params.startDate);
  if (params.endDate)       query.set("endDate",       params.endDate);
  if (params.clientReference) query.set("clientReference", params.clientReference);
  if (params.page)          query.set("page",          params.page);
  if (params.limit)         query.set("limit",         params.limit);

  const path = "/esimply/orders" + (query.toString() ? `?${query.toString()}` : "");
  const result = await apiCall(path);

  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch orders" };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

/**
 * Get a single eSIM order by ID.
 */
async function getOrder(orderId) {
  if (!orderId) {
    return { success: false, error: { code: 400, message: "orderId required", key: "orderId" } };
  }
  const result = await apiCall(`/esimply/orders/${encodeURIComponent(orderId)}`);
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch order", detail: result.json };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

/**
 * Top up an existing eSIM.
 *
 * Required body:
 *   orderId        – the eSIM order to top up
 *   dataPackageId  – the data package to add
 */
async function topUpEsim(orderId, dataPackageId) {
  if (!orderId || !dataPackageId) {
    return { success: false, error: { code: 400, message: "orderId and dataPackageId required" } };
  }
  const result = await apiCall(`/esimply/orders/${encodeURIComponent(orderId)}/topup`, "POST", { dataPackageId });
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to top up eSIM", detail: result.json };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

/**
 * Get usage details for an eSIM.
 */
async function getEsimUsage(orderId) {
  if (!orderId) {
    return { success: false, error: { code: 400, message: "orderId required", key: "orderId" } };
  }
  const result = await apiCall(`/esimply/orders/${encodeURIComponent(orderId)}/usage`);
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch usage", detail: result.json };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

// ─── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  listDestinations,
  purchaseEsim,
  listOrders,
  getOrder,
  topUpEsim,
  getEsimUsage,
};
