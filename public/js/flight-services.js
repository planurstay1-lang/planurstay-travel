/**
 * Checkout → "Seats & bags" (LiteAPI 1.2: attach services to a prebook).
 * Shown after the fare is held, above the card form. The traveler picks seats on a small seat map
 * and extra bags per person; "Add to booking" attaches them and returns a NEW payment intent for
 * the higher total, which the caller swaps in (onAttached).
 */
(function () {
  const FS = {};
  const money = (n, c) => PS.money(n, c, 2);

  FS.mount = function (box, { pb, sel, passengers, voucherCode, onAttached }) {
    const groups = (pb.servicesAttachable?.groups || []).filter(g => g.available !== false);
    const all = groups.flatMap(g => (g.services || []).map(s => ({ ...s, category: s.category || g.category })));
    const priced = all.filter(s => +s.pricing?.display?.amount >= 0);
    const seats = priced.filter(s => s.category === "seat" && s.metadata?.seat);
    const bags = priced.filter(s => s.category === "baggage" && +s.pricing?.display?.amount > 0);
    if (!seats.length && !bags.length) { box.innerHTML = ""; return; }
    const byId = new Map(priced.map(s => [s.serviceId, s]));
    const segs = (sel.journey?.segments || []).filter(s => priced.some(x => x.segmentKey === s.segmentKey) || priced.some(x => !x.segmentKey));
    const segLabel = (k) => { const s = segs.find(x => x.segmentKey === k); return s ? `${s.originCode} → ${s.destinationCode}` : "All flights"; };
    const pax = passengers.map((p, i) => ({ i, name: [p.firstName, p.lastName].filter(Boolean).join(" ") || `Traveler ${i + 1}` }));
    const cur = priced[0]?.pricing?.display?.currency || pb.currency;

    // Selection: seat per traveler per flight; bags per traveler (quantity 1 each)
    const seatPick = new Map();   // `${pi}|${segmentKey}` → serviceId
    const bagPick = new Set();    // `${pi}|${serviceId}`
    let attached = null;          // { key, total } once added
    let who = 0, segIdx = 0;
    const seatSegs = [...new Set(seats.map(s => s.segmentKey))];

    const selection = () => [
      ...[...seatPick].map(([k, id]) => ({ serviceId: id, passengerIndex: +k.split("|")[0], quantity: 1 })),
      ...[...bagPick].map(k => { const [pi, id] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)]; return { serviceId: id, passengerIndex: +pi, quantity: 1 }; }),
    ];
    const selKey = () => JSON.stringify(selection().map(s => s.passengerIndex + s.serviceId).sort());
    const extra = () => selection().reduce((a, s) => a + (+byId.get(s.serviceId)?.pricing?.display?.amount || 0), 0);
    const seatOwner = (id) => { for (const [k, v] of seatPick) if (v === id) return +k.split("|")[0]; return -1; };

    function seatMap(segKey) {
      const list = seats.filter(s => s.segmentKey === segKey);
      if (!list.length) return "";
      const cols = [...new Set(list.map(s => s.metadata.seat.seatColumn).filter(Boolean))].sort();
      const rows = [...new Set(list.map(s => +s.metadata.seat.seatRow).filter(Boolean))].sort((a, b) => a - b);
      const at = new Map(list.map(s => [`${s.metadata.seat.seatRow}${s.metadata.seat.seatColumn}`, s]));
      const posOf = (c) => list.find(s => s.metadata.seat.seatColumn === c)?.metadata.seat.position;
      const gapAfter = new Set(cols.filter((c, k) => k < cols.length - 1 && posOf(c) === "aisle" && posOf(cols[k + 1]) === "aisle"));
      const cell = (s) => {
        if (!s) return `<span class="fs-seat none"></span>`;
        const m = s.metadata.seat, amt = +s.pricing.display.amount, owner = seatOwner(s.serviceId);
        const taken = m.available === false || (owner >= 0 && owner !== who);
        const mine = seatPick.get(`${who}|${segKey}`) === s.serviceId;
        const cls = taken ? "taken" : mine ? "mine" : m.seatType && m.seatType !== "standard" ? "plus" : amt > 0 ? "paid" : "free";
        return `<button type="button" class="fs-seat ${cls}" data-seat="${PS.esc(s.serviceId)}" ${taken ? "disabled" : ""} title="${PS.esc(`${m.seatNumber || s.name} · ${m.position || ""}${m.seatType && m.seatType !== "standard" ? " · " + m.seatType.replace(/_/g, " ") : ""} · ${amt > 0 ? money(amt, cur) : "free"}`)}">${owner >= 0 ? pax[owner].name[0] : ""}</button>`;
      };
      return `<div class="fs-map"><div class="fs-row head"><span class="fs-rn"></span>${cols.map(c => `<span class="fs-col">${c}</span>${gapAfter.has(c) ? `<span class="fs-gap"></span>` : ""}`).join("")}</div>
        ${rows.map(r => `<div class="fs-row"><span class="fs-rn">${r}</span>${cols.map(c => cell(at.get(`${r}${c}`)) + (gapAfter.has(c) ? `<span class="fs-gap"></span>` : "")).join("")}</div>`).join("")}</div>`;
    }
    const legend = `<div class="fs-legend"><span><i class="fs-seat free"></i>Free</span><span><i class="fs-seat paid"></i>Paid</span><span><i class="fs-seat plus"></i>Extra legroom / exit</span><span><i class="fs-seat mine"></i>Selected</span><span><i class="fs-seat taken"></i>Taken</span></div>`;

    function render() {
      const segKey = seatSegs[segIdx];
      const chosen = seatPick.get(`${who}|${segKey}`);
      const cs = chosen && byId.get(chosen);
      const myBags = bags.filter(b => b.passengerType === "ALL" || !b.passengerType || b.passengerType === "ADT");
      const total = extra(), changed = !attached || attached.key !== selKey();
      box.innerHTML = `<section class="fs">
        <div class="fs-head"><h3>${PS.icon("suitcase", 18)}Seats &amp; bags <small>optional</small></h3><span class="price-sub">Booked with the airline together with your ticket.</span></div>
        ${pax.length > 1 ? `<div class="fs-tabs">${pax.map(p => `<button type="button" data-who="${p.i}" class="${p.i === who ? "on" : ""}">${PS.esc(p.name)}</button>`).join("")}</div>` : ""}
        ${seats.length ? `<div class="fs-block"><div class="fs-sub"><b>Seat</b>${seatSegs.length > 1 ? `<span class="fs-segs">${seatSegs.map((k, i) => `<button type="button" data-seg="${i}" class="${i === segIdx ? "on" : ""}">${PS.esc(segLabel(k))}</button>`).join("")}</span>` : `<span class="price-sub">${PS.esc(segLabel(segKey))}</span>`}</div>
          <div class="fs-pick">${cs ? `<b>${PS.esc(cs.metadata.seat.seatNumber || cs.name)}</b> · ${PS.esc(cs.metadata.seat.position || "")} · ${+cs.pricing.display.amount > 0 ? money(+cs.pricing.display.amount, cur) : "free"} <button type="button" class="link-btn" data-clear>Remove</button>` : `<span class="price-sub">No seat chosen: the airline assigns one at check-in.</span>`}</div>
          <div class="fs-scroll">${seatMap(segKey)}</div>${legend}</div>` : ""}
        ${myBags.length ? `<div class="fs-block"><div class="fs-sub"><b>Extra bags</b></div>
          ${myBags.map(b => { const m = b.metadata?.baggage || {}; const on = bagPick.has(`${who}|${b.serviceId}`);
            return `<label class="fs-bag ${on ? "on" : ""}"><input type="checkbox" data-bag="${PS.esc(b.serviceId)}" ${on ? "checked" : ""}><span>${PS.esc(b.name)}${m.weightKg ? ` · ${m.weightKg} kg` : ""}<small>${PS.esc(segLabel(b.segmentKey))}</small></span><b>${money(+b.pricing.display.amount, cur)}</b></label>`; }).join("")}</div>` : ""}
        <div class="fs-foot"><span>${total > 0 ? `Seats &amp; bags: <b>+${money(total, cur)}</b>` : "Nothing added"}${attached && !changed ? ` · ${PS.icon("check", 14, 2.6)} added to your booking` : ""}</span>
          <button type="button" class="btn btn-primary btn-sm" data-add ${changed && (selection().length || attached) ? "" : "disabled"}>${attached && !selection().length ? "Remove extras" : attached ? "Update booking" : "Add to booking"}</button></div>
        <div data-msg></div></section>`;
      box.querySelectorAll("[data-who]").forEach(b => b.onclick = () => { who = +b.dataset.who; render(); });
      box.querySelectorAll("[data-seg]").forEach(b => b.onclick = () => { segIdx = +b.dataset.seg; render(); });
      box.querySelectorAll("[data-seat]").forEach(b => b.onclick = () => {
        const k = `${who}|${segKey}`;
        if (seatPick.get(k) === b.dataset.seat) seatPick.delete(k); else seatPick.set(k, b.dataset.seat);
        render();
      });
      box.querySelector("[data-clear]")?.addEventListener("click", () => { seatPick.delete(`${who}|${segKey}`); render(); });
      box.querySelectorAll("[data-bag]").forEach(c => c.onchange = () => { const k = `${who}|${c.dataset.bag}`; c.checked ? bagPick.add(k) : bagPick.delete(k); render(); });
      const add = box.querySelector("[data-add]");
      if (add) add.onclick = async () => {
        const list = selection(), m = box.querySelector("[data-msg]");
        add.disabled = true; add.textContent = "Adding…";
        try {
          // LiteAPI needs at least one service; removing everything means holding the fare again
          if (!list.length) { await onAttached(null); attached = null; render(); return; }
          const r = await PS.api("/api/flights/prebook/services", { method: "POST", body: { prebookId: pb.prebookId, selectedServices: list, voucherCode } });
          attached = { key: selKey(), total: extra() };
          await onAttached(r.data, list.map(s => ({ ...s, name: byId.get(s.serviceId)?.name, amount: +byId.get(s.serviceId)?.pricing?.display?.amount || 0 })));
          render();
        } catch (e) { render(); box.querySelector("[data-msg]").innerHTML = `<div class="alert error" style="margin-top:10px">${PS.icon("alert", 18)}<div>${PS.esc(e.message)}</div></div>`; }
      };
    }
    render();
  };

  window.FS = FS;
})();
