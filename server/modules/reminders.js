/**
 * "Still thinking about <city>?" reminder emails for signed-in members who searched or looked at a
 * hotel but didn't book.
 *
 * Rules: one email per search, sent 20–72 hours after the last activity; at most one reminder per member
 * every 3 days; never if the member booked since, if check-in is less than 2 days away, or if they've
 * turned reminders off. Prices are fetched fresh at send time (member prices). Needs Resend email.
 *
 *   GET /api/reminders/unsubscribe?t=<token>   one-click opt-out (link in every email)
 */
const pricing = require("./pricing");

function createReminders({ db, apiKey, jwt, JWT_SECRET, sendEmail, appUrl }) {
  try { db.exec("ALTER TABLE users ADD COLUMN reminders_off INTEGER DEFAULT 0"); } catch { /* exists */ }
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n); } catch { return `${cur} ${Math.round(n)}`; } };
  const fmtDate = (s) => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const base = () => (process.env.PUBLIC_URL || appUrl() || "").replace(/\/$/, "");

  async function freshPrices(i, extraIds = []) {
    const nights = Math.max(1, Math.round((Date.parse(i.checkout) - Date.parse(i.checkin)) / 86400000));
    const body = {
      placeId: i.place_id, checkin: i.checkin, checkout: i.checkout,
      occupancies: Array.from({ length: i.rooms || 1 }, (_, k) => ({ adults: k === 0 ? Math.max(1, (i.adults || 2) - ((i.rooms || 1) - 1)) : 1 })),
      currency: i.currency || "USD", guestNationality: "US", margin: 0, maxRatesPerHotel: 1, includeHotelData: true, limit: 100, timeout: 12,
    };
    const occ = body.occupancies;
    const r = await fetch("https://api.liteapi.travel/v3.0/hotels/rates", { method: "POST", headers: { "X-API-Key": apiKey(), "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    const meta = new Map((j.hotels || []).map(h => [h.id, h]));
    const list = [];
    for (const e of j.data || []) {
      let best = null;
      for (const rt of e.roomTypes || []) { const net = rt.offerRetailRate?.amount; if (net != null && (!best || net < best.net)) best = { net, ssp: rt.suggestedSellingPrice?.amount, cur: rt.offerRetailRate.currency }; }
      const h = meta.get(e.hotelId);
      if (!best || !h) continue;
      const p = pricing.priceFor(best.net, best.ssp, true);
      list.push({ id: e.hotelId, name: h.name, photo: h.thumbnail || h.main_photo, rating: h.rating || 0, reviews: h.review_count || 0, stars: h.stars || 0, perNight: p.total / nights, guestPerNight: p.publicTotal / nights, currency: best.cur });
    }
    // The hotel they looked at may not be in the area results: price it directly.
    const missing = extraIds.filter(id => id && !list.some(h => h.id === id));
    if (missing.length) {
      const r2 = await fetch("https://api.liteapi.travel/v3.0/hotels/rates", { method: "POST", headers: { "X-API-Key": apiKey(), "Content-Type": "application/json" }, body: JSON.stringify({ ...body, placeId: undefined, hotelIds: missing, occupancies: occ }), signal: AbortSignal.timeout(45000) });
      const j2 = await r2.json().catch(() => ({}));
      const meta2 = new Map((j2.hotels || []).map(h => [h.id, h]));
      for (const e of r2.ok ? j2.data || [] : []) {
        let best = null;
        for (const rt of e.roomTypes || []) { const net = rt.offerRetailRate?.amount; if (net != null && (!best || net < best.net)) best = { net, ssp: rt.suggestedSellingPrice?.amount, cur: rt.offerRetailRate.currency }; }
        const h = meta2.get(e.hotelId);
        if (!best || !h) continue;
        const p = pricing.priceFor(best.net, best.ssp, true);
        list.push({ id: e.hotelId, name: h.name, photo: h.thumbnail || h.main_photo, rating: h.rating || 0, reviews: h.review_count || 0, stars: h.stars || 0, perNight: p.total / nights, guestPerNight: p.publicTotal / nights, currency: best.cur, extra: true });
      }
    }
    return { list, nights };
  }

  function hotelUrl(i, id) {
    return `${base()}/hotel/${id}?` + new URLSearchParams({ checkin: i.checkin, checkout: i.checkout, adults: i.adults || 2, rooms: i.rooms || 1, placeId: i.place_id, dest: i.dest || "" });
  }

  async function sendOne(i) {
    const fp = await freshPrices(i, [i.hotel_id]);
    if (!fp || !fp.list.length) return false;
    const { list } = fp;
    const low = Math.min(...list.filter(h => !h.extra).map(h => h.perNight), ...list.map(h => h.perNight));
    const score = (h) => h.rating * Math.log10(10 + h.reviews) - h.perNight / (low * 40);
    const picks = [];
    const viewed = i.hotel_id && list.find(h => h.id === i.hotel_id);
    if (viewed) picks.push({ ...viewed, viewed: true });
    for (const h of [...list].sort((a, b) => score(b) - score(a))) { if (picks.length >= 3) break; if (!picks.some(p => p.id === h.id)) picks.push(h); }
    const dest = i.dest || "your trip";
    const drop = i.low_night && low < i.low_night * 0.97 ? Math.round((1 - low / i.low_night) * 100) : 0;
    const results = `${base()}/hotels?` + new URLSearchParams({ placeId: i.place_id, dest: i.dest || "", destDetail: i.dest_detail || "", checkin: i.checkin, checkout: i.checkout, adults: i.adults || 2, rooms: i.rooms || 1 });
    const unsub = `${base()}/api/reminders/unsubscribe?t=` + jwt.sign({ p: "unsub", u: i.user_id }, JWT_SECRET, { expiresIn: "365d" });
    const rows = picks.map(h => `
      <tr><td style="padding:10px 0;border-top:1px solid #eef1f6">
        <a href="${esc(hotelUrl(i, h.id))}" style="text-decoration:none;color:#0b1b3f;display:block">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="96" style="vertical-align:top">${h.photo ? `<img src="${esc(h.photo)}" width="88" height="66" style="border-radius:10px;object-fit:cover;display:block" alt="">` : ""}</td>
            <td style="vertical-align:top;font-family:Arial,sans-serif">
              ${h.viewed ? `<div style="font-size:11px;font-weight:700;color:#1f5bff;margin-bottom:2px">YOU LOOKED AT THIS</div>` : ""}
              <div style="font-weight:700;font-size:15px">${esc(h.name)}</div>
              <div style="color:#4a5572;font-size:13px">${h.rating ? `${h.rating.toFixed(1)}/10 · ${h.reviews.toLocaleString()} reviews` : ""}</div>
              <div style="font-size:14px;margin-top:4px"><b>${money(h.perNight, h.currency)}</b>/night <span style="color:#0a7d46;font-weight:700">member price</span></div>
            </td></tr></table></a></td></tr>`).join("");
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;background:#f6f8fc;padding:24px">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:26px;border:1px solid #e4e8f1">
        <div style="font-weight:800;font-size:18px;color:#1f5bff">PlanurStay</div>
        <h1 style="font-size:22px;color:#0b1b3f;margin:16px 0 6px">Still thinking about ${esc(dest)}?</h1>
        <p style="color:#4a5572;margin:0 0 6px">${fmtDate(i.checkin)} – ${fmtDate(i.checkout)} · ${i.adults || 2} guest${(i.adults || 2) > 1 ? "s" : ""}</p>
        ${drop ? `<p style="margin:10px 0;padding:10px 12px;border-radius:10px;background:#effaf4;color:#0a7d46;font-weight:700">Good news: prices are down ${drop}% since you looked.</p>` : `<p style="color:#4a5572;margin:10px 0">Hotels there start from <b style="color:#0b1b3f">${money(low, list[0].currency)}</b>/night right now.</p>`}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        <p style="margin:20px 0 6px"><a href="${esc(results)}" style="background:#1f5bff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">See all prices</a></p>
        <p style="color:#7a849c;font-size:12px;margin-top:22px">Prices change often and are confirmed at checkout. You're getting this because you searched on PlanurStay while signed in. <a href="${esc(unsub)}" style="color:#7a849c">Turn off these reminders</a>.</p>
      </div></div>`;
    return sendEmail({ to: i.email, subject: drop ? `Prices dropped ${drop}% in ${dest}` : `Still thinking about ${dest}?`, html });
  }

  let running = false;
  async function run() {
    if (running || !process.env.RESEND_API_KEY) return;
    running = true;
    try {
      const due = db.prepare(`
        SELECT i.*, u.email FROM search_intents i JOIN users u ON u.id = i.user_id
        WHERE i.reminded_at IS NULL AND COALESCE(u.reminders_off, 0) = 0
          AND i.updated_at <= datetime('now', '-20 hours') AND i.updated_at >= datetime('now', '-72 hours')
          AND i.checkin >= date('now', '+2 days')
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = i.user_id AND b.created_at >= i.created_at)
          AND NOT EXISTS (SELECT 1 FROM search_intents j WHERE j.user_id = i.user_id AND j.reminded_at >= datetime('now', '-3 days'))
        ORDER BY i.updated_at DESC LIMIT 50`).all();
      const seen = new Set();
      for (const i of due) {
        if (seen.has(i.user_id)) continue; // one per member per run (and the 3-day rule after that)
        seen.add(i.user_id);
        try {
          const ok = await sendOne(i);
          db.prepare("UPDATE search_intents SET reminded_at = CURRENT_TIMESTAMP WHERE id = ?").run(i.id); // mark even if no prices, to avoid retry loops
          if (ok) console.log(`Reminder sent: user ${i.user_id} → ${i.dest || i.place_id}`);
        } catch (e) { console.warn("Reminder:", e.message); }
      }
      db.prepare("DELETE FROM search_intents WHERE updated_at < datetime('now', '-60 days')").run();
    } finally { running = false; }
  }
  setTimeout(run, 2 * 60 * 1000).unref();
  setInterval(run, 30 * 60 * 1000).unref();

  function register(app) {
    app.get("/api/reminders/unsubscribe", (req, res) => {
      let ok = false;
      try { const t = jwt.verify(String(req.query.t || ""), JWT_SECRET); if (t.p === "unsub" && t.u) { db.prepare("UPDATE users SET reminders_off = 1 WHERE id = ?").run(t.u); ok = true; } } catch {}
      res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reminders — PlanurStay</title><link rel="stylesheet" href="/css/ps.css"></head>
        <body><main class="container" style="text-align:center;padding:90px 24px"><h1 style="font-size:28px">${ok ? "Reminders turned off" : "This link has expired"}</h1>
        <p style="color:var(--text-2);margin:10px 0 24px">${ok ? "You won't get \"Still thinking about…\" emails anymore. Booking confirmations and price alerts you set up aren't affected." : "Sign in and contact us if you'd like to stop reminder emails."}</p>
        <a class="btn btn-primary" href="/">Back to PlanurStay</a></main></body></html>`);
    });
  }
  return { register, run };
}

module.exports = { createReminders };
