const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const fs = require("fs");
const resend = require("resend");
require("dotenv").config();

// ─── Config ───
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const SAND_API_KEY = process.env.SAND_API_KEY;
const PROD_API_KEY = process.env.PROD_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = process.env.APP_URL || "http://localhost:3000";
// Use prod key when it looks like a real key, otherwise fall back to sandbox
function selectApiKey() {
  const prod = process.env.PROD_API_KEY;
  const sand = process.env.SAND_API_KEY;
  // Only use prod if it starts with 'prod_' (real key prefix)
  if (prod && prod.startsWith("prod_")) return prod;
  if (sand && sand.startsWith("sand_")) return sand;
  return prod || sand || "";
}
const key = selectApiKey();

// LiteAPI SDK
const liteApi = require("liteapi-node-sdk")(key);

// ─── Database ──────────────────────────────────────────────────────────────
const dbPath = "./data/bookings.db";
if (!fs.existsSync(require("path").dirname(dbPath))) { fs.mkdirSync(require("path").dirname(dbPath), { recursive: true }); }
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    stripe_customer_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    liteapi_booking_id TEXT,
    liteapi_type TEXT DEFAULT 'hotel',
    status TEXT,
    hotel_name TEXT,
    checkin TEXT,
    checkout TEXT,
    price REAL,
    currency TEXT,
    guest_name TEXT,
    guest_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    discount_type TEXT DEFAULT 'percentage',
    discount_value REAL,
    minimum_spend REAL DEFAULT 0,
    max_discount REAL,
    currency TEXT DEFAULT 'USD',
    valid_from DATE,
    valid_until DATE,
    max_uses INTEGER,
    used_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS hotel_prebooks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER,
    prebook_id    TEXT UNIQUE NOT NULL,
    offer_id      TEXT NOT NULL,
    hotel_id      TEXT,
    currency      TEXT,
    total_amount  REAL,
    transaction_id TEXT,
    secret_key    TEXT,
    payment_types TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS loyalty_points (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    points      INTEGER NOT NULL DEFAULT 0,
    lifetime    INTEGER NOT NULL DEFAULT 0,
    tier        TEXT NOT NULL DEFAULT 'explorer',
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id)
  );
  CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    type        TEXT NOT NULL, -- 'earn', 'redeem', 'bonus', 'expire'
    points      INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    description TEXT,
    booking_id  INTEGER,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (booking_id) REFERENCES bookings(id)
  );
