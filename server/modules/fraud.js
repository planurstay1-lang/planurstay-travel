/**
 * Card safety for bookings PlanurStay pays for itself (Travellez flights, hotels, cars): Travellez charges our company
 * card the moment we book, so a stolen card that's disputed later is our loss. Three layers:
 *   1. Before the hold: daily spend / booking caps per customer (account, email or IP) and for the whole site.
 *   2. The hold asks the bank for 3D Secure above a set amount (the customer confirms in their banking app;
 *      a disputed 3DS payment is usually the bank's loss, not ours).
 *   3. After the card is authorized, before we book: Stripe Radar's risk verdict. "Highest" risk is never booked;
 *      "elevated" is booked only if the bank confirmed the customer with 3D Secure. A held-back booking releases the
 *      customer's card and emails support.
 * Settings: /admin (saved in site_settings 'fraudSettings'), else env, else the defaults below. Amounts in USD.
 */
const num = (v, d) => (Number.isFinite(+v) && v !== "" && v != null ? +v : d);
const DEFAULTS = { threeDsAboveUsd: 250, elevatedAboveUsd: 0, customerDailyUsd: 3000, customerDailyBookings: 4, dailyTotalUsd: 20000 };
const ENV = { threeDsAboveUsd: "FRAUD_3DS_ABOVE_USD", elevatedAboveUsd: "FRAUD_ELEVATED_ABOVE_USD", customerDailyUsd: "FRAUD_CUSTOMER_DAILY_USD",
  customerDailyBookings: "FRAUD_CUSTOMER_DAILY_BOOKINGS", dailyTotalUsd: "FRAUD_DAILY_TOTAL_USD" };
const TABLES = ["mcp_bookings", "car_bookings"];
const ZERO_DEC = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XOF", "XAF", "PYG", "RWF"]);
// Bookings that use up today's allowance: made or being made. Unpaid holds don't (a customer may retry checkout);
// the limits are checked again right before booking, so opening many holds first doesn't get around them.
const LIVE = "status IN ('confirmed', 'pending_confirmation', 'booking')";

let db = null, sendEmail = null, overrides = {}, alertedDay = null;
const fail = (msg, status) => Object.assign(new Error(msg), { status });

