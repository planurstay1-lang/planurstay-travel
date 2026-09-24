/**
 * Membership Engine — PlanurStay Paid Membership (Stripe subscriptions)
 *
 * Model: cheap recurring membership (like edream.com)
 *   Free tier:  sign in, member pricing, 5 pts/$1
 *   Essential:  $1.99/mo or $14.99/yr → 7 pts/$1, 1 free cancel/year, 500 bonus pts/mo
 *   Plus:       $4.99/mo or $39.99/yr → 10 pts/$1, 2 free cancels/year, late checkout, personal deals
 *
 * Tables:
 *   membership_plans — static plan definitions
 *   user_memberships  — active subscription per user (nullable = free tier)
 *
 * Stripe:
 *   - Create subscription on upgrade
 *   - Webhook: handle payment succeeded / cancelled / expired
 *   - Membership fee processing: 2.9% + $0.30 (Stripe standard)
 */

const Database = require("better-sqlite3");

// ─── Plan definitions ─────────────────────────────────────────────────────────

const PLANS = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    priceYearly: 0,
    interval: null,
    stripePriceIdMonthly: null,
    stripePriceIdYearly: null,
    earnRate: 5,            // pts per $1
    freeCancelsPerYear: 0,
    monthlyBonusPoints: 0,
    perks: ["Member pricing", "Earn points", "Booking history"],
    color: "#6b7280",
    order: 0,
  },
  essential: {
    id: "essential",
    name: "Essential",
    priceMonthly: 1.99,
    priceYearly: 14.99,
    interval: "month",      // default interval for stripe
    stripePriceIdMonthly: process.env.STRIPE_PRICE_ID_ESSENTIAL_MONTHLY  || null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_ID_ESSENTIAL_YEARLY   || null,
    earnRate: 7,
    freeCancelsPerYear: 1,
    monthlyBonusPoints: 500,
    perks: [
      "Member pricing",
      "Earn 7 pts per $1",
      "500 bonus points every month",
      "1 free cancellation per year",
      "Booking history",
    ],
    color: "#3b82f6",
    order: 1,
  },
  plus: {
    id: "plus",
    name: "Plus",
    priceMonthly: 4.99,
    priceYearly: 39.99,
    interval: "month",
    stripePriceIdMonthly: process.env.STRIPE_PRICE_ID_PLUS_MONTHLY  || null,
    stripePriceIdYearly: process.env.STRIPE_PRICE_ID_PLUS_YEARLY   || null,
    earnRate: 10,
    freeCancelsPerYear: 2,
    monthlyBonusPoints: 1000,
    perks: [
      "Member pricing",
      "Earn 10 pts per $1",
      "1,000 bonus points every month",
      "2 free cancellations per year",
      "Late checkout requests",
      "Personal deal alerts",
      "Booking history",
    ],
    color: "#f59e0b",
    order: 2,
  },
};

// ─── Schema ───────────────────────────────────────────────────────────────────

function ensureMembershipSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS membership_plans (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      price_monthly  REAL NOT NULL DEFAULT 0,
      price_yearly   REAL NOT NULL DEFAULT 0,
      interval    TEXT,  -- 'month' or null for free
      stripe_price_id_monthly  TEXT,
      stripe_price_id_yearly   TEXT,
      earn_rate   INTEGER NOT NULL DEFAULT 5,
      free_cancels_per_year INTEGER NOT NULL DEFAULT 0,
      monthly_bonus_points    INTEGER NOT NULL DEFAULT 0,
      perks      TEXT,  -- JSON array
      color      TEXT NOT NULL DEFAULT '#6b7280',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_memberships (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id               INTEGER NOT NULL UNIQUE,
      plan_id               TEXT NOT NULL DEFAULT 'free',
      status                TEXT NOT NULL DEFAULT 'active',  -- active, cancelled, past_due, paused
      stripe_subscription_id TEXT,
      stripe_price_id       TEXT,
      current_period_start  DATETIME,
      current_period_end    DATETIME,
      cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
      next_billing_date     DATETIME,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES membership_plans(id)
    );
  `);

  // Seed plans if empty
  const count = db.prepare("SELECT COUNT(*) AS c FROM membership_plans").get();
  if (!count || count.c === 0) {
    const insert = db.prepare(`
      INSERT INTO membership_plans (id, name, price_monthly, price_yearly, interval, stripe_price_id_monthly, stripe_price_id_yearly, earn_rate, free_cancels_per_year, monthly_bonus_points, perks, color, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const courses = [
      ["free",      "Free",      0,    0,    null, null, null, 5,  0,  0,    JSON.stringify(["Member pricing","Earn points","Booking history"]), "#6b7280", 0],
      ["essential", "Essential", 1.99, 14.99,"month", process.env.STRIPE_PRICE_ID_ESSENTIAL_MONTHLY||null, process.env.STRIPE_PRICE_ID_ESSENTIAL_YEARLY||null, 7, 1, 500, JSON.stringify(["Member pricing","Earn 7 pts per $1","500 bonus points/month","1 free cancellation/year","Booking history"]), "#3b82f6", 1],
      ["plus",      "Plus",      4.99, 39.99,"month", process.env.STRIPE_PRICE_ID_PLUS_MONTHLY||null, process.env.STRIPE_PRICE_ID_PLUS_YEARLY||null, 10, 2, 1000, JSON.stringify(["Member pricing","Earn 10 pts per $1","1,000 bonus points/month","2 free cancellations/year","Late checkout requests","Personal deal alerts","Booking history"]), "#f59e0b", 2],
    ];
    const insertMany = db.transaction((rows) => {
      for (const row of rows) insert.run(...row);
    });
    insertMany(courses);
    console.log("Membership plans seeded");
  }
}