`);
// Migration: add prebook_id column to bookings if missing
try { db.prepare("ALTER TABLE bookings ADD COLUMN prebook_id TEXT").run(); } catch (e) { /* already exists */ }

// ─── Auth middleware ───
function requireLogin(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid session" });
  }
}

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));

// ─── Loyalty engine (must load before auth routes) ───────────────────────────
const loyaltyEngine = require("./modules/loyalty-engine");
const loyalty = loyaltyEngine.loadLoyaltyEngine(db);

// ─── Membership engine ───────────────────────────────────────────────────────
const membershipEngine = require("./modules/membership-engine");
const membership = membershipEngine.loadMembershipEngine(db);
membership.ensureSchema();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "../public")));

// ─── Auth Routes ───
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) return res.status(400).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, hash);
    const user_id = result.lastInsertRowid;

    const token = jwt.sign({ id: user_id, email }, JWT_SECRET, { expiresIn: "30d" });
    res.cookie("token", token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: "lax" });

    // Initialize loyalty and award signup bonus
    try {
      loyalty.initUser(user_id);
      loyalty.awardSignupBonus(user_id);
    } catch (loyaltyErr) {
      console.warn("Loyalty signup bonus failed:", loyaltyErr.message);
    }

    res.json({ success: true, user: { id: user_id, email } });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email);
    if (!user) return res.status(401).json({ error: "No account found with that email" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Wrong password" });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.cookie("token", token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: "lax" });
    res.json({ success: true, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

app.get("/api/auth/me", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ loggedIn: false });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    const userRow = db.prepare("SELECT id, email, created_at FROM users WHERE id = ?").get(user.id);
    if (!userRow) return res.json({ loggedIn: false });

    let loyaltyInfo = null;
    try { loyaltyInfo = loyalty.getBalance(user.id); } catch (e) {}

    let membershipInfo = null;
    try { membershipInfo = membership.getActiveMembership(user.id); } catch (e) {}

    const latestBookings = db.prepare(
      "SELECT id, liteapi_booking_id, liteapi_type, status, hotel_name, price, currency, created_at FROM bookings WHERE user_id = ? ORDER BY created_at DESC LIMIT 3"
    ).all(user.id);

    res.json({
      loggedIn: true,
      user: {
        id: user.id,
        email: user.email,
        createdAt: userRow.created_at,
        loyalty: loyaltyInfo || null,
        membership: membershipInfo || null,
        recentBookings: latestBookings,
      },
    });
  } catch {
    res.json({ loggedIn: false });
  }
});

// ─── Loyalty API endpoints ──────────────────────────────────────────────────

// GET /api/loyalty/balance
app.get("/api/loyalty/balance", (req, res) => {
  try {
    const userId = req.cookies.token
      ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })()
      : null;
    if (!userId) return res.status(401).json({ error: "Not logged in" });

    const balance = loyalty.getBalance(userId);
    if (!balance) return res.status(404).json({ error: "Loyalty not initialized" });
    res.json({ success: true, data: balance });
  } catch (err) {
    console.error("Loyalty balance error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/loyalty/redeem — redeem points → get a one-time voucher code
app.post("/api/loyalty/redeem", (req, res) => {
  try {
    const userId = req.cookies.token
      ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })()
      : null;
    if (!userId) return res.status(401).json({ error: "Not logged in" });

    const { points } = req.body;
    if (!points || points < 500) {
      return res.status(400).json({ error: "Minimum 500 points required", code: 400 });
    }
    // Round down to nearest 500
    const ptsToUse = Math.floor(points / 500) * 500;
    if (ptsToUse < 500) return res.status(400).json({ error: "Minimum 500 points required", code: 400 });

    const redeemResult = loyalty.redeemPoints(userId, ptsToUse);
    if (!redeemResult.success) {
      return res.status(400).json({ error: redeemResult.error, code: 400 });
    }

    const discountUsd = redeemResult.discountUsd;
    const voucher = loyalty.createRedeemVoucher(userId, discountUsd, redeemResult.pointsUsed);

    res.json({
      success: true,
      data: {
        pointsUsed: redeemResult.pointsUsed,
        discountUsd: discountUsd,
        newBalance: redeemResult.newBalance,
        voucherCode: voucher.code,
        voucherId: voucher.voucherId,
        message: `Redeemed ${redeemResult.pointsUsed} pts → $${discountUsd} off. Code: ${voucher.code} (valid 7 days, single use)`,
      },
    });
  } catch (err) {
    console.error("Loyalty redeem error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/loyalty/history
app.get("/api/loyalty/history", (req, res) => {
  try {
    const userId = req.cookies.token
      ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })()
      : null;
    if (!userId) return res.status(401).json({ error: "Not logged in" });

    const limit = parseInt(req.query.limit) || 20;
    const history = loyalty.getHistory(userId, limit);
    res.json({ success: true, data: history });
  } catch (err) {
    console.error("Loyalty history error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Hotel Search ───
app.get("/api/hotels/search", async (req, res) => {
  try {
    const { city, countryCode, checkin, checkout, adults, rooms, starMin, maxPrice, refundableOnly, guestNationality } = req.query;
    if (!city || !countryCode || !checkin || !checkout || !adults) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const isLoggedIn = req.cookies.token ? true : false;
    const user = isLoggedIn ? jwt.verify(req.cookies.token, JWT_SECRET) : null;

    // Logged-in users get better margin (lower price to them = better deal)
    const margin = user ? 0 : 10;  // 0% margin for logged-in (net rate), 10% for guests

    const hotelIdsResult = await liteApi.getHotels(countryCode, city, 0, 50);
    if (hotelIdsResult.status === "failed") {
      return res.status(500).json({ error: "Hotel search failed" });
    }
    const hotels = hotelIdsResult.data;
    const ids = hotels.map(h => h.id);

    const ratesResult = await liteApi.getFullRates({
      hotelIds: ids,
      occupancies: [{ rooms: parseInt(rooms || "1"), adults: parseInt(adults) }],
      currency: "USD",
      guestNationality: guestNationality || "US",
      checkin,
      checkout,
      margin,
      // Apply filters if provided
      ...(maxPrice && { maxPrice: parseFloat(maxPrice) }),
      ...(refundableOnly === "1" && { refundableOnly: true }),
    });

    if (ratesResult.status === "failed") {
      return res.status(500).json({ error: "Rates search failed" });
    }

    const rates = ratesResult.data;
    rates.forEach(rate => {
      rate.hotel = hotels.find(h => h.id === rate.hotelId);
    });

    res.json({ hotels, rates });
  } catch (err) {
    console.error("Hotel search error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Hotel Detail ───
app.get("/api/hotels/:id", async (req, res) => {
  try {
    const hotel = await liteApi.getHotelDetails(req.params.id);
    if (hotel.status === "failed") {
      return res.status(404).json({ error: "Hotel not found" });
    }
    res.json(hotel.data);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Prebook Hotel ───
app.post("/api/hotels/prebook", async (req, res) => {
  try {
    const { offerId, voucherCode, addons, usePaymentSdk } = req.body;
    const isLoggedIn = req.cookies.token ? true : false;

    // Require login for booking
    if (!isLoggedIn) {
      return res.status(401).json({ error: "Please sign in to book", code: 401, key: "auth.required" });
    }

    const userId = req.cookies.token ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })() : null;

    const prebookData = {
      offerId,
      usePaymentSdk: usePaymentSdk !== false,
    };
    if (voucherCode) prebookData.voucherCode = voucherCode;
    if (addons && Array.isArray(addons) && addons.length > 0) {
      prebookData.addons = addons;
    }

    const result = await liteApi.preBook(prebookData);
    if (result.status === "failed") {
      return res.status(400).json({ error: result.error || "Prebook failed" });
    }

    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Prebook error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Book Hotel ───
app.post("/api/hotels/book", async (req, res) => {
  try {
    const { prebookId, transactionId, guestFirstName, guestLastName, guestEmail, user_email } = req.body;

    const bookData = {
      prebookId,
      holder: {
        firstName: guestFirstName,
        lastName: guestLastName,
        email: guestEmail
      },
      payment: {
        method: transactionId ? "TRANSACTION_ID" : "NUITEE_PAY",
        transactionId: transactionId || undefined
      },
      guests: [{
        occupancyNumber: 1,
        firstName: guestFirstName,
        lastName: guestLastName,
        email: guestEmail
      }]
    };

    // Use hotel engine's completeBooking which uses liteFetch (working)
    const result = await hotelEngine.completeBooking(bookData, null, db);
    if (!result.success) {
      return res.status(400).json({ error: result.error?.message || "Booking failed" });
    }

    const booking = result.data;

    // Store in our DB
    const user = req.cookies.token ? jwt.verify(req.cookies.token, JWT_SECRET) : null;
    let bookingId = null;
    if (user) {
      db.prepare(`
        INSERT INTO bookings (user_id, liteapi_booking_id, liteapi_type, status, hotel_name, checkin, checkout, price, currency, guest_name, guest_email)
        VALUES (?, ?, 'hotel', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        booking.bookingId,
        booking.status,
        booking.hotel?.name || "Unknown",
        booking.checkin,
        booking.checkout,
        booking.price,
        booking.currency,
        `${guestFirstName} ${guestLastName}`,
        guestEmail
      );
      bookingId = db.prepare("SELECT last_insert_rowid() AS id").get().id;

      // Award loyalty points (only to logged-in members, not guests)
      try {
        const price = booking.price || 0;
        const currency = booking.currency || "USD";
        const earnResult = loyalty.earnPoints(user.id, price, currency, bookingId,
          `Hotel booking: ${booking.hotel?.name || "Unknown"} (${booking.checkin} → ${booking.checkout})`);
        if (earnResult.tierUpgraded) {
          console.log(`Loyalty: user ${user.id} upgraded to ${earnResult.newTier} tier!`);
        }
      } catch (loyaltyErr) {
        console.warn("Loyalty points earn failed:", loyaltyErr.message);
      }
    }

    res.json({ success: true, data: booking });
  } catch (err) {
    console.error("Book error:", err.message);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ─── Flight Search ───
app.post("/api/flights/search", async (req, res) => {
  try {
    const { legs, adults, currency, country } = req.body;
    if (!legs || legs.length === 0) {
      return res.status(400).json({ error: "Legs required" });
    }

    const result = await flightEngine.searchFlights({ legs, adults, currency, country });
    if (!result.success) {
      return res.status(400).json({ error: result.error?.message || "Search failed", code: result.error?.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Flight search error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Flight engine ──────────────────────────────────────────────────────────
const flightEngine = require("./flight-engine");
flightEngine.ensureFlightSchema(db);

// ─── Hotel engine ────────────────────────────────────────────────────────────
const hotelEngine = require("./modules/hotel-engine");

// ─── eSIMply engine ──────────────────────────────────────────────────────────
const esimplyEngine = require("./modules/esimply-engine");

// ─── Payment SDK helper ──────────────────────────────────────────────────────
const paymentSdk = require("./modules/payment-sdk");

// ─── Flight Prebook ───
app.post("/api/flights/prebook", async (req, res) => {
  try {
    const isLoggedIn = req.cookies.token ? true : false;
    if (!isLoggedIn) {
      return res.status(401).json({ error: "Please sign in to book", code: 401, key: "auth.required" });
    }

    const userId = req.cookies.token ? (() => {
      try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; }
    })() : null;

    const result = await flightEngine.createPrebook(req.body, userId, db);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Prebook failed", code: e.code, key: e.key });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Flight prebook error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Attach services to prebook ───
app.post("/api/flights/prebook/services", async (req, res) => {
  try {
    const { prebookId, services } = req.body;
    const result = await flightEngine.attachServices(prebookId, services, db);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Attach failed", code: e.code, key: e.key });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Flight attach-services error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Book Flight ───
app.post("/api/flights/book", async (req, res) => {
  try {
    const userId = req.cookies.token ? (() => {
      try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; }
    })() : null;

    const result = await flightEngine.completeBooking(req.body, userId, db);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Booking failed", code: e.code, key: e.key });
    }

    if (RESEND_API_KEY && result.data) {
      const booking = result.data;
      const holder  = booking.holder || (result.data.passengers && result.data.passengers[0]) || {};
      const email   = holder.email || (req.body?.holder?.email) || "";
      if (email) {
        sendConfirmationEmail(booking, "flight").catch(err => console.error("Email error:", err.message));
      }
    }

    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Flight book error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Get Prebook ───
app.get("/api/flights/prebook/:prebookId", async (req, res) => {
  try {
    const result = await flightEngine.getPrebook(req.params.prebookId);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Not found", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Flight get-prebook error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Get Booking ───
app.get("/api/flights/booking/:bookingId", async (req, res) => {
  try {
    const result = await flightEngine.getBooking(req.params.bookingId);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Not found", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Flight get-booking error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});


// ─── Payment SDK config ────────────────────────────────────────────────────
app.get("/api/payment-sdk/config", (req, res) => {
  try {
    const returnUrl = req.query.returnUrl || APP_URL + "/confirmation";
    res.json({
      isSandbox: process.env.PROD_API_KEY ? false : true,
      testCard: { number: "4242424242424242", cvv: "any 3 digits", expiry: "any future date" },
      configTemplate: {
        publicKey: process.env.PROD_API_KEY ? "live" : "sandbox",
        returnUrl: returnUrl,
        targetElement: "#payment-target",
        appearance: { theme: "flat" },
        options: { business: { name: process.env.BUSINESS_NAME || "PlanurStay" } },
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Hotel: Places autocomplete ──────────────────────────────────────────────
app.get("/api/hotels/places", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.status(400).json({ error: "Query must be at least 2 characters" });
    const result = await hotelEngine.searchPlaces(q);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Search failed" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Hotel places error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Hotel: Rates search ─────────────────────────────────────────────────────
app.post("/api/hotels/rates", async (req, res) => {
  try {
    const result = await hotelEngine.getRates(req.body);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Rates search failed", code: result.error?.code });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Hotel rates error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Hotel: Prebook ──────────────────────────────────────────────────────────
app.post("/api/hotels/prebook", async (req, res) => {
  try {
    const userId = req.cookies.token ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })() : null;
    const result = await hotelEngine.createPrebook(req.body, userId, db);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Prebook failed", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Hotel prebook error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Hotel: Book ─────────────────────────────────────────────────────────────
app.post("/api/hotels/book", async (req, res) => {
  try {
    const userId = req.cookies.token ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })() : null;
    const result = await hotelEngine.completeBooking(req.body, userId, db);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Booking failed", code: e.code });
    }
    if (RESEND_API_KEY && result.data) {
      sendConfirmationEmail(result.data, "hotel").catch(err => console.error("Email error:", err.message));
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Hotel book error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Hotel: Get details ──────────────────────────────────────────────────────
app.get("/api/hotels/:hotelId", async (req, res) => {
  try {
    const result = await hotelEngine.getHotelDetails(req.params.hotelId);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Hotel not found", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Hotel detail error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Loyalty: Get settings ───────────────────────────────────────────────────
app.get("/api/loyalty/settings", async (req, res) => {
  try {
    const result = await loyaltyEngine.getLoyaltySettings();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch loyalty settings" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Loyalty settings error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Loyalty: Set / enable ───────────────────────────────────────────────────
app.post("/api/loyalty/settings", requireLogin, async (req, res) => {
  try {
    const result = await loyaltyEngine.setLoyalty(req.body);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to set loyalty settings", code: result.error?.code });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Loyalty set error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Loyalty: Update ─────────────────────────────────────────────────────────
app.put("/api/loyalty/settings", requireLogin, async (req, res) => {
  try {
    const result = await loyaltyEngine.updateLoyalty(req.body);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to update loyalty settings", code: result.error?.code });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Loyalty update error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Membership API endpoints ─────────────────────────────────────────────────

// GET /api/membership/plans — list all available membership plans
app.get("/api/membership/plans", (req, res) => {
  const plans = Object.values(PLANS).filter(p => p.id !== "free").sort((a, b) => a.order - b.order);
  res.json({ success: true, data: plans, freeTier: PLANS.free });
});

// GET /api/membership/my — get current user's membership
app.get("/api/membership/my", (req, res) => {
  try {
    const userId = req.cookies.token
      ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })()
      : null;
    if (!userId) return res.status(401).json({ error: "Not logged in" });

    const mem = membership.getUserMembership(userId);
    res.json({ success: true, data: mem });
  } catch (err) {
    console.error("Membership my error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/membership/upgrade — upgrade to a paid plan (Stripe PaymentIntent)
app.post("/api/membership/upgrade", requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const { planId, paymentMethodId } = req.body;
    if (!planId || !membership.PLANS[planId]) {
      return res.status(400).json({ error: "Invalid plan", code: 400 });
    }
    if (planId === "free") {
      return res.status(400).json({ error: "Cannot upgrade to free tier", code: 400 });
    }

    const result = await membership.createSubscription(userId, planId, paymentMethodId);
    if (!result.success) {
      return res.status(result.error?.code || 500).json({ error: result.error, code: result.error?.code });
    }

    res.json({
      success: true,
      data: {
        subscriptionId: result.subscriptionId,
        clientSecret: result.clientSecret,
        status: result.status,
        planId: planId,
        planName: PLANS[planId].name,
        message: result.clientSecret
          ? "Payment pending — complete the Stripe checkout to activate your membership."
          : "Subscription created. Membership will activate when payment is confirmed.",
      },
    });
  } catch (err) {
    console.error("Membership upgrade error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/membership/cancel — cancel at end of billing period
app.post("/api/membership/cancel", requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const mem = membership.getUserMembership(userId);
    if (!mem.isPaid || !mem.stripe_subscription_id) {
      return res.status(400).json({ error: "No active paid membership to cancel", code: 400 });
    }

    const result = await membership.cancelSubscription(mem.stripe_subscription_id);
    if (!result.success) {
      return res.status(500).json({ error: result.error, code: 500 });
    }

    // Mark locally as cancelling
    db.prepare("UPDATE user_memberships SET cancel_at_period_end = 1, status = 'cancelled', updated_at = DATETIME('now') WHERE user_id = ?").run(userId);

    res.json({
      success: true,
      data: {
        message: `Membership will remain active until ${mem.current_period_end || "the end of your billing period"}, then cancel automatically.`,
      },
    });
  } catch (err) {
    console.error("Membership cancel error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── eSIMply: List destinations ──────────────────────────────────────────────
app.get("/api/loyalty/guests", requireLogin, async (req, res) => {
  try {
    const result = await loyaltyEngine.listGuests(req.query);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch guests" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Loyalty guests error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Loyalty: Get guest ──────────────────────────────────────────────────────
app.get("/api/loyalty/guests/:guestId", requireLogin, async (req, res) => {
  try {
    const result = await loyaltyEngine.getGuest(req.params.guestId);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Guest not found", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Loyalty guest error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Loyalty: Get guest bookings ─────────────────────────────────────────────
app.get("/api/loyalty/guests/:guestId/bookings", requireLogin, async (req, res) => {
  try {
    const result = await loyaltyEngine.getGuestBookings(req.params.guestId, req.query);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Failed to fetch guest bookings", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Loyalty guest bookings error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── eSIMply: List destinations ──────────────────────────────────────────────
app.get("/api/esim/destinations", async (req, res) => {
  try {
    const result = await esimplyEngine.listDestinations(req.query);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch destinations" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("eSIM destinations error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── eSIMply: Purchase eSIM ──────────────────────────────────────────────────
app.post("/api/esim/orders", async (req, res) => {
  try {
    const result = await esimplyEngine.purchaseEsim(req.body);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Purchase failed", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("eSIM purchase error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── eSIMply: List orders ────────────────────────────────────────────────────
app.get("/api/esim/orders", async (req, res) => {
  try {
    const result = await esimplyEngine.listOrders(req.query);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch orders" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("eSIM orders error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── eSIMply: Get order ──────────────────────────────────────────────────────
app.get("/api/esim/orders/:orderId", async (req, res) => {
  try {
    const result = await esimplyEngine.getOrder(req.params.orderId);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Order not found", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("eSIM order error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── eSIMply: Top up ─────────────────────────────────────────────────────────
app.post("/api/esim/orders/:orderId/topup", async (req, res) => {
  try {
    const { dataPackageId } = req.body;
    const result = await esimplyEngine.topUpEsim(req.params.orderId, dataPackageId);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Top-up failed", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("eSIM topup error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── eSIMply: Usage ──────────────────────────────────────────────────────────
app.get("/api/esim/orders/:orderId/usage", async (req, res) => {
  try {
    const result = await esimplyEngine.getEsimUsage(req.params.orderId);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Failed to fetch usage", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("eSIM usage error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Confirmation Engine ──────────────────────────────────────────────────────
const confirmationEngine = require("./confirmation-engine");

// ─── Reference Data Engine ────────────────────────────────────────────────────
const referenceEngine = require("./reference-engine");

// ─── Voucher Engine ───────────────────────────────────────────────────────────
const voucherEngine = require("./voucher-engine");

// ─── Add-ons Engine ───────────────────────────────────────────────────────────
const addonsEngine = require("./addons-engine");

// ─── Reference: IATA Codes ────────────────────────────────────────────────────
// GET /api/reference/iata?q=JFK  — search airports by code or name
app.get("/api/reference/iata", async (req, res) => {
  try {
    const q = req.query.q || req.query.code || "";
    const result = await referenceEngine.searchIataCodes(q);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Search failed" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("IATA search error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Airlines ──────────────────────────────────────────────────────
// GET /api/reference/airlines           — list all airlines
// GET /api/reference/airlines/:iata    — get single airline by IATA code
app.get("/api/reference/airlines", async (req, res) => {
  try {
    const result = await referenceEngine.getAllAirlines();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch airlines" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Airlines list error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/reference/airlines/:iata", async (req, res) => {
  try {
    const result = await referenceEngine.getAirlineByIata(req.params.iata.toUpperCase());
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Airline not found", code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Airline lookup error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Countries ─────────────────────────────────────────────────────
// GET /api/reference/countries  — list all countries
app.get("/api/reference/countries", async (req, res) => {
  try {
    const result = await referenceEngine.getCountries();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch countries" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Countries error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Cities ────────────────────────────────────────────────────────
// GET /api/reference/cities?countryCode=US  — cities in a country
app.get("/api/reference/cities", async (req, res) => {
  try {
    const { countryCode } = req.query;
    if (!countryCode) return res.status(400).json({ error: "countryCode required" });
    const result = await referenceEngine.getCities(countryCode);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch cities" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Cities error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Currencies ────────────────────────────────────────────────────
// GET /api/reference/currencies  — all supported currencies
app.get("/api/reference/currencies", async (req, res) => {
  try {
    const result = await referenceEngine.getCurrencies();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch currencies" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Currencies error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Hotel Chains ──────────────────────────────────────────────────
// GET /api/reference/chains  — all hotel chains
app.get("/api/reference/chains", async (req, res) => {
  try {
    const result = await referenceEngine.getChains();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch chains" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Chains error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Facilities ────────────────────────────────────────────────────
// GET /api/reference/facilities  — hotel facilities list
app.get("/api/reference/facilities", async (req, res) => {
  try {
    const result = await referenceEngine.getFacilities();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch facilities" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Facilities error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Room Types ────────────────────────────────────────────────────
// GET /api/reference/room-types
app.get("/api/reference/room-types", async (req, res) => {
  try {
    const result = await referenceEngine.getRoomTypes();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch room types" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Room types error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Room Amenities ────────────────────────────────────────────────
// GET /api/reference/room-amenities
app.get("/api/reference/room-amenities", async (req, res) => {
  try {
    const result = await referenceEngine.getRoomAmenities();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch amenities" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Room amenities error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Languages ─────────────────────────────────────────────────────
// GET /api/reference/languages
app.get("/api/reference/languages", async (req, res) => {
  try {
    const result = await referenceEngine.getLanguages();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch languages" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Languages error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Hotel Types ───────────────────────────────────────────────────
// GET /api/reference/hotel-types
app.get("/api/reference/hotel-types", async (req, res) => {
  try {
    const result = await referenceEngine.getHotelTypes();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch hotel types" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Hotel types error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reference: Weather ───────────────────────────────────────────────────────
// GET /api/reference/weather?lat=40.71&lon=-74.01
app.get("/api/reference/weather", async (req, res) => {
  try {
    const { lat, lon } = req.query;
    const result = await referenceEngine.getWeather(lat, lon);
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch weather" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Weather error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Add-ons: Uber voucher options ───────────────────────────────────────────
// GET /api/addons/uber/options  — $10-$100 in $10 increments
app.get("/api/addons/uber/options", (req, res) => {
  try {
    const options = addonsEngine.getUberVoucherOptions();
    res.json({ success: true, data: options });
  } catch (err) {
    console.error("Uber options error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Add-ons: eSIM packages ───────────────────────────────────────────────────
// GET /api/addons/esim/packages?countryCode=ES  — eSIM packages for a country
app.get("/api/addons/esim/packages", async (req, res) => {
  try {
    const { countryCode } = req.query;
    if (!countryCode) return res.status(400).json({ error: "countryCode required" });
    const result = await addonsEngine.getEsimPackages(countryCode.toUpperCase());
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch eSIM packages" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("eSIM packages error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Vouchers: Create ─────────────────────────────────────────────────────────
// POST /api/vouchers/create  — create a new voucher
app.post("/api/vouchers/create", requireLogin, async (req, res) => {
  try {
    const result = await voucherEngine.createVoucher(req.body);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message, code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Voucher create error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Vouchers: List ───────────────────────────────────────────────────────────
// GET /api/vouchers/list  — list all vouchers
app.get("/api/vouchers/list", requireLogin, async (req, res) => {
  try {
    const result = await voucherEngine.listVouchers();
    if (!result.success) return res.status(400).json({ error: result.error?.message || "Failed to fetch vouchers" });
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Voucher list error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Vouchers: Get by ID ──────────────────────────────────────────────────────
// GET /api/vouchers/:id  — get single voucher
app.get("/api/vouchers/:id", requireLogin, async (req, res) => {
  try {
    const result = await voucherEngine.getVoucherById(req.params.id);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message, code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Voucher get error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Vouchers: Update ─────────────────────────────────────────────────────────
// PUT /api/vouchers/:id  — update voucher
app.put("/api/vouchers/:id", requireLogin, async (req, res) => {
  try {
    const result = await voucherEngine.updateVoucher(req.params.id, req.body);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message, code: e.code });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Voucher update error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── My Bookings ───
app.get("/api/bookings", requireLogin, (req, res) => {
  const user = jwt.verify(req.cookies.token, JWT_SECRET);
  const bookings = db.prepare(`
    SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC
  `).all(user.id);
  res.json(bookings);
});

// ─── Vouchers ───
app.post("/api/vouchers", requireLogin, async (req, res) => {
  try {
    const { code, discount_type, discount_value, minimum_spend, max_discount, currency, valid_from, valid_until, max_uses } = req.body;

    const result = await liteApi.CreateVoucher({
      voucher_code: code,
      discount_type,
      discount_value,
      minimum_spend: minimum_spend || 0,
      maximum_discount_amount: max_discount,
      currency: currency || "USD",
      validity_start: valid_from || new Date().toISOString().split("T")[0],
      validity_end: valid_until || "2027-12-31",
      usages_limit: max_uses || 999,
      status: "active"
    });

    if (result.status === "failed") {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error("Voucher error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/vouchers", async (req, res) => {
  try {
    const result = await liteApi.getVouchers();
    if (result.status === "failed") {
      return res.status(500).json({ error: "Failed to fetch vouchers" });
    }
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Email ───
async function sendConfirmationEmail(booking, type) {
  if (!RESEND_API_KEY) {
    console.log("No Resend key — skipping email");
    return;
  }

  try {
    const price = booking.price ? `$${booking.price}` : "N/A";
    const dates = booking.checkin ? `${booking.checkin} → ${booking.checkout || "N/A"}` : "N/A";

    await resend.emails.send({
      from: "PlanurStay <onboarding@resend.dev>",
      to: booking.guest_email || booking.holder?.email,
      subject: `${type === "hotel" ? "Hotel" : "Flight"} Booking Confirmed — PlanurStay`,
      html: `
        <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #fff; border-radius: 8px;">
          <h1 style="color: #059669; font-size: 24px; margin-bottom: 8px;">Booking Confirmed ✓

          <p style="color: #374151; font-size: 16px;">
            Hi there,
          </p>
          <p style="color: #374151; font-size: 16px;">
  Your ${type} booking is confirmed. Here are the details:
          </p>

          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <p style="margin: 4px 0; color: #374151;"><strong>Status:</strong> ${booking.status || "CONFIRMED"}</p>
            <p style="margin: 4px 0; color: #374151;"><strong>Booking Ref:</strong> ${booking.bookingId || booking.hotelConfirmationCode || "N/A"}</p>
            ${type === "hotel" ? `
              <p style="margin: 4px 0; color: #374151;"><strong>Hotel:</strong> ${booking.hotel?.name || "N/A"}</p>
              <p style="margin: 4px 0; color: #374151;"><strong>Check-in:</strong> ${booking.checkin}</p>
              <p style="margin: 4px 0; color: #374151;"><strong>Check-out:</strong> ${booking.checkout}</p>
              <p style="margin: 4px 0; color: #374151;"><strong>Room:</strong> ${booking.bookedRooms?.[0]?.roomType?.name || "N/A"}</p>
            ` : `
              <p style="margin: 4px 0; color: #374151;"><strong>Flight:</strong> ${booking.flightInfo?.operatingCarrier?.marketingName || booking.airline || "N/A"}</p>
              <p style="margin: 4px 0; color: #374151;"><strong>Depart:</strong> ${booking.departureDate || "N/A"}</p>
              <p style="margin: 4px 0; color: #374151;"><strong>Return:</strong> ${booking.returnDate || "N/A"}</p>
            `}
            <p style="margin: 4px 0; color: #374151;"><strong>Price:</strong> ${price} ${booking.currency || "USD"}</p>
          </div>

          <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
            A copy of this confirmation has been saved in your PlanurStay account.
          </p>
          <p style="color: #6b7280; font-size: 14px;">
            Need help? Reply to this email or visit PlanurStay.
          </p>
        </div>
      `
    });
    console.log("Confirmation email sent");
  } catch (err) {
    console.error("Email error:", err.message);
  }
}

// ─── Serve pages ───
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/hotels", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/hotels.html"));
});

app.get("/hotel/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/hotel-detail.html"));
});

app.get("/flights", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/flights.html"));
});

app.get("/flight-detail", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/flight-detail.html"));
});

app.get("/confirmation", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/confirmation.html"));
});

app.get("/my-bookings", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/my-bookings.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/login.html"));
});

// ─── Start
app.get("/api/confirmation/:bookingId", async (req, res) => {
  try {
    const type = req.query.type || "hotel";
    const result = type === "flight"
      ? await confirmationEngine.getFlightConfirmation(req.params.bookingId)
      : await confirmationEngine.getHotelConfirmation(req.params.bookingId);
    if (!result.success) {
      return res.status(400).json({ error: result.error?.message || "Confirmation not found" });
    }
    res.json(result);
  } catch (err) {
    console.error("Confirmation lookup error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/confirmation/voucher/:voucherId", (req, res) => {
  res.json({ message: "Voucher info is included in booking confirmation response" });
});

// ─── End-to-End Confirmation Flows ────────────────────────────────────────────
// Hotel: Complete booking with full confirmation (search → prebook → book → confirm)
app.post("/api/confirmation/hotel", async (req, res) => {
  try {
    const userId = req.cookies.token ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })() : null;
    const result = await confirmationEngine.hotelConfirmationFlow(req.body, userId, db);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Confirmation flow failed", code: e.code });
    }
    res.json(result);
  } catch (err) {
    console.error("Hotel confirmation flow error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Flight: Complete booking with full confirmation (search → prebook → book → confirm)
app.post("/api/confirmation/flight", async (req, res) => {
  try {
    const userId = req.cookies.token ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })() : null;
    const result = await confirmationEngine.flightConfirmationFlow(req.body, userId, db);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Confirmation flow failed", code: e.code });
    }
    res.json(result);
  } catch (err) {
    console.error("Flight confirmation flow error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Confirmation polling — called by frontend to check booking status
app.get("/api/confirmation/:bookingId/poll", async (req, res) => {
  try {
    const type = req.query.type || "hotel";
    const result = type === "flight"
      ? await confirmationEngine.getFlightConfirmation(req.params.bookingId)
      : await confirmationEngine.getHotelConfirmation(req.params.bookingId);
    if (!result.success) {
      return res.json({ status: "UNKNOWN", bookingId: req.params.bookingId });
    }
    res.json(result);
  } catch (err) {
    console.error("Poll error:", err.message);
    res.json({ status: "UNKNOWN", bookingId: req.params.bookingId });
  }
});

// Get booking status (lightweight, for polling)
app.get("/api/bookings/:bookingId", async (req, res) => {
  try {
    const booking = db.prepare("SELECT * FROM bookings WHERE liteapi_booking_id = ? OR id = ? LIMIT 1").get(req.params.bookingId, req.params.bookingId);
    if (booking) {
      return res.json({ status: booking.status, bookingId: booking.liteapi_booking_id || booking.id, type: booking.liteapi_type });
    }
    res.json({ status: "UNKNOWN", bookingId: req.params.bookingId });
  } catch (err) {
    res.json({ status: "UNKNOWN", bookingId: req.params.bookingId });
  }
});

// Flight: Complete booking with full confirmation (search → prebook → book → confirm)
app.post("/api/confirmation/flight", async (req, res) => {
  try {
    const userId = req.cookies.token ? (() => { try { return jwt.verify(req.cookies.token, JWT_SECRET).id; } catch { return null; } })() : null;
    const result = await confirmationEngine.flightConfirmationFlow(req.body, userId, db);
    if (!result.success) {
      const e = result.error;
      const status = (e.code >= 500 && e.code < 600) ? 502 : 400;
      return res.status(status).json({ error: e.message || "Confirmation flow failed", code: e.code });
    }
    res.json(result);
  } catch (err) {
    console.error("Flight confirmation flow error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`PlanurStay server running on http://localhost:${PORT}`);
  console.log(`Using sandbox key: ${key ? "yes" : "NO KEY SET"}`);
});
