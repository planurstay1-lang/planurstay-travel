/**
 * Single source of truth for which LiteAPI key is active.
 *
 * PROD_API_KEY wins whenever it looks like a real prod key (prefix "prod_").
 * Every engine and the payment-SDK config must use this, so the key a booking
 * is made with always matches the payment environment (sandbox vs live).
 */
function liteApiKey() {
  const prod = (process.env.PROD_API_KEY || "").trim();
  const sand = (process.env.SAND_API_KEY || "").trim();
  if (prod.startsWith("prod_")) return prod;
  if (sand.startsWith("sand_")) return sand;
  return prod || sand || "";
}

function isSandbox() {
  return !liteApiKey().startsWith("prod_");
}

module.exports = { liteApiKey, isSandbox };
