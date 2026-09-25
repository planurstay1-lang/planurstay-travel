/**
 * Nuitee Connect (LiteAPI) webhooks → keep our booking records in sync with changes made
 * anywhere (their dashboard, their chatbot, the hotel, the airline).
 *
 *   POST /api/webhooks/liteapi
 *
 * Setup (Nuitee Connect → Webhooks): URL https://<site>/api/webhooks/liteapi, shared secret =
 * LITEAPI_WEBHOOK_SECRET (sent by Nuitee in the `authorization` header). Without the env var every
 * call is rejected. Events are deduplicated by event_id (delivery is at-least-once).
 *
 * Handled: booking.book (records bookings made outside our checkout), booking.book.hotelConfirmationNumber, booking.cancel, booking.cancel_error, booking.refund,
 * booking.amendment, booking.amendment.relocation, booking.compensation, booking.rebook.*,
 * flight.book.confirmed, flight.book.cancelled, flight.book.failed. Anything that needs a person
 * (relocation, compensation, failed cancel, failed flight) opens a support ticket.
 */
const crypto = require("crypto");

function createWebhooks({ db, sendEmail }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      event_name TEXT,
      booking_id TEXT,
      sandbox INTEGER,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try { db.exec("ALTER TABLE bookings ADD COLUMN hotel_confirmation TEXT"); } catch { /* already there */ }
  const parse = (v) => { if (v && typeof v === "object") return v; try { return JSON.parse(v || "{}"); } catch { return {}; } };
  // bookingId can sit at different depths depending on the event; search both payloads.
  function findKey(obj, keys, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 5) return null;
    for (const k of keys) if (obj[k] != null && typeof obj[k] !== "object") return String(obj[k]);
    for (const v of Object.values(obj)) { const f = findKey(v, keys, depth + 1); if (f) return f; }
    return null;
  }
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const ticket = (bookingId, type, category, summary, email) => {
    const ref = "PS-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    try { db.prepare("INSERT INTO support_tickets (ref, email, booking_id, booking_type, category, summary) VALUES (?, ?, ?, ?, ?, ?)").run(ref, email || "", bookingId, type, category, summary); } catch {}
    sendEmail({ to: process.env.SUPPORT_EMAIL || "info@planurstay.com", subject: `[${ref}] ${category} · ${bookingId}`, html: `<div style="font-family:Arial,sans-serif"><h3>${category} (from Nuitee webhook)</h3><p>Booking ${bookingId} (${type})</p><p style="white-space:pre-wrap">${String(summary).replace(/</g, "&lt;")}</p></div>` }).catch(() => {});
    return ref;
  };
  const reversePoints = (bookingId, why) => { try { db.prepare("UPDATE rewards_ledger SET type = 'reverse', points = 0, note = ? WHERE booking_ref = ? AND type = 'pending'").run(why, bookingId); } catch {} };
  const hotelRow = (id) => db.prepare("SELECT * FROM bookings WHERE liteapi_booking_id = ? LIMIT 1").get(id);

  function handle(name, req, resp) {
    const bookingId = findKey(resp, ["bookingId", "booking_id"]) || findKey(req, ["bookingId", "booking_id"]);
    if (!bookingId) return { bookingId: null, note: "no bookingId" };
    if (name.startsWith("flight.")) {
      const status = { "flight.book.confirmed": "CONFIRMED", "flight.book.cancelled": "CANCELLED", "flight.book.failed": "FAILED" }[name];
      if (status) try { db.prepare("UPDATE flight_bookings SET status = ? WHERE booking_id = ?").run(status, bookingId); } catch {}
      if (name === "flight.book.cancelled") reversePoints(bookingId, `Flight ${bookingId} was cancelled`);
      if (name === "flight.book.failed") ticket(bookingId, "flight", "flight-failed", "Airline/supplier reported the flight booking failed. Check whether the customer was charged and contact them.");
      return { bookingId };
    }
    const row = hotelRow(bookingId);
    // A booking made outside our checkout (e.g. Nuitee's "Ask AI" chatbot): record it so the Help
    // assistant, My trips lookup and admin can see it. Bookings from our own checkout already exist.
    if (name === "booking.book" && !row) {
      const pick = (keys) => findKey(resp, keys) || findKey(req, keys);
      const email = pick(["email"]);
      const first = pick(["firstName"]), last = pick(["lastName"]);
      db.prepare("INSERT INTO bookings (liteapi_booking_id, liteapi_type, status, hotel_name, checkin, checkout, price, currency, guest_name, guest_email, prebook_id) VALUES (?, 'hotel', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(bookingId, pick(["status"]) || "CONFIRMED", pick(["hotelName"]) || findKey(resp?.hotel || resp?.data?.hotel, ["name"]) || "Hotel",
          (pick(["checkin"]) || "").slice(0, 10), (pick(["checkout"]) || "").slice(0, 10), +(pick(["sellingPrice", "price", "totalAmount"]) || 0) || null,
          pick(["currency"]) || "USD", [first, last].filter(Boolean).join(" ") || null, email ? String(email).toLowerCase() : null, pick(["prebookId"]));
      return { bookingId };
    }
    switch (name) {
      case "booking.book.hotelConfirmationNumber": {
        const code = findKey(resp, ["hotelConfirmationCode", "hotelConfirmationNumber"]);
        if (code && row) db.prepare("UPDATE bookings SET hotel_confirmation = ? WHERE liteapi_booking_id = ?").run(code, bookingId);
        break;
      }
      case "booking.cancel": {
        const status = findKey(resp, ["status"]) || "CANCELLED";
        db.prepare("UPDATE bookings SET status = ? WHERE liteapi_booking_id = ?").run(/CANCEL/i.test(status) ? status : "CANCELLED", bookingId);
        reversePoints(bookingId, `Booking ${bookingId} was cancelled`);
        break;
      }
      case "booking.cancel_error":
        ticket(bookingId, "hotel", "cancellation-failed", `Nuitee reports a failed cancellation.\n${JSON.stringify(resp).slice(0, 1500)}`, row?.guest_email);
        break;
      case "booking.refund":
        try { db.prepare("INSERT INTO support_tickets (ref, email, booking_id, booking_type, category, summary, status) VALUES (?, ?, ?, 'hotel', 'refund-issued', ?, 'closed')").run("PS-" + crypto.randomBytes(3).toString("hex").toUpperCase(), row?.guest_email || "", bookingId, `Refund issued by Nuitee: ${findKey(resp, ["amountRefunded", "refundAmount", "refund_amount", "amount"]) || "?"} ${findKey(resp, ["currency"]) || ""}`); } catch {}
        break;
      case "booking.amendment.relocation":
        ticket(bookingId, "hotel", "relocation", `The guest is being relocated to another hotel. Contact the guest to confirm the new details.\n${JSON.stringify(resp).slice(0, 1500)}`, row?.guest_email);
        break;
      case "booking.compensation":
        ticket(bookingId, "hotel", "compensation", `Compensation issued for this booking. Let the guest know.\n${JSON.stringify(resp).slice(0, 1500)}`, row?.guest_email);
        break;
      case "booking.amendment":
      case "booking.rebook.rfn":
      case "booking.rebook.nrfn": {
        const newId = name.startsWith("booking.rebook") ? findKey(resp, ["newBookingId", "rebookBookingId"]) : null;
        if (newId && row && newId !== bookingId) db.prepare("UPDATE bookings SET liteapi_booking_id = ? WHERE liteapi_booking_id = ?").run(newId, bookingId);
        break;
      }
    }
    return { bookingId };
  }

  function register(app) {
    app.post("/api/webhooks/liteapi", (req, res) => {
      const secret = (process.env.LITEAPI_WEBHOOK_SECRET || "").trim();
      const got = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!secret || !got || !safeEq(got, secret)) return res.status(401).json({ error: "Unauthorized" });
      const b = req.body || {};
      const id = String(b.event_id || ""), name = String(b.event_name || "");
      if (!id || !name) return res.status(400).json({ error: "Missing event_id or event_name" });
      if (db.prepare("SELECT 1 FROM webhook_events WHERE event_id = ?").get(id)) return res.json({ ok: true, duplicate: true });
      let out = {};
      try { out = handle(name, parse(b.request), parse(b.response)); }
      catch (err) { console.error("Webhook error:", name, err.message); return res.status(500).json({ error: "Processing failed" }); }
      db.prepare("INSERT OR IGNORE INTO webhook_events (event_id, event_name, booking_id, sandbox) VALUES (?, ?, ?, ?)").run(id, name, out.bookingId || null, b.sandbox ? 1 : 0);
      res.json({ ok: true });
    });
  }
  return { register };
}

module.exports = { createWebhooks };
