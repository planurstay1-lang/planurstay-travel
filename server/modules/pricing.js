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

module.exports = {
  marginFor: (isMember) => (isMember ? MEMBER_MARGIN() : PUBLIC_MARGIN()),
  // Estimated member price for a public price (same net rate, different margin)
  memberFactor: () => (1 + MEMBER_MARGIN() / 100) / (1 + PUBLIC_MARGIN() / 100),
  // Whole-percent member saving, for marketing copy ("Members save about 8%")
  memberSavePct: () => Math.floor((1 - (1 + MEMBER_MARGIN() / 100) / (1 + PUBLIC_MARGIN() / 100)) * 100),
  setOverrides: (o) => { for (const k of ["publicMargin", "memberMargin"]) if (k in o) overrides[k] = o[k]; },
  PUBLIC_MARGIN, MEMBER_MARGIN,
};
