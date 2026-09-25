/**
 * Seats & bags after a flight is booked (signed-in owner only).
 *
 *   GET  /api/flights/bookings/:id/services          live catalog + booked services + paid requests
 *   POST /api/flights/bookings/:id/extras/precharge  { items: [{ serviceId, passengerIndex }] }
 *   POST /api/flights/bookings/:id/extras/confirm    { chargesId }
 *
 * Prices always come from the live LiteAPI catalog, never from the browser.
 * LiteAPI can't attach services to an existing booking yet, so once the charge is
 * captured we open a support ticket and a person asks the airline to add them.
 */
function createFlightExtras({ db, jwt, JWT_SECRET, flightEngine, support }) {
  const userOf = (req) => { try { return jwt.verify(req.cookies?.token || "", JWT_SECRET); } catch { return null; } };

  // Returns the owner's flight_bookings row, or sends the error response and returns null.
  function owned(req, res) {
    const u = userOf(req);
    if (!u) { res.status(401).json({ error: "Sign in to manage this booking" }); return null; }
    const row = db.prepare("SELECT * FROM flight_bookings WHERE booking_id = ? AND user_id = ? LIMIT 1").get(String(req.params.id || ""), u.id);
    if (!row) { res.status(404).json({ error: "We couldn't find this booking in your trips" }); return null; }
    return { user: u, row };
  }
  const httpStatus = (r, fallback = 502) => {
    const s = r.status || r.error?.code;
    return [400, 402, 403, 404, 409].includes(s) ? s : fallback;
  };
  const passengersOf = (b) => (b?.passengers || []).map((p, i) => ({ index: i, name: [p.firstName, p.lastName].filter(Boolean).join(" ") || `Passenger ${i + 1}`, type: p.type || p.passengerType || "ADT" }));
  const requestsOf = (bookingId) => db.prepare("SELECT charges_id AS chargesId, currency, total_amount AS total, lines_json, status, confirmed_at AS confirmedAt FROM flight_extra_charges WHERE booking_id = ? AND status != 'pending' ORDER BY id DESC")
    .all(bookingId).map(r => { let lines = []; try { lines = JSON.parse(r.lines_json || "[]"); } catch {} delete r.lines_json; return { ...r, lines }; });

  function register(app) {
    app.get("/api/flights/bookings/:id/services", async (req, res) => {
      const o = owned(req, res); if (!o) return;
      try {
        const [svc, bk] = await Promise.all([flightEngine.getBookingServices(o.row.booking_id), flightEngine.getBooking(o.row.booking_id).catch(() => null)]);
        if (!svc.success) return res.status(httpStatus(svc)).json({ error: svc.error?.message || "Seats and bags aren't available for this booking right now" });
        const booking = bk?.success ? bk.data?.booking || bk.data : null;
        res.json({ success: true, data: {
          ...svc.data,
          status: booking?.status || o.row.status,
          currency: o.row.currency,
          passengers: passengersOf(booking),
          segments: (booking?.journey?.segments || []).map(s => ({ segmentKey: s.segmentKey, from: s.originCode || s.departureAirport?.code, to: s.destinationCode || s.arrivalAirport?.code, departureTime: s.departureTime, flightNumber: s.flightNumber })),
          requests: requestsOf(o.row.booking_id),
        } });
      } catch (err) {
        console.error("Flight services error:", err.message);
        res.status(500).json({ error: "Server error" });
      }
    });

    app.post("/api/flights/bookings/:id/extras/precharge", async (req, res) => {
      const o = owned(req, res); if (!o) return;
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
      if (!items.length) return res.status(400).json({ error: "Choose at least one seat or bag" });
      if (/CANCEL|FAIL|REFUND/i.test(o.row.status || "")) return res.status(409).json({ error: "Extras can only be added to a confirmed booking" });
      try {
        const [svc, bk] = await Promise.all([flightEngine.getBookingServices(o.row.booking_id), flightEngine.getBooking(o.row.booking_id).catch(() => null)]);
        if (!svc.success) return res.status(httpStatus(svc)).json({ error: svc.error?.message || "Seats and bags aren't available right now" });
        const catalog = new Map();
        for (const g of svc.data.groups) if (g.available !== false) for (const s of g.services || []) catalog.set(s.serviceId, s);
        const pax = passengersOf(bk?.success ? bk.data?.booking || bk.data : null);
        const seen = new Set(), lines = [];
        for (const it of items) {
          const s = catalog.get(it?.serviceId);
          if (!s) return res.status(409).json({ error: "One of your choices is no longer available. Please refresh and pick again." });
          if (s.category === "seat" && s.metadata?.seat?.available === false) return res.status(409).json({ error: `${s.name} was just taken. Please pick another seat.` });
          const amount = +s.pricing?.display?.amount, currency = s.pricing?.display?.currency || o.row.currency;
          if (!(amount > 0)) return res.status(400).json({ error: `${s.name} is already included in your fare` });
          const p = pax.length ? pax[+it.passengerIndex] : { index: +it.passengerIndex || 0, name: `Passenger ${(+it.passengerIndex || 0) + 1}` };
          if (!p) return res.status(400).json({ error: "Choose a passenger for each extra" });
          const key = `${s.serviceId}:${s.category === "seat" ? "" : p.index}`; // a seat can only be sold once
          if (seen.has(key)) return res.status(400).json({ error: `${s.name} is selected twice` });
          seen.add(key);
          if (s.category === "seat") {
            const seatKey = `seat:${s.segmentKey}:${p.index}`;
            if (seen.has(seatKey)) return res.status(400).json({ error: `${p.name} has two seats on the same flight` });
            seen.add(seatKey);
          }
          lines.push({ serviceId: s.serviceId, name: s.name, category: s.category, segmentKey: s.segmentKey, passengerIndex: p.index, passenger: p.name, amount, currency });
        }
        if (new Set(lines.map(l => l.currency)).size > 1) return res.status(400).json({ error: "These extras are priced in different currencies. Please add them separately." });
        if (o.row.currency && lines[0].currency !== o.row.currency) return res.status(400).json({ error: `Extras must be paid in ${o.row.currency}, the currency of your booking` });

        const r = await flightEngine.prechargeExtras(o.row.booking_id, lines.map(l => ({ description: `${l.name} · ${l.passenger}`.slice(0, 200), currency: l.currency, amount: l.amount })), true);
        if (!r.success) {
          const s = httpStatus(r);
          const msg = s === 403 ? "Adding extras after booking isn't available yet. Contact us and we'll arrange it."
            : s === 409 ? "Extras can't be added to this booking in its current status" : r.error?.message || "We couldn't price these extras";
          return res.status(s).json({ error: msg });
        }
        const d = r.data;
        const types = d.paymentTypes || [];
        // Card only: a CREDIT booking would bill our credit line, not the traveler.
        if (!types.includes("TRANSACTION_ID") || !d.secretKey || !d.transactionId) {
          return res.status(409).json({ error: "This booking can't take card payments for extras online. Contact us and we'll arrange it." });
        }
        db.prepare(`INSERT OR REPLACE INTO flight_extra_charges (charges_id, booking_id, user_id, currency, total_amount, lines_json, payment_method, transaction_id, status)
          VALUES (?, ?, ?, ?, ?, ?, 'TRANSACTION_ID', ?, 'pending')`)
          .run(d.chargesId, o.row.booking_id, o.user.id, d.pendingCurrency || lines[0].currency, d.pendingTotal ?? lines.reduce((a, l) => a + l.amount, 0), JSON.stringify(lines), d.transactionId);
        res.json({ success: true, data: { chargesId: d.chargesId, transactionId: d.transactionId, secretKey: d.secretKey, total: d.pendingTotal, currency: d.pendingCurrency, lines } });
      } catch (err) {
        console.error("Flight extras precharge error:", err.message);
        res.status(500).json({ error: "Server error" });
      }
    });

    app.post("/api/flights/bookings/:id/extras/confirm", async (req, res) => {
      const o = owned(req, res); if (!o) return;
      const chargesId = String(req.body?.chargesId || "");
      const batch = chargesId && db.prepare("SELECT * FROM flight_extra_charges WHERE charges_id = ? AND booking_id = ? AND user_id = ?").get(chargesId, o.row.booking_id, o.user.id);
      if (!batch) return res.status(404).json({ error: "We couldn't find this payment. If you were charged, contact us." });
      if (batch.status !== "pending") return res.json({ success: true, alreadyConfirmed: true, data: { chargesId, status: batch.status } });
      try {
        const r = await flightEngine.confirmExtras(o.row.booking_id, chargesId, { method: batch.payment_method, transactionId: batch.transaction_id });
        if (!r.success) {
          const s = httpStatus(r);
          if (s === 409) return res.status(409).json({ error: "We're still confirming this payment. Please try again in a moment.", retry: true });
          return res.status(s).json({ error: r.error?.message || "We couldn't confirm the payment" });
        }
        // Only the request that flips pending → paid opens the ticket (guards against double submits).
        const flipped = db.prepare("UPDATE flight_extra_charges SET status = 'paid', confirmed_at = CURRENT_TIMESTAMP WHERE charges_id = ? AND status = 'pending'").run(chargesId).changes;
        let ticket = null;
        if (flipped && support?.createTicket) {
          let lines = []; try { lines = JSON.parse(batch.lines_json || "[]"); } catch {}
          const summary = `Paid post-booking extras (${batch.total_amount} ${batch.currency}), chargesId ${chargesId}, transaction ${batch.transaction_id}.\n`
            + `LiteAPI can't attach services to an existing booking yet: ask the airline (via Nuitee) to add these to PNR ${o.row.liteapi_booking_ref || "-"}, or refund if they can't.\n`
            + lines.map(l => `- ${l.name} for ${l.passenger} (segment ${l.segmentKey || "-"}): ${l.amount} ${l.currency}`).join("\n");
          try { ticket = support.createTicket(req, { bookingId: o.row.booking_id, email: o.user.email, category: "flight-extras", summary }); } catch (e) { console.warn("Flight extras ticket:", e.message); }
        }
        res.json({ success: true, data: { chargesId, status: "paid", ticket: ticket?.ref || null, extraChargesTotal: r.data?.extraChargesTotal, currency: r.data?.extraChargesCurrency || batch.currency } });
      } catch (err) {
        console.error("Flight extras confirm error:", err.message);
        res.status(500).json({ error: "Server error" });
      }
    });
  }

  return { register };
}

module.exports = { createFlightExtras };