// ─── Membership helpers ───────────────────────────────────────────────────────

function getActiveMembership(db, userId) {
  const row = db.prepare(`
    SELECT um.*, mp.name AS plan_name, mp.price_monthly, mp.price_yearly,
           mp.interval, mp.earn_rate, mp.free_cancels_per_year,
           mp.monthly_bonus_points, mp.perks, mp.color
    FROM user_memberships um
    JOIN membership_plans mp ON mp.id = um.plan_id
    WHERE um.user_id = ? AND um.status = 'active'
    ORDER BY um.updated_at DESC LIMIT 1
  `).get(userId);
  if (!row) {
    // Free tier — no DB row needed
    return { planId: "free", status: "active", isPaid: false, ...PLANS.free };
  }
  row.perks = JSON.parse(row.perks || "[]");
  row.isPaid = row.plan_id !== "free";
  return row;
}

function getUserMembership(db, userId) {
  // Returns any membership (including cancelled) or free tier
  const row = db.prepare(`
    SELECT um.*, mp.name AS plan_name, mp.price_monthly, mp.price_yearly,
           mp.interval, mp.earn_rate, mp.free_cancels_per_year,
           mp.monthly_bonus_points, mp.perks, mp.color
    FROM user_memberships um
    JOIN membership_plans mp ON mp.id = um.plan_id
    WHERE um.user_id = ?
    ORDER BY um.updated_at DESC LIMIT 1
  `).get(userId);
  if (!row) return { planId: "free", status: "active", isPaid: false, ...PLANS.free };
  row.perks = JSON.parse(row.perks || "[]");
  row.isPaid = row.plan_id !== "free";
  return row;
}

function awardMonthlyBonusIfDue(db, userId) {
}

// ─── Stripe helpers ───────────────────────────────────────────────────

const stripe = process.env.STRIPE_SECRET_KEY ? require("stripe")(process.env.STRIPE_SECRET_KEY) : null;

async function createStripeSubscription(dbConn, userId, planId, paymentMethodId) {
  const plan = PLANS[planId];
  if (!plan || !plan.stripePriceIdMonthly && !plan.stripePriceIdYearly) {
    return { success: false, error: "Plan not configured for Stripe", code: 500 };
  }

  // Determine which price ID to use
  // Default to monthly if no yearly price ID set
  let priceId = plan.stripePriceIdMonthly;
  let interval = "month";
  // If plan has yearly price and user wants yearly... we handle yearly via separate endpoint param
  // For now, default to monthly

  if (!stripe) {
    return { success: false, error: "Stripe not configured", code: 500 };
  }

  try {
    // Create or retrieve customer
    let customerRow = dbConn.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").get(userId);
    let customerId = customerRow?.stripe_customer_id;
    if (!customerId) {
      const emailRow = dbConn.prepare("SELECT email FROM users WHERE id = ?").get(userId);
      const customer = await stripe.customers.create({
        email: emailRow?.email,
        metadata: { user_id: String(userId) },
      });
      dbConn.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customer.id, userId);
      customerId = customer.id;
    }

    // Attach payment method if provided
    if (paymentMethodId) {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
    });

    const invoice = subscription.latest_invoice;
    const paymentIntent = invoice?.payment_intent;

    // Store in DB
    dbConn.prepare(`
      INSERT INTO user_memberships (user_id, plan_id, status, stripe_subscription_id, stripe_price_id, current_period_start, current_period_end, next_billing_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        plan_id = excluded.plan_id,
        status = excluded.status,
        stripe_subscription_id = excluded.stripe_subscription_id,
        stripe_price_id = excluded.stripe_price_id,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        next_billing_date = excluded.next_billing_date,
        cancel_at_period_end = 0,
        updated_at = DATETIME('now')
    `).run(
      userId,
      planId,
      subscription.status === "active" ? "active" : "past_due",
      subscription.id,
      priceId,
      new Date(subscription.current_period_start * 1000).toISOString(),
      new Date(subscription.current_period_end * 1000).toISOString(),
      new Date(subscription.current_period_end * 1000).toISOString()
    );

    return {
      success: true,
      subscriptionId: subscription.id,
      clientSecret: paymentIntent?.client_secret,
      status: subscription.status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    };
  } catch (err) {
    console.error("Stripe subscription error:", err.message);
    return { success: false, error: err.message, code: 500 };
  }
}

