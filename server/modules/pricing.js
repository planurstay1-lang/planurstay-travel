/**
 * Pricing policy (LiteAPI `margin` = our commission, % added to the net rate).
 *
 * Hotels publish a Suggested Selling Price (SSP ≈ net + 15% on our live key). Selling below SSP
 * on a public page is a rate violation; below-SSP prices are only allowed in a closed user group
 * (signed-in members). So:
 *   PUBLIC_MARGIN (default 16) → public prices sit at/above SSP
 *   MEMBER_MARGIN (default 6)  → members get ~8–9% lower prices and we still earn commission
 * Offers that are still below SSP for a guest are flagged memberOnly (shown behind sign-in).
 */
const num = (v, d) => (Number.isFinite(+v) && v !== "" && v != null ? +v : d);
// Admin overrides (saved in the DB from /admin) win over env; env wins over defaults.
const overrides = {};
const PUBLIC_MARGIN = () => num(overrides.publicMargin, num(process.env.PUBLIC_MARGIN, 16));
const MEMBER_MARGIN = () => num(overrides.memberMargin, num(process.env.MEMBER_MARGIN, 6));

// ─── SSP-aware public pricing ───
// Rates are fetched at margin 0: we get our net cost and the hotel's own public price (SSP at margin 0).
// Guests pay the higher of net + PUBLIC_MARGIN and the hotel's price (rate parity), with the extra
// margin rounded UP to a 2.5% band so we stay at/above SSP and need few extra rate requests.
// (SSP returned at margin > 0 is recomputed from our own price for most hotels, so it can't be a floor.)
// Members (a closed user group) pay the guest price less the member saving (net + MEMBER_MARGIN on normal hotels).
const SSP_BAND = 2.5;
const MAX_MARGIN = () => num(process.env.MAX_SSP_MARGIN, 100);
const round2 = (x) => Math.round(x * 100) / 100;
function publicMargin(net, ssp0) {
  const P = PUBLIC_MARGIN();
  if (!(net > 0) || !(ssp0 > 0)) return P;
  const need = (ssp0 / net - 1) * 100;
  if (need <= P) return P;
  return Math.min(Math.ceil(need / SSP_BAND - 1e-9) * SSP_BAND, Math.max(P, MAX_MARGIN()));
}
// Paid members (Essential / Plus) get an extra few percent off hotels, never below PAID_FLOOR margin.
const PAID_EXTRA = () => ({ essential: num(process.env.PAID_EXTRA_ESSENTIAL, 2), plus: num(process.env.PAID_EXTRA_PLUS, 3) });
const PAID_FLOOR = () => num(process.env.PAID_MARGIN_FLOOR, 2);
const paidExtraPct = (planId) => PAID_EXTRA()[planId] || 0;
/** Price a net rate for this visitor. total = what they pay; publicTotal = the guest price (member strike-through).
 *  extraPct: extra margin points off for paid members (0 for everyone else). */
function priceFor(net, ssp0, member, extraPct = 0) {
  const pub = publicMargin(net, ssp0);
  // Members always save the same share off the guest price (about 8% at 16%/6%), also on hotels
  // priced up to their SSP, so the member saving matches the "Members save about X%" promise.
  const memberMargin = round2(((1 + pub / 100) * (1 + MEMBER_MARGIN() / 100) / (1 + PUBLIC_MARGIN() / 100) - 1) * 100);
  let margin = member ? Math.min(memberMargin, pub) : pub;
  if (member && extraPct > 0) margin = Math.max(Math.min(margin, PAID_FLOOR()), round2(margin - extraPct));
  return { margin, total: round2(net * (1 + margin / 100)), publicTotal: round2(net * (1 + pub / 100)) };
}

module.exports = {
  publicMargin, priceFor, paidExtraPct,
  marginFor: (isMember) => (isMember ? MEMBER_MARGIN() : PUBLIC_MARGIN()),
  // Estimated member price for a public price (same net rate, different margin)
  memberFactor: () => (1 + MEMBER_MARGIN() / 100) / (1 + PUBLIC_MARGIN() / 100),
  // Whole-percent member saving, for marketing copy ("Members save about 8%")
  memberSavePct: () => Math.floor((1 - (1 + MEMBER_MARGIN() / 100) / (1 + PUBLIC_MARGIN() / 100)) * 100),
  setOverrides: (o) => { for (const k of ["publicMargin", "memberMargin"]) if (k in o) overrides[k] = o[k]; },
  PUBLIC_MARGIN, MEMBER_MARGIN,
};
