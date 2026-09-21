/**
 * Loyalty Engine — PlanurStay Internal Points & Tiers System
 *
 * local loyalty (our own points program, stored in our DB)
 * plus LiteAPI loyalty API wrapper (for guest-level data from LiteAPI side)
 *
 * Points system (local):
 *   - Earn: 5 points per $1 spent (base rate, increases with tier)
 *   - Redeem: 500 points = $5 off (fixed amount discount via one-time voucher)
 *   - Signup bonus: 500 points
 *   - First booking bonus: 1,000 points
 *
 * Tiers (based on lifetime earned points):
 *   - explorer:  0+     → 5 pts/$1
 *   - traveler:  5,000+ → 7 pts/$1
 *   - frequent:  25,000+ → 10 pts/$1
 *   - elite:     100,000+ → 12 pts/$1
 *
 * Redemption flow:
 *   - User redeems N points → we create a one-time-use fixed-amount voucher
 *   - Voucher is applied to their next prebook via voucherCode
 *   - 500 pts = $5 off, 1000 pts = $10 off, etc.
 *
 * LiteAPI loyalty API wrapper (for guest data sync):
 *   - getLoyaltySettings()   — get current LiteAPI loyalty program settings
 *   - getGuestLoyalty(guestId) — get a guest's loyalty status from LiteAPI
 */

const Database = require("better-sqlite3");

// ─── Tier config ────────────────────────────────────────────────────────────
const TIERS = {
  explorer: { min: 0,      earnRate: 5,  label: "Explorer", color: "#6b7280" },
  traveler: { min: 5000,   earnRate: 7,  label: "Traveler", color: "#3b82f6" },
  frequent: { min: 25000,  earnRate: 10, label: "Frequent", color: "#8b5cf6" },
  elite:    { min: 100000, earnRate: 12, label: "Elite",    color: "#f59e0b" },
};

const POINTS_PER_DOLLAR = 5;
const REDEMPTION_RATE   = 500; // 500 pts = $5 discount

function getTier(lifetimePoints) {
  let tier = "explorer";
  for (const [name, cfg] of Object.entries(TIERS)) {
    if (lifetimePoints >= cfg.min) tier = name;
  }
  return tier;
}

function getEarnRate(tier) {
  return TIERS[tier]?.earnRate || 5;
}

// ─── Local DB functions (require db connection) ─────────────────────────────

function initUserLoyalty(db, userId) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO loyalty_points (user_id, points, lifetime, tier)
      VALUES (?, 0, 0, 'explorer')
    `).run(userId);
    return true;
  } catch (e) {
    console.error("Loyalty init error:", e.message);
    return false;
  }
}

function getBalance(db, userId) {
  const row = db.prepare(`
    SELECT lp.*, u.email
    FROM loyalty_points lp
    JOIN users u ON u.id = lp.user_id
    WHERE lp.user_id = ?
  `).get(userId);

  if (!row) return null;

  const tier = getTier(row.lifetime);
  if (tier !== row.tier) {
    db.prepare("UPDATE loyalty_points SET tier = ?, updated_at = DATETIME('now') WHERE user_id = ?")
      .run(tier, userId);
  }

  return {
    userId:      row.user_id,
    points:      row.points,
    lifetime:    row.lifetime,
    tier:        tier,
    tierLabel:   TIERS[tier]?.label || "Explorer",
    tierColor:   TIERS[tier]?.color || "#6b7280",
    earnRate:    getEarnRate(tier),
    email:       row.email,
  };
}

function earnPoints(db, userId, amount, currency, bookingId, description) {
  const row = db.prepare("SELECT * FROM loyalty_points WHERE user_id = ?").get(userId);
  if (!row) return { success: false, error: "No loyalty record" };

  const currentTier = getTier(row.lifetime);
  const earnRate = getEarnRate(currentTier);
  const pointsToEarn = Math.floor(amount * earnRate);
  const newPoints = row.points + pointsToEarn;
  const newLifetime = row.lifetime + pointsToEarn;
  const newTier = getTier(newLifetime);

  db.prepare(`
    UPDATE loyalty_points
    SET points = ?, lifetime = ?, tier = ?, updated_at = DATETIME('now')
    WHERE user_id = ?
  `).run(newPoints, newLifetime, newTier, userId);

  db.prepare(`
    INSERT INTO loyalty_transactions (user_id, type, points, balance_after, description, booking_id)
    VALUES (?, 'earn', ?, ?, ?, ?)
  `).run(userId, pointsToEarn, newPoints, description || `Booking $${amount} ${currency}`, bookingId || null);

  return {
    success: true,
    earned: pointsToEarn,
    newBalance: newPoints,
    newLifetime: newLifetime,
    newTier: newTier,
    tierUpgraded: newTier !== currentTier,
  };
}

function redeemPoints(db, userId, pointsToRedeem) {
  const row = db.prepare("SELECT * FROM loyalty_points WHERE user_id = ?").get(userId);
  if (!row) return { success: false, error: "No loyalty record" };
  if (row.points < pointsToRedeem) {
    return { success: false, error: `Insufficient points: have ${row.points}, need ${pointsToRedeem}` };
  }

  const discountUsd = Math.floor(pointsToRedeem / REDEMPTION_RATE) * 5;
  const actualPointsUsed = (discountUsd / 5) * REDEMPTION_RATE; // round down to nearest 500

  if (actualPointsUsed === 0) {
    return { success: false, error: "Minimum 500 points required for redemption" };
  }

  const newPoints = row.points - actualPointsUsed;

  db.prepare(`
    UPDATE loyalty_points
    SET points = ?, updated_at = DATETIME('now')
    WHERE user_id = ?
  `).run(newPoints, userId);

  db.prepare(`
    INSERT INTO loyalty_transactions (user_id, type, points, balance_after, description)
    VALUES (?, 'redeem', ?, ?, 'Redeemed for $${discountUsd} discount')
  `).run(userId, actualPointsUsed, newPoints);

  return {
    success: true,
    pointsUsed: actualPointsUsed,
    discountUsd: discountUsd,
    newBalance: newPoints,
  };
}

function createRedeemVoucher(db, userId, discountUsd, pointsUsed) {
  const code = "PTS" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 5).toUpperCase();

  const result = db.prepare(`
    INSERT INTO vouchers (code, discount_type, discount_value, currency, valid_from, valid_until, max_uses, used_count, status, description)
    VALUES (?, 'fixed', ?, 'USD', DATE('now'), DATE('now', '+7 days'), 1, 0, 'active', ?)
  `).run(code, discountUsd, `Points redemption: ${pointsUsed} pts → $${discountUsd}`);

  return { code, voucherId: result.lastInsertRowid };
}

function getHistory(db, userId, limit = 20) {
  return db.prepare(`
    SELECT lt.*, u.email
    FROM loyalty_transactions lt
    JOIN users u ON u.id = lt.user_id
    WHERE lt.user_id = ?
    ORDER BY lt.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