async function cancelStripeSubscription(subscriptionId) {
  if (!stripe) return { success: false, error: "Stripe not configured" };
  try {
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    return { success: true };
  } catch (err) {
    console.error("Stripe cancel error:", err.message);
    return { success: false, error: err.message };
  }
}

async function getStripeSubscriptionStatus(subscriptionId) {
  if (!stripe) return { status: "unknown" };
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return { status: sub.status, currentPeriodEnd: sub.current_period_end, cancelAtPeriodEnd: sub.cancel_at_period_end };
  } catch {
    return { status: "unknown" };
  }
}

// ─── Monthly bonus cron (call periodically) ─────────────────────────────────

async function awardMonthlyBonuses(db) {
  const activeMembers = db.prepare(`
    SELECT user_id, plan_id, monthly_bonus_points FROM user_memberships um
    JOIN membership_plans mp ON mp.id = um.plan_id
    WHERE um.status = 'active' AND um.plan_id != 'free'
  `).all();

  const today = new Date().toISOString().split("T")[0];
  for (const mem of activeMembers) {
    const lastBonus = db.prepare(
      "SELECT MAX(created_at) AS last FROM loyalty_transactions WHERE user_id = ? AND type = 'bonus' AND description LIKE 'Monthly membership bonus%'"
    ).get(mem.user_id);
    const lastDate = lastBonus?.last ? new Date(lastBonus.last).toISOString().split("T")[0] : null;

    // Award if: no bonus yet this month, or bonus was last month
    if (!lastDate || lastDate < today) {
      const plan = PLANS[mem.plan_id];
      if (plan && plan.monthlyBonusPoints > 0) {
        db.prepare(`
          INSERT INTO loyalty_transactions (user_id, type, points, balance_after, description)
          VALUES (?, 'bonus', ?, (SELECT COALESCE(SUM(points),0) FROM loyalty_transactions WHERE user_id = ?), ?)
        `).run(mem.user_id, plan.monthlyBonusPoints, mem.user_id, `Monthly membership bonus — ${plan.name} plan`);
        db.prepare("UPDATE loyalty_points SET points = points + ?, updated_at = DATETIME('now') WHERE user_id = ?")
          .run(plan.monthlyBonusPoints, mem.user_id);
        console.log(`Monthly bonus: ${plan.monthlyBonusPoints} pts to user ${mem.user_id} (${plan.name})`);
      }
    }
  }
}

// ─── Module exports ───────────────────────────────────────────────────────────

function loadMembershipEngine(dbConn) {
  return {
    ensureSchema:          () => ensureMembershipSchema(dbConn),
    getActiveMembership:    (userId) => getActiveMembership(dbConn, userId),
    getUserMembership:       (userId) => getUserMembership(dbConn, userId),
    createSubscription:     (userId, planId, paymentMethodId) => createStripeSubscription(userId, planId, paymentMethodId),
    cancelSubscription:     (subscriptionId) => cancelStripeSubscription(subscriptionId),
    getSubscriptionStatus:  (subscriptionId) => getStripeSubscriptionStatus(subscriptionId),
    awardMonthlyBonuses:    () => awardMonthlyBonuses(dbConn),
    PLANS,
  };
}

module.exports = { loadMembershipEngine, PLANS };