/**
 * My trips → "Seats & bags": add paid seats and bags to a booked flight.
 * Prices come from the live catalog (server side); payment uses the LiteAPI
 * Payment SDK, which redirects back to /my-bookings?fx=<bookingId>&chargesId=…
 * where FX.handleReturn() confirms the charge.
 */
(function () {
  const FX = {};
  const alertBox = (kind, html) => `<div class="alert ${kind}" style="margin-top:12px">${PS.icon(kind === "success" ? "check" : kind === "info" ? "info" : "alert", 18)}<div>${html}</div></div>`;
  const segLabel = (segs, key) => { const s = segs.find(x => x.segmentKey === key); return s && s.from && s.to ? `${s.from} → ${s.to}` : ""; };

  FX.open = async function (box, bookingId) {
    box.hidden = false;
    box.innerHTML = `<div class="loading-note" style="border:0;padding:0"><span class="spinner"></span>Loading seats and bags…</div>`;
    let d;
    try { d = (await PS.api(`/api/flights/bookings/${encodeURIComponent(bookingId)}/services`)).data; }
    catch (e) { box.innerHTML = alertBox("error", PS.esc(e.message)); return; }

    const pax = d.passengers.length ? d.passengers : [{ index: 0, name: "Passenger 1" }];
    const picks = new Map(); // serviceId → passengerIndex
    const byId = new Map();
    const groups = d.groups.filter(g => g.available !== false && (g.services || []).some(s => +s.pricing?.display?.amount > 0));
    groups.forEach(g => g.services.forEach(s => byId.set(s.serviceId, s)));

    const booked = d.bookedServices.map(s => `<li>${PS.esc(s.name || s.category)}${pax[s.passengerIndex] ? " · " + PS.esc(pax[s.passengerIndex].name) : ""}</li>`).join("");
    const requested = d.requests.flatMap(r => r.lines.map(l => `<li>${PS.esc(l.name)} · ${PS.esc(l.passenger)} · ${r.status === "fulfilled" ? "added" : "paid, we're adding it with the airline"}</li>`)).join("");
    const paxSelect = (id) => pax.length > 1 ? `<select data-pax="${PS.esc(id)}" aria-label="Passenger">${pax.map(p => `<option value="${p.index}">${PS.esc(p.name)}</option>`).join("")}</select>` : "";

    const item = (s) => {
      const amt = +s.pricing?.display?.amount, cur = s.pricing?.display?.currency || d.currency;
      if (!(amt > 0)) return "";
      const seat = s.metadata?.seat;
      if (seat && seat.available === false) return "";
      const sub = [segLabel(d.segments, s.segmentKey), seat?.position, seat?.seatType && seat.seatType.replace(/_/g, " ")].filter(Boolean).join(" · ");
      return `<label class="fx-item${picks.has(s.serviceId) ? " on" : ""}"><span><input type="checkbox" data-sid="${PS.esc(s.serviceId)}"${picks.has(s.serviceId) ? " checked" : ""}> ${PS.esc(s.name)}${sub ? `<small>${PS.esc(sub)}</small>` : ""}</span>
        <span style="text-align:right"><b>${PS.money(amt, cur, 2)}</b>${paxSelect(s.serviceId)}</span></label>`;
    };

    const render = () => {
      const total = [...picks.keys()].reduce((a, id) => a + (+byId.get(id)?.pricing?.display?.amount || 0), 0);
      box.innerHTML = `
        ${booked ? `<h4>Already on your booking</h4><ul class="fx-done">${booked}</ul>` : ""}
        ${requested ? `<h4>Your extra requests</h4><ul class="fx-done">${requested}</ul>` : ""}
        ${groups.length ? groups.map(g => `<h4>${PS.esc(g.label || g.category)}</h4><div class="fx-list">${g.services.map(item).join("")}</div>`).join("")
          : `<p class="fx-done">No extra seats or bags can be added to this booking right now.</p>`}
        ${groups.length ? `<div class="fx-bar"><span class="price-sub">Seats and bags are added by our team with the airline after payment. If the airline can't add something, we refund it.</span>
          <button class="btn btn-primary" data-pay ${picks.size ? "" : "disabled"}>${picks.size ? `Pay ${PS.money(total, d.currency || "USD", 2)}` : "Choose seats or bags"}</button></div>` : ""}
        <div data-msg></div>`;
      box.querySelectorAll("[data-sid]").forEach(cb => cb.onchange = () => {
        const s = byId.get(cb.dataset.sid);
        if (cb.checked) {
          // A single traveler gets one seat per flight: a new pick replaces the old one
          if (s.category === "seat" && pax.length === 1) for (const id of [...picks.keys()]) { const o = byId.get(id); if (o.category === "seat" && o.segmentKey === s.segmentKey) picks.delete(id); }
          // Default to the first traveler without a seat on this flight
          const taken = new Set([...picks].filter(([id]) => { const o = byId.get(id); return o.category === "seat" && o.segmentKey === s.segmentKey; }).map(([, i]) => i));
          picks.set(s.serviceId, s.category === "seat" ? (pax.find(p => !taken.has(p.index)) || pax[0]).index : 0);
        } else picks.delete(s.serviceId);
        render();
      });
      box.querySelectorAll("[data-pax]").forEach(sel => { if (picks.has(sel.dataset.pax)) sel.value = picks.get(sel.dataset.pax); sel.onchange = () => { if (picks.has(sel.dataset.pax)) picks.set(sel.dataset.pax, +sel.value); }; });
      const pay = box.querySelector("[data-pay]");
      if (pay) pay.onclick = () => startPayment(pay);
    };

    async function startPayment(btn) {
      const msg = box.querySelector("[data-msg]");
      btn.disabled = true; btn.textContent = "Preparing payment…";
      let r;
      try {
        r = (await PS.api(`/api/flights/bookings/${encodeURIComponent(bookingId)}/extras/precharge`, { method: "POST", body: { items: [...picks].map(([serviceId, passengerIndex]) => ({ serviceId, passengerIndex })) } })).data;
      } catch (e) { msg.innerHTML = alertBox("error", PS.esc(e.message)); render(); return; }
      if (typeof LiteAPIPayment !== "function") { msg.innerHTML = alertBox("error", "The payment form didn't load. Check your connection or disable ad blockers, then reload."); return; }
      let cfg = { publicKey: "sandbox" };
      try { const c = await PS.api("/api/payment-sdk/config"); cfg = c.configTemplate || cfg; if (c.isSandbox) msg.innerHTML = alertBox("info", "<b>Test mode.</b> Use card 4242 4242 4242 4242, any future expiry and any CVC."); } catch {}
      box.querySelectorAll("input,select").forEach(el => el.disabled = true);
      btn.hidden = true;
      document.getElementById("fxPayPortal")?.remove(); // one payment form on the page at a time
      const portal = document.createElement("div");
      portal.id = "fxPayPortal"; portal.className = "payment-sdk-box"; portal.style.marginTop = "12px";
      box.appendChild(portal);
      window.liteAPIPayment = new LiteAPIPayment({
        publicKey: cfg.publicKey || "sandbox",
        appearance: { theme: "flat" },
        options: { business: { name: "PlanurStay" } },
        targetElement: "#fxPayPortal",
        secretKey: r.secretKey,
        returnUrl: `${location.origin}${PS.url("/my-bookings", { fx: bookingId, chargesId: r.chargesId })}`,
      });
      window.liteAPIPayment.handlePayment();
      portal.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    render();
  };

  // Back from the payment page: confirm the charge. Returns HTML for a notice, or "".
  FX.handleReturn = async function () {
    const q = PS.qs();
    if (!q.fx || !q.chargesId) return "";
    history.replaceState(null, "", "/my-bookings");
    const rs = String(q.redirect_status || q.status || "").toLowerCase();
    if (["failed", "canceled", "cancelled", "requires_payment_method"].includes(rs)) return alertBox("error", "Payment for your seats and bags didn't go through. You haven't been charged.");
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = (await PS.api(`/api/flights/bookings/${encodeURIComponent(q.fx)}/extras/confirm`, { method: "POST", body: { chargesId: q.chargesId } }));
        const ref = r.data?.ticket ? ` Reference <b>${PS.esc(r.data.ticket)}</b>.` : "";
        return alertBox("success", `<b>Payment received for your seats and bags.</b> Our team is adding them with the airline and will email you when they're on your booking.${ref}`);
      } catch (e) {
        if (e.status !== 409 || attempt === 3) return alertBox("error", `${PS.esc(e.message)} Booking ${PS.esc(q.fx)}: email <a class="link" href="mailto:info@planurstay.com">info@planurstay.com</a> if you were charged.`);
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    return "";
  };

  window.FX = FX;
})();
