/**
 * Market pricing for Travellez (MCP) hotels and fares.
 *
 * When the same hotel or flight is also sold through LiteAPI, LiteAPI's guest price is the market price (hotels: at or
 * above the hotel's own public price). Instead of a flat markup we sell just under it:
 *   margin = what puts us `undercut`% below the market, capped at `max`
 *   - if even `min` can't beat the market, the flat markup stays (LiteAPI's price wins the card anyway)
 *   - nothing to compare with → the flat markup
 * Settings come from /admin (saved in site_settings), else env, else the defaults below.
 */
const crypto = require("crypto");
const num = (v, d) => (Number.isFinite(+v) && v !== "" && v != null ? +v : d);
const round2 = (x) => Math.round(x * 100) / 100;

const DEFAULTS = { on: true, hotelMin: 4, hotelMax: 25, hotelUndercut: 1, flightMin: 1.5, flightMax: 8, flightUndercut: 0.5 };
const ENV = { hotelMin: "MARKET_HOTEL_MIN_PCT", hotelMax: "MARKET_HOTEL_MAX_PCT", hotelUndercut: "MARKET_HOTEL_UNDERCUT_PCT",
  flightMin: "MARKET_FLIGHT_MIN_PCT", flightMax: "MARKET_FLIGHT_MAX_PCT", flightUndercut: "MARKET_FLIGHT_UNDERCUT_PCT" };
const overrides = {};
function settings() {
  const s = { on: overrides.on ?? process.env.MARKET_PRICING !== "off" };
  for (const k of Object.keys(ENV)) s[k] = num(overrides[k], num(process.env[ENV[k]], DEFAULTS[k]));
  return s;
}
/** Admin save: validates and keeps only known keys. Returns the effective settings, or throws on bad input. */
function setSettings(o = {}) {
  const next = { ...overrides };
  if ("on" in o) next.on = !!o.on;
  for (const k of Object.keys(ENV)) if (k in o && o[k] !== "" && o[k] != null) {
    const v = +o[k];
    if (!Number.isFinite(v) || v < 0 || v > (k.endsWith("Undercut") ? 10 : 40)) throw new Error(`${k} must be between 0 and ${k.endsWith("Undercut") ? 10 : 40}`);
    next[k] = v;
  }
  const s = { ...settings(), ...next };
  if (s.hotelMin > s.hotelMax || s.flightMin > s.flightMax) throw new Error("The minimum can't be above the maximum");
  Object.assign(overrides, next);
  return settings();
}

// What we did in recent searches, for the admin page (in memory; resets on restart)
const stats = { hotel: { n: 0, sum: 0, up: 0, down: 0 }, flight: { n: 0, sum: 0, up: 0, down: 0 } };

/** Margin % for a net cost (customer's currency) given the market price for the same thing, in the same currency. */
function marginFor(kind, net, market, flat) {
  const s = settings(), k = kind === "flight" ? "flight" : "hotel";
  if (!s.on || !(net > 0) || !(market > 0)) return flat;
  const need = (market * (1 - s[k + "Undercut"] / 100) / net - 1) * 100;
  if (need < s[k + "Min"]) return flat; // can't beat the market without going under our floor
  const m = round2(Math.min(s[k + "Max"], need));
  const st = stats[k]; st.n++; st.sum += m; if (m > flat) st.up++; else if (m < flat) st.down++;
  return m;
}
const sellAt = (net, pct) => Math.ceil(net * (1 + pct / 100) * 100) / 100;

// Flight offers travel through the browser (offer id), so a market margin in them is signed: an edited one is ignored.
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const sign = (o) => crypto.createHmac("sha256", SECRET).update(JSON.stringify(o)).digest("base64url").slice(0, 22);
function withSig(o) { const { g, ...rest } = o; return rest.m == null ? rest : { ...rest, g: sign(rest) }; }
/** Margin carried by an offer, if its signature is valid and it's within today's limits; otherwise null. */
function signedMargin(o) {
  if (!o || o.m == null || !o.g) return null;
  const { g, ...rest } = o;
  const a = Buffer.from(String(g)), b = Buffer.from(sign(rest));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const s = settings(), m = +o.m;
  return Number.isFinite(m) && m >= 0 && m <= s.flightMax ? m : null;
}

module.exports = {
  settings, setSettings, marginFor, sellAt, withSig, signedMargin,
  stats: () => Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { repriced: v.n, avgMargin: v.n ? round2(v.sum / v.n) : null, raised: v.up, lowered: v.down }])),
};
