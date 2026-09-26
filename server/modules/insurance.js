/**
 * Travel protection quotes from Sitata, shown at checkout as fixed prices ("Protect your trip +CA$24.50").
 * The customer pays for the flight/hotel through LiteAPI as usual; if they chose a plan, the confirmation
 * page opens Sitata's widget and Sitata charges for the policy (Sitata is merchant of record).
 *
 *   POST /api/insurance/quote  { currency, fromCountry, destCountry, start, end, totalCost, travellers, email? }
 *        → { enabled, plans: [{ id, productIds, name, total, perPerson, currency, benefits: [{ name, limit }] }] }
 *
 * Env: SITATA_API_KEY (private, server only), SITATA_ORG_ID, SITATA_API_BASE (default https://www.sitata.com).
 */
function createInsurance() {
  const env = (k) => String(process.env[k] || "").trim();
  const enabled = () => !!(env("SITATA_API_KEY") && env("SITATA_ORG_ID"));
  const base = () => (env("SITATA_API_BASE") || "https://www.sitata.com").replace(/\/$/, "");
  const cache = new Map(); // key → { at, plans }
  const TTL = 10 * 60 * 1000;

  const cc = (v) => (/^[A-Za-z]{2}$/.test(String(v || "")) ? String(v).toUpperCase() : null);
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const unix = (d, endOfDay) => Math.floor(Date.parse(`${d}T${endOfDay ? "23:59:59" : "00:00:00"}Z`) / 1000);
  const money = (amount, sym, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(amount); } catch { return `${sym || ""}${Math.round(amount)}`; } };

  // Turn Sitata quote objects into the few things the checkout box shows.
  function toPlans(raw) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
    return list.map(q => {
      const mod = +q.cost_modifier || 0.01, total = Math.round((+q.cost || 0) * mod * 100) / 100;
      const prod = (q.products || [])[0] || {};
      const benefits = (prod.benefits || []).filter(b => b.prominent !== false).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).slice(0, 4).map(b => ({
        name: String(b.name || b.description || "").slice(0, 60),
        limit: b.limit?.limit ? money(b.limit.limit * (+b.limit.cost_modifier || 0.01), b.limit.cost_symbol, b.limit.currency_code || q.currency_code) : null,
      })).filter(b => b.name);
      return {
        id: q.id, productIds: q.product_ids || [], currency: q.currency_code, total,
        perPerson: q.num_people > 0 ? Math.round(total / q.num_people * 100) / 100 : total,
        name: String(prod.name || prod.description || "Travel protection").slice(0, 60),
        benefits,
      };
    }).filter(p => p.id && p.total > 0).sort((a, b) => a.total - b.total).slice(0, 3);
  }

  async function quote(b) {
    const currency = /^[A-Z]{3}$/.test(String(b.currency || "")) ? b.currency : "USD";
    const from = cc(b.fromCountry) || "CA", dest = cc(b.destCountry), start = day(b.start), end = day(b.end) || start;
    const n = Math.min(Math.max(parseInt(b.travellers) || 1, 1), 9);
    if (!dest || !start || Date.parse(start) < Date.now() - 86400000) return [];
    const key = JSON.stringify([currency, from, dest, start, end, n, Math.round((+b.totalCost || 0) / 50)]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.plans;
    // Ages drive the price; before the traveller has entered birthdays we quote for adults aged 35.
    const bday = (i) => day(b.birthdays?.[i]) || `${new Date(start).getUTCFullYear() - 35}-06-15`;
    const body = {
      currency_code: currency, country_code: from,
      subscriptions: [{
        user: { name: "PlanurStay traveller", email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email || "") ? b.email : "quotes@planurstay.com", birthday: bday(0), home_country: from },
        beneficiaries: Array.from({ length: n - 1 }, (_, i) => ({ name: `Traveller ${i + 2}`, birthday: bday(i + 1), relation: 0 })),
      }],
      trip: {
        destinations: [{ country_code: dest, entry_date: unix(start), exit_date: unix(end, true), type: 0 }],
        start: unix(start), finish: unix(end, true),
        ...(+b.totalCost > 0 ? { total_cost: Math.round(+b.totalCost * 100), currency_code: currency } : {}),
      },
    };
    const r = await fetch(`${base()}/api/v2/products/with_quotes`, {
      method: "POST",
      headers: { Authorization: `TKN ${env("SITATA_API_KEY")}`, Organization: env("SITATA_ORG_ID"), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) { console.warn("Sitata quote:", r.status, JSON.stringify(j || {}).slice(0, 300)); return []; }
    const plans = toPlans(j);
    cache.set(key, { at: Date.now(), plans });
    if (cache.size > 2000) cache.clear();
    return plans;
  }

  function register(app) {
    app.post("/api/insurance/quote", async (req, res) => {
      if (!enabled()) return res.json({ success: true, enabled: false, plans: [] });
      try { res.json({ success: true, enabled: true, plans: await quote(req.body || {}) }); }
      catch (e) { console.warn("Sitata quote:", e.message); res.json({ success: true, enabled: true, plans: [] }); }
    });
  }
  return { register, toPlans };
}

module.exports = { createInsurance };