function awardSignupBonus(db, userId) {
  // 500 point welcome bonus
  return earnPoints(db, userId, 100, "USD", null, "Welcome bonus — join PlanurStay");
}

// ─── LiteAPI loyalty API wrapper (for guest-level data) ────────────────────

const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";

async function liteApiCall(path, method = "GET", body = null) {
  const url = `${LITEAPI_BASE}${path}`;
  const headers = {
    "X-API-Key": process.env.PROD_API_KEY || process.env.SAND_API_KEY || "",
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
      code: body.error.code,
      message: body.error.message || "Loyalty operation failed",
      detail: body.error.description || body.error.message,
    };
  }
  return null;
}

async function getLoyaltySettings() {
  const result = await liteApiCall("/loyalties");
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to fetch loyalty settings" };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

async function setLoyalty(body) {
  const result = await liteApiCall("/loyalties", "POST", body);
  if (!result.ok) {
    const err = firstError(result.json) || { code: result.status, message: "Failed to set loyalty settings" };
    return { success: false, error: err };
  }
  return { success: true, data: result.json.data || result.json };
}

async function getGuestLoyalty(guestId) {
  if (!guestId) return { success: false, error: { code: 400, message: "guestId required" } };
  const result = await liteApiCall(`/guests/${encodeURIComponent(guestId)}/loyalty`);
  if (result.ok && result.json.data) {
    return { success: true, data: result.json.data };
  }
  // Fallback
  const guestResult = await liteApiCall(`/guests/${encodeURIComponent(guestId)}`);
  if (guestResult.ok && guestResult.json.data) {
    const d = guestResult.json.data;
    return {
      success: true,
      data: {
        status: d.loyaltyStatus || "active",
        cashback: d.loyaltyCashback || d.cashback || 0,
        points: d.loyaltyPoints || d.points || 0,
        upcomingPoints: d.upcomingPoints || 0,
        tier: d.loyaltyTier || d.tier || "standard",
        guestId,
      },
    };
  }
  const err = firstError(guestResult.json) || { code: guestResult.status, message: "Failed to fetch guest loyalty" };
  return { success: false, error: err };
}

// ─── Module exports ─────────────────────────────────────────────────────────

/**
 * Load loyalty engine with a DB connection.
 * Returns local DB functions + LiteAPI wrappers.
 */
function loadLoyaltyEngine(dbConn) {
  return {
    // Local DB functions
    getBalance:             (userId) => getBalance(dbConn, userId),
    earnPoints:             (userId, amount, currency, bookingId, description) =>
                              earnPoints(dbConn, userId, amount, currency, bookingId, description),
    redeemPoints:           (userId, points) => redeemPoints(dbConn, userId, points),
    createRedeemVoucher:    (userId, discountUsd, pointsUsed) =>
                              createRedeemVoucher(dbConn, userId, discountUsd, pointsUsed),
    getHistory:             (userId, limit) => getHistory(dbConn, userId, limit),
    awardSignupBonus:       (userId) => awardSignupBonus(dbConn, userId),
    initUser:               (userId) => initUserLoyalty(dbConn, userId),
    // LiteAPI wrappers
    getLoyaltySettings,
    setLoyalty,
    getGuestLoyalty,
    // Constants
    TIERS,
    POINTS_PER_DOLLAR,
    REDEMPTION_RATE,
    getTier,
    getEarnRate,
  };
}

// Export both the loader and standalone wrappers
module.exports = {
  loadLoyaltyEngine,
  getTier,
  getEarnRate,
  TIERS,
  POINTS_PER_DOLLAR,
  REDEMPTION_RATE,
  // LiteAPI wrappers (standalone, no DB needed)
  getLoyaltySettings,
  setLoyalty,
  getGuestLoyalty,
};