/** Called by every module that books (and admin). Safe to call more than once. */
function init(o = {}) {
  if (o.sendEmail) sendEmail = o.sendEmail;
  if (!o.db) return api;
  // Booking tables are created by their own modules, possibly after this runs first: add the columns on every call
  for (const t of TABLES) for (const col of ["client_ip TEXT", "email TEXT"]) { try { o.db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch { /* exists, or table not created yet */ } }
  if (db === o.db) return api;
  db = o.db;
  try {
    db.exec("CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    overrides = JSON.parse(db.prepare("SELECT value FROM site_settings WHERE key = 'fraudSettings'").get()?.value || "{}");
  } catch { overrides = {}; }
  return api;
}
function settings() { const s = {}; for (const k of Object.keys(DEFAULTS)) s[k] = num(overrides[k], num(process.env[ENV[k]], DEFAULTS[k])); return s; }
function setSettings(o = {}) {
  const next = { ...overrides };
  for (const k of Object.keys(DEFAULTS)) if (k in o && o[k] !== "" && o[k] != null) {
    const v = +o[k];
    if (!Number.isFinite(v) || v < 0 || v > 1e7) throw new Error(`${k} must be a positive number`);
    next[k] = k === "customerDailyBookings" ? Math.round(v) : v;
  }
  overrides = next;
  db?.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('fraudSettings', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(JSON.stringify(next));
  return settings();
}

/** The visitor's IP: Cloudflare's header if present (it can't be faked through Cloudflare), else the last proxy hop. */
function clientIp(req) {
  const h = req?.headers || {};
  if (h["cf-connecting-ip"]) return String(h["cf-connecting-ip"]).trim().slice(0, 64);
  const xff = String(h["x-forwarded-for"] || "").split(",").map(x => x.trim()).filter(Boolean);
  return (xff[xff.length - 1] || req?.socket?.remoteAddress || "").slice(0, 64);
}

async function toUsd(amount, currency) {
  const cur = String(currency || "USD").toUpperCase();
  if (cur === "USD" || !(amount > 0)) return +amount || 0;
  const rates = await require("./mcp").fxRates().catch(() => null);
  return rates?.[cur] > 0 ? amount / rates[cur] : amount; // unknown currency: count it at face value (errs on the safe side for most)
}
async function spend(where, args, excludeRef) {
  let usd = 0, count = 0;
  for (const t of TABLES) {
    let rows = [];
    try { rows = db.prepare(`SELECT currency, SUM(amount) AS amt, COUNT(*) AS n FROM ${t} WHERE created_at >= datetime('now', '-1 day') AND ${LIVE} AND ref != ?${where ? ` AND (${where})` : ""} GROUP BY currency`).all(excludeRef || "", ...args); } catch { continue; }
    for (const r of rows) { usd += await toUsd(r.amt || 0, r.currency); count += r.n; }
  }
  return { usd, count };
}

const SITE_MSG = "Online booking is paused for the rest of today. Please contact us and we'll book it for you.";
const CUSTOMER_MSG = "For your security we can't take another online booking today. Please contact us and we'll help you finish it.";
/** Would a booking of `usd` pass today's limits? null if fine, else "site" or "customer". */
async function overCaps({ usd, userId, email, ip, excludeRef }) {
  const s = settings();
  const total = await spend("", [], excludeRef);
  if (s.dailyTotalUsd > 0 && total.usd + usd > s.dailyTotalUsd) { alertTotal(total.usd, usd, s.dailyTotalUsd); return "site"; }
  const em = String(email || "").trim().toLowerCase(), who = [], args = [];
  if (userId) { who.push("user_id = ?"); args.push(userId); }
  if (em) { who.push("email = ?"); args.push(em); }
  if (ip) { who.push("client_ip = ?"); args.push(ip); }
  if (!who.length) return null;
  const mine = await spend(who.join(" OR "), args, excludeRef);
  if ((s.customerDailyBookings > 0 && mine.count >= s.customerDailyBookings) || (s.customerDailyUsd > 0 && mine.usd + usd > s.customerDailyUsd)) {
    console.warn(`Fraud cap: customer over today's limit (${mine.count} bookings, $${Math.round(mine.usd + usd)})`, em || userId || ip);
    return "customer";
  }
  return null;
}

/** Before creating a hold. Throws (429) when a limit would be passed; returns { threeDs, usd }. */
async function preCheck({ req, amount, currency, email, userId }) {
  const s = settings(), usd = await toUsd(+amount || 0, currency);
  if (db) {
    const over = await overCaps({ usd, userId, email, ip: clientIp(req) });
    if (over) throw fail(over === "site" ? SITE_MSG : CUSTOMER_MSG, 429);
  }
  return { threeDs: usd >= s.threeDsAboveUsd, usd };
}
function alertTotal(today, extra, cap) {
  const d = new Date().toISOString().slice(0, 10);
  if (alertedDay === d) return;
  alertedDay = d;
  console.warn(`Fraud cap: site daily total reached ($${Math.round(today)} + $${Math.round(extra)} > $${cap})`);
  if (sendEmail && process.env.SUPPORT_EMAIL) sendEmail({ to: process.env.SUPPORT_EMAIL, subject: "PlanurStay: daily booking limit reached",
    html: `<p>Online bookings PlanurStay pays for (Travellez flights, hotels, cars) reached today's limit of $${cap} USD ($${Math.round(today)} booked). New bookings are paused until tomorrow.</p><p>If this is genuine demand, raise the limit in /admin → Card safety.</p>` }).catch(() => {});
}

/** 3D Secure needed for this amount? (Pay-at-hotel card guarantees: the stay's value, nothing charged.) */
const needs3ds = async (amount, currency) => (await toUsd(+amount || 0, currency)) >= settings().threeDsAboveUsd;
/** Extra Stripe options for the hold: ask the bank for 3D Secure. */
const holdOptions = (threeDs) => (threeDs ? { payment_method_options: { card: { request_three_d_secure: "any" } } } : {});

/** Remember who made the booking (for the per-customer caps). */
function tag(table, ref, req, email) {
  if (!db || !TABLES.includes(table)) return;
  try { db.prepare(`UPDATE ${table} SET client_ip = ?, email = COALESCE(email, ?) WHERE ref = ?`).run(clientIp(req) || null, email ? String(email).toLowerCase() : null, ref); } catch { /* never block a booking on this */ }
}

/** After authorization, before booking with the supplier. { ok } or { ok: false, reason }. Stripe errors → allowed
 *  (Radar has already blocked the worst cards at authorization). */
async function review(stripe, pi, { ref, kind, table } = {}) {
  try {
    // Limits again, now that the card is approved (several holds opened first are counted one by one as they book)
    const r = db && TABLES.includes(table) ? db.prepare(`SELECT user_id, email, client_ip, amount, currency FROM ${table} WHERE ref = ?`).get(ref) : null;
    if (r) {
      const over = await overCaps({ usd: await toUsd(r.amount || 0, r.currency), userId: r.user_id, email: r.email, ip: r.client_ip, excludeRef: ref });
      if (over) return heldBack(pi, ref, kind, over === "site" ? "Daily limit: whole site" : "Daily limit: this customer");
    }
    const chId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
    if (!chId) return { ok: true };
    const ch = typeof pi.latest_charge === "object" && pi.latest_charge?.outcome ? pi.latest_charge : await stripe.charges.retrieve(chId);
    const risk = ch?.outcome?.risk_level, score = ch?.outcome?.risk_score;
    const tds = ch?.payment_method_details?.card?.three_d_secure;
    const authenticated = tds && ["authenticated", "attempt_acknowledged"].includes(tds.result);
    const usd = await toUsd((pi.amount || 0) / (ZERO_DEC.has(String(pi.currency).toUpperCase()) ? 1 : 100), pi.currency);
    let reason = null;
    if (risk === "highest") reason = `Stripe Radar: highest risk${score != null ? ` (score ${score})` : ""}`;
    else if (risk === "elevated" && !authenticated && usd >= settings().elevatedAboveUsd) reason = `Stripe Radar: elevated risk${score != null ? ` (score ${score})` : ""}, no 3D Secure`;
    if (!reason) return { ok: true, risk, authenticated: !!authenticated };
    return heldBack(pi, ref, kind, reason);
  } catch (e) { console.warn("Fraud review skipped:", e.message); return { ok: true }; }
}
function heldBack(pi, ref, kind, reason) {
  console.warn(`Fraud review held back ${kind || "booking"} ${ref}: ${reason}`);
  if (sendEmail && process.env.SUPPORT_EMAIL) sendEmail({ to: process.env.SUPPORT_EMAIL, subject: `Booking held back for card safety: ${ref}`,
    html: `<p>${kind || "Booking"} ${ref} was <b>not booked</b>: ${reason}. The customer's card hold was released and nothing was charged.</p><p>Payment: ${pi.id} in Stripe. If the customer contacts you and checks out, book it for them manually.</p>` }).catch(() => {});
  return { ok: false, reason };
}
const REVIEW_MSG = "We couldn't complete this booking online. The hold on your card has been released. Please contact us and we'll help you book it.";

/** For /admin: settings + what happened in the last 30 days. */
function overview() {
  let heldBack = 0;
  for (const t of TABLES) { try { heldBack += db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE status = 'failed' AND error LIKE 'Payment review:%' AND created_at >= datetime('now', '-30 days')`).get().n; } catch { /* table missing */ } }
  return { settings: settings(), heldBack30d: heldBack };
}

const api = { init, needs3ds, settings, setSettings, preCheck, holdOptions, tag, review, clientIp, overview, REVIEW_MSG };
module.exports = api;
