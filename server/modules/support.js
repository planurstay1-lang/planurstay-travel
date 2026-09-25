/**
 * Customer support: booking lookup, live status, self-service hotel cancellation, flight refund
 * quotes and support tickets. Used by the AI assistant's tools and by the chat widget.
 *
 * Safety rules:
 *   - A booking is only shown to its signed-in owner, or to someone who gives the booking ID + the
 *     email used at checkout (same rule as "Find a booking").
 *   - The assistant can only PREPARE a cancellation. It returns a short-lived signed token; the
 *     cancellation runs only when the customer clicks "Cancel booking" in the widget
 *     (POST /api/support/cancel). Guests who aren't signed in must also enter a 6-digit code we
 *     email to the booking's address.
 *   - Flights: we show the airline's live refund quote; the cancellation itself goes to a person
 *     through a support ticket.
 *
 *   POST /api/support/cancel        { token, code? }
 *   POST /api/support/resend-code   { token }
 *   GET  /api/admin/tickets         admin only
 *   POST /api/admin/tickets/:ref    admin only { status }
 */
const crypto = require("crypto");

function createSupport({ db, jwt, JWT_SECRET, apiKey, isSandbox, sendEmail, isAdmin }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT UNIQUE,
      user_id INTEGER,
      email TEXT,
      booking_id TEXT,
      booking_type TEXT,
      category TEXT,
      summary TEXT,
      status TEXT DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS support_codes (
      booking_id TEXT PRIMARY KEY,
      code_hash TEXT,
      expires_at INTEGER,
      attempts INTEGER DEFAULT 0
    );
  `);
  const SUPPORT_EMAIL = () => process.env.SUPPORT_EMAIL || "info@planurstay.com";
  // Hotels: one host for both environments (the key decides). Flights: separate sandbox host.
  const bookHost = () => "https://book.liteapi.travel/v3.0";
  const flightHost = () => (isSandbox() ? "https://sandbox.book.liteapi.travel/v3.0" : "https://book.liteapi.travel/v3.0");
  const lite = async (url, method = "GET") => {
    const r = await fetch(url, { method, headers: { "X-API-Key": apiKey(), Accept: "application/json" }, signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
  };
  const userOf = (req) => { try { return jwt.verify(req.cookies?.token || "", JWT_SECRET); } catch { return null; } };
  const norm = (s) => String(s || "").trim();
  const low = (s) => norm(s).toLowerCase();
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ─── Ownership ───
  // Returns { type, row, via: "owner" | "email" } or null.
  function findOwned(req, bookingId, email) {
    const id = norm(bookingId), u = userOf(req);
    if (!id) return null;
    const hotel = db.prepare("SELECT * FROM bookings WHERE liteapi_booking_id = ? ORDER BY id LIMIT 1").get(id);
    let flight = null;
    try { flight = db.prepare("SELECT * FROM flight_bookings WHERE booking_id = ? OR liteapi_booking_ref = ? LIMIT 1").get(id, id); } catch {}
    if (hotel) {
      if (u && hotel.user_id === u.id) return { type: "hotel", row: hotel, via: "owner" };
      if (email && low(hotel.guest_email) === low(email)) return { type: "hotel", row: hotel, via: "email" };
    }
    if (flight && u && flight.user_id === u.id) return { type: "flight", row: flight, via: "owner" };
    return null;
  }

  function listMine(req) {
    const u = userOf(req);
    if (!u) return null;
    const hotels = db.prepare("SELECT liteapi_booking_id AS bookingId, status, hotel_name AS name, checkin, checkout, price, currency FROM bookings WHERE user_id = ? AND liteapi_booking_id IS NOT NULL GROUP BY liteapi_booking_id ORDER BY created_at DESC LIMIT 15").all(u.id).map(b => ({ type: "hotel", ...b }));
    let flights = [];
    try {
      flights = db.prepare("SELECT booking_id AS bookingId, liteapi_booking_ref AS pnr, status, total_amount AS price, currency, segments_json FROM flight_bookings WHERE user_id = ? ORDER BY created_at DESC LIMIT 15").all(u.id).map(f => {
        let s = []; try { s = JSON.parse(f.segments_json || "[]"); } catch {}
        delete f.segments_json;
        return { type: "flight", ...f, route: s.length ? `${s[0].originCode} → ${s[s.length - 1].destinationCode}` : "", departs: (s[0]?.departureTime || "").slice(0, 16) };
      });
    } catch {}
    return { email: u.email, bookings: [...hotels, ...flights] };
  }

  // ─── Live hotel status + what cancelling would cost right now ───
  function hotelTerms(data) {
    const cp = data.cancellationPolicies || data.rooms?.[0]?.cancellationPolicies || {};
    const infos = (cp.cancelPolicyInfos || []).map(p => ({ from: p.cancelTime, fee: +p.amount || 0, currency: p.currency, type: p.type }))
      .sort((a, b) => String(a.from).localeCompare(String(b.from)));
    const now = Date.now();
    const nonRefundable = cp.refundableTag === "NRFN";
    const applies = infos.filter(p => p.from && Date.parse(p.from.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(p.from) ? "" : "Z")) <= now);
    const total = +(data.price ?? data.totalAmount ?? data.sellingPrice ?? 0) || null;
    const feeNow = nonRefundable ? total : applies.length ? Math.max(...applies.map(p => p.fee)) : 0;
    const freeUntil = !nonRefundable && infos.length ? infos[0].from : null;
    return { nonRefundable, freeCancellationUntilGMT: freeUntil && feeNow === 0 ? freeUntil : null, estimatedFeeNow: feeNow, estimatedRefundNow: total != null && feeNow != null ? Math.max(0, +(total - feeNow).toFixed(2)) : null, policySteps: infos };
  }

  async function hotelStatus(row) {
    const r = await lite(`${bookHost()}/bookings/${encodeURIComponent(row.liteapi_booking_id)}?timeout=20`);
    const d = r.json?.data || {};
    if (!r.ok) return { bookingId: row.liteapi_booking_id, status: row.status, hotel: row.hotel_name, checkin: row.checkin, checkout: row.checkout, total: row.price, currency: row.currency, note: "Live status is unavailable right now; showing what we have on file." };
    const paid = +(d.sellingPrice || d.price || row.price || 0) || null;
    const terms = hotelTerms({ ...d, price: paid });
    if (!terms.freeCancellationUntilGMT && d.lastFreeCancellationDate && Date.parse(d.lastFreeCancellationDate) > Date.now() && !terms.nonRefundable) terms.freeCancellationUntilGMT = d.lastFreeCancellationDate;
    return {
      bookingId: row.liteapi_booking_id, status: d.status || row.status, hotel: d.hotelName || d.hotel?.name || row.hotel_name,
      checkin: d.checkin || row.checkin, checkout: d.checkout || row.checkout, guest: row.guest_name,
      hotelConfirmationCode: d.hotelConfirmationCode || null, total: paid, currency: d.currency || row.currency,
      cancelledAt: d.cancelledAt || null, amountRefunded: d.amountRefunded || null, refundedAt: d.refundedAt || null,
      specialRemarks: d.specialRemarks || null,
      ...terms,
    };
  }

  async function flightStatus(row) {
    const id = row.booking_id;
    const [b, q] = await Promise.all([
      lite(`${flightHost()}/flights/bookings/${encodeURIComponent(id)}`),
      lite(`https://api.liteapi.travel/v3.0/flights/bookings/${encodeURIComponent(id)}/cancellations`),
    ]);
    const bd = b.json?.data?.[0] || b.json?.data || {};
    const qd = Array.isArray(q.json?.data) ? q.json.data[0] : q.json?.data || null;
    return {
      bookingId: id, pnr: row.liteapi_booking_ref || bd.pnr || null, status: bd.status || row.status, total: row.total_amount, currency: row.currency,
      cancellationQuote: qd ? {
        confidence: qd.confidence, refundable: qd.isRefundable, voidable: qd.isVoidable,
        refund: qd.refund?.display?.amount, penalty: qd.penalty?.display?.amount, currency: qd.refund?.display?.currency || qd.penalty?.display?.currency,
        refundGoesTo: qd.destination, quoteExpires: qd.expiresAt,
      } : null,
    };
  }

  async function status(req, bookingId, email) {
    const o = findOwned(req, bookingId, email);
    if (!o) return { error: "No booking found for that booking ID and email. Check both, or sign in with the account used to book. Flight bookings can be looked up by their signed-in owner." };
    return o.type === "hotel" ? { type: "hotel", ...(await hotelStatus(o.row)) } : { type: "flight", ...(await flightStatus(o.row)) };
  }

  // ─── Cancellation (prepare → customer confirms in the widget) ───
  const hashCode = (bookingId, code) => crypto.createHash("sha256").update(`${bookingId}:${code}:${JWT_SECRET}`).digest("hex");
  async function emailCode(bookingId, email, hotelName) {
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare("INSERT INTO support_codes (booking_id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0) ON CONFLICT(booking_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0")
      .run(bookingId, hashCode(bookingId, code), Date.now() + 15 * 60 * 1000);
    return sendEmail({
      to: email, subject: `Your PlanurStay code: ${code}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><h2 style="margin:0 0 8px">Confirm your cancellation</h2>
        <p>Use this code to confirm cancelling your booking${hotelName ? ` at <b>${esc(hotelName)}</b>` : ""} (booking ID ${esc(bookingId)}):</p>
        <p style="font-size:30px;font-weight:800;letter-spacing:6px;margin:18px 0">${code}</p>
        <p style="color:#667">The code expires in 15 minutes. If you didn't ask to cancel, ignore this email; your booking is safe.</p></div>`,
    });
  }

  async function prepareCancellation(req, bookingId, email) {
    const o = findOwned(req, bookingId, email);
    if (!o) return { error: "No booking found for that booking ID and email." };
    if (o.type === "flight") {
      const s = await flightStatus(o.row);
      return { type: "flight", selfService: false, ...s, next: "Flight cancellations are handled by our team with the airline. Offer to open a support ticket (create_support_ticket, category 'cancellation') and share the quote above." };
    }
    const s = await hotelStatus(o.row);
    if (/CANCEL/i.test(s.status || "")) return { type: "hotel", alreadyCancelled: true, ...s };
    if (s.checkin && s.checkin < new Date().toISOString().slice(0, 10)) return { type: "hotel", selfService: false, ...s, next: "The stay has started or passed; this needs our team. Offer a support ticket." };
    const needsCode = o.via !== "owner";
    const token = jwt.sign({ p: "cancel", b: o.row.liteapi_booking_id, e: low(o.row.guest_email), c: needsCode ? 1 : 0 }, JWT_SECRET, { expiresIn: "20m" });
    let codeSent = false;
    if (needsCode) codeSent = await emailCode(o.row.liteapi_booking_id, o.row.guest_email, s.hotel).catch(() => false);
    return {
      type: "hotel", selfService: true, ...s, needsCode, codeSent,
      action: { kind: "cancel", token, bookingId: s.bookingId, hotel: s.hotel, checkin: s.checkin, checkout: s.checkout, total: s.total, currency: s.currency, fee: s.estimatedFeeNow, refund: s.estimatedRefundNow, nonRefundable: s.nonRefundable, needsCode, codeSent },
      next: needsCode
        ? (codeSent ? "A confirmation card is shown. Tell the customer we emailed a 6-digit code to the booking email; they enter it in the card and click Cancel booking. Nothing is cancelled until they do." : "We couldn't email a code. Suggest signing in with the account used to book, or open a support ticket.")
        : "A confirmation card is shown. The customer must click Cancel booking to confirm. Nothing is cancelled until they do.",
    };
  }

  // ─── Tickets ───
  function createTicket(req, { bookingId, email, category, summary }) {
    const u = userOf(req);
    const o = bookingId ? findOwned(req, bookingId, email) : null;
    const ref = "PS-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    const contact = low(email) || u?.email || o?.row?.guest_email || "";
    if (!contact) return { error: "Need an email address so our team can reply." };
    db.prepare("INSERT INTO support_tickets (ref, user_id, email, booking_id, booking_type, category, summary) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ref, u?.id || null, contact, o ? norm(bookingId) : norm(bookingId) || null, o?.type || null, norm(category).slice(0, 40) || "other", norm(summary).slice(0, 2000));
    const verified = o ? `Verified (${o.via === "owner" ? "signed-in owner" : "booking ID + email match"})` : bookingId ? "NOT verified: booking ID and email did not match our records" : "No booking";
    sendEmail({
      to: SUPPORT_EMAIL(), replyTo: contact, subject: `[${ref}] ${category || "Support"}${bookingId ? ` · ${bookingId}` : ""}`,
      html: `<div style="font-family:Arial,sans-serif"><h3>New support request ${ref}</h3><p><b>Customer:</b> ${esc(contact)}<br><b>Booking:</b> ${esc(bookingId || "-")} (${esc(o?.type || "unknown")}) · ${esc(verified)}<br><b>Category:</b> ${esc(category)}</p><p style="white-space:pre-wrap">${esc(summary)}</p>
        <p style="color:#667">If the hotel or airline needs to act, contact Nuitee support from the Nuitee Connect dashboard (Request Assistance) with the booking ID.</p></div>`,
    }).catch(() => {});
    sendEmail({
      to: contact, subject: `We've got your request (${ref})`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2 style="margin:0 0 8px">We're on it</h2><p>Thanks for contacting PlanurStay. Your request reference is <b>${ref}</b>. Our team will reply within 1 business day, usually sooner.</p><p style="color:#667;white-space:pre-wrap">${esc(summary)}</p></div>`,
    }).catch(() => {});
    return { ref, email: contact, bookingVerified: !!o };
  }

  function register(app) {
    app.post("/api/support/cancel", async (req, res) => {
      let t;
      try { t = jwt.verify(String(req.body?.token || ""), JWT_SECRET); } catch { return res.status(400).json({ error: "This cancellation request has expired. Ask the assistant again to get a new one." }); }
      if (t.p !== "cancel" || !t.b) return res.status(400).json({ error: "Invalid request" });
      const row = db.prepare("SELECT * FROM bookings WHERE liteapi_booking_id = ? ORDER BY id LIMIT 1").get(t.b);
      if (!row || low(row.guest_email) !== t.e) return res.status(404).json({ error: "Booking not found" });
      if (t.c) {
        const c = db.prepare("SELECT * FROM support_codes WHERE booking_id = ?").get(t.b);
        if (!c || c.expires_at < Date.now()) return res.status(400).json({ error: "The code has expired. Tap 'Send a new code'." });
        if (c.attempts >= 5) return res.status(429).json({ error: "Too many attempts. Tap 'Send a new code'." });
        if (hashCode(t.b, String(req.body?.code || "").trim()) !== c.code_hash) {
          db.prepare("UPDATE support_codes SET attempts = attempts + 1 WHERE booking_id = ?").run(t.b);
          return res.status(400).json({ error: "That code isn't right. Check the email we sent and try again." });
        }
      }
      const r = await lite(`${bookHost()}/bookings/${encodeURIComponent(t.b)}?timeout=30`, "PUT");
      const d = r.json?.data || {};
      if (!r.ok || !/CANCEL/i.test(d.status || "")) {
        const msg = r.json?.error?.message || r.json?.error?.description || "The hotel didn't accept the cancellation";
        const tk = createTicket(req, { bookingId: t.b, email: row.guest_email, category: "cancellation-failed", summary: `Self-service cancellation failed: ${msg}` });
        return res.status(502).json({ error: `We couldn't cancel this automatically (${msg}). Our team will handle it: reference ${tk.ref}.` });
      }
      db.prepare("UPDATE bookings SET status = ? WHERE liteapi_booking_id = ?").run(d.status, t.b);
      db.prepare("DELETE FROM support_codes WHERE booking_id = ?").run(t.b);
      // Points from a cancelled stay are never released
      try { db.prepare("UPDATE rewards_ledger SET type = 'reverse', points = 0, note = ? WHERE booking_ref = ? AND type = 'pending'").run(`Booking ${t.b} was cancelled`, t.b); } catch {}
      try { db.prepare("INSERT INTO support_tickets (ref, user_id, email, booking_id, booking_type, category, summary, status) VALUES (?, ?, ?, ?, 'hotel', 'self-cancel', ?, 'closed')").run("PS-" + crypto.randomBytes(3).toString("hex").toUpperCase(), row.user_id, row.guest_email, t.b, `Cancelled by customer via assistant. Status ${d.status}; fee ${d.cancellation_fee ?? "?"} ${d.currency || ""}; refund ${d.refund_amount ?? "?"}.`); } catch {}
      sendEmail({
        to: row.guest_email, subject: `Your booking at ${row.hotel_name || "the hotel"} is cancelled`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2 style="margin:0 0 8px">Booking cancelled</h2>
          <p>Your booking <b>${esc(t.b)}</b> at <b>${esc(row.hotel_name || "")}</b> (${esc(row.checkin)} to ${esc(row.checkout)}) has been cancelled.</p>
          <p>Refund: <b>${esc(d.refund_amount ?? "-")} ${esc(d.currency || row.currency || "")}</b>${d.cancellation_fee ? ` · Cancellation fee: ${esc(d.cancellation_fee)} ${esc(d.currency || "")}` : ""}</p>
          <p style="color:#667">Refunds go back to the card you paid with, usually within 5 to 10 business days. Questions? Reply to this email.</p></div>`,
      }).catch(() => {});
      res.json({ success: true, status: d.status, refund: d.refund_amount, fee: d.cancellation_fee, currency: d.currency || row.currency });
    });

    app.post("/api/support/resend-code", async (req, res) => {
      let t;
      try { t = jwt.verify(String(req.body?.token || ""), JWT_SECRET); } catch { return res.status(400).json({ error: "This request has expired. Ask the assistant again." }); }
      if (t.p !== "cancel" || !t.c) return res.status(400).json({ error: "Invalid request" });
      const row = db.prepare("SELECT hotel_name, guest_email FROM bookings WHERE liteapi_booking_id = ? LIMIT 1").get(t.b);
      if (!row) return res.status(404).json({ error: "Booking not found" });
      const ok = await emailCode(t.b, row.guest_email, row.hotel_name).catch(() => false);
      res.json(ok ? { success: true } : { error: "We couldn't send the email. Please contact support." });
    });

    app.get("/api/admin/tickets", (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: "Admins only" });
      res.json({ success: true, data: db.prepare("SELECT ref, email, booking_id, booking_type, category, summary, status, created_at FROM support_tickets ORDER BY id DESC LIMIT 100").all() });
    });
    app.post("/api/admin/tickets/:ref", (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: "Admins only" });
      const st = ["open", "closed"].includes(req.body?.status) ? req.body.status : null;
      if (!st) return res.status(400).json({ error: "status must be open or closed" });
      db.prepare("UPDATE support_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE ref = ?").run(st, req.params.ref);
      res.json({ success: true });
    });
  }

  return { register, listMine, status, prepareCancellation, createTicket };
}

module.exports = { createSupport };
