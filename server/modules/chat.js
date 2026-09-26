/**
 * PlanurStay AI travel assistant (Claude + live search tools).
 *
 *   GET  /api/chat/status   → { enabled }   (the widget stays hidden when no API key is set)
 *   POST /api/chat          → { messages: [{role, content}], currency } → { reply, cards }
 *
 * Env: ANTHROPIC_API_KEY (required), CHAT_MODEL (default claude-haiku-4-5)
 *
 * The assistant never invents prices: hotel and flight prices come from our own search
 * endpoints (called with the visitor's cookie, so signed-in members see member prices).
 * It can't book, cancel or change anything; it links people to the right page instead.
 */
const MAX_TURNS = 16, MAX_CHARS = 1200, MAX_TOOL_ROUNDS = 4;

const TOOLS = [
  {
    name: "search_hotels",
    description: "Search live hotel prices for a destination and dates. Use for any question about hotels, stays, prices or availability. Returns the best-rated available hotels with total price for the stay.",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "City, area or landmark, e.g. 'Paris' or 'Times Square, New York'" },
        checkin: { type: "string", description: "YYYY-MM-DD" },
        checkout: { type: "string", description: "YYYY-MM-DD" },
        adults: { type: "integer", minimum: 1, maximum: 8 },
        rooms: { type: "integer", minimum: 1, maximum: 5 },
        max_price_per_night: { type: "number", description: "Optional budget per night in the user's currency" },
        min_stars: { type: "integer", minimum: 1, maximum: 5 },
        sort: { type: "string", enum: ["recommended", "cheapest", "top_rated"] },
      },
      required: ["destination", "checkin", "checkout"],
    },
  },
  {
    name: "list_my_bookings",
    description: "List the signed-in customer's hotel and flight bookings. Returns an error if they aren't signed in.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "booking_status",
    description: "Look up one booking's live status, dates, total paid and cancellation terms (free-cancellation deadline, fee if cancelled now). For hotels: needs the booking ID and the email used at checkout, unless the customer is signed in and owns it. For flights: also returns the airline's live refund quote (signed-in owner only).",
    input_schema: { type: "object", properties: { booking_id: { type: "string" }, email: { type: "string" } }, required: ["booking_id"] },
  },
  {
    name: "prepare_cancellation",
    description: "Use ONLY after the customer clearly asks to cancel a specific booking. Checks the terms and shows the customer a confirmation card with the refund and fee. It does NOT cancel: the customer must confirm in the card (and enter an emailed code if not signed in). Flights: signed-in owners get a card with the airline's refund quote; if the quote can't be confirmed it must go to a support ticket.",
    input_schema: { type: "object", properties: { booking_id: { type: "string" }, email: { type: "string" } }, required: ["booking_id"] },
  },
  {
    name: "create_support_ticket",
    description: "Hand a request to the PlanurStay support team (who can contact the hotel, airline or our supplier Nuitee). Use for changes, name corrections, special requests, flight cancellations, problems at the hotel, refunds not received, or anything you can't resolve. Confirm the summary with the customer first.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["change", "cancellation", "refund", "problem-at-hotel", "flight", "payment", "special-request", "other"] },
        summary: { type: "string", description: "Clear summary for the support agent: what the customer needs, key details and what was already tried." },
        booking_id: { type: "string" },
        email: { type: "string", description: "Customer's email for the reply" },
      },
      required: ["category", "summary"],
    },
  },
  {
    name: "search_flights",
    description: "Search live flight prices. Use airport or city names; they are resolved to airports. Omit return_date for one way.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "City or IATA code, e.g. 'Toronto' or 'YYZ'" },
        destination: { type: "string" },
        depart_date: { type: "string", description: "YYYY-MM-DD" },
        return_date: { type: "string", description: "YYYY-MM-DD, omit for one way" },
        adults: { type: "integer", minimum: 1, maximum: 9 },
        nonstop_only: { type: "boolean" },
      },
      required: ["origin", "destination", "depart_date"],
    },
  },
];

function systemPrompt(currency) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the PlanurStay travel assistant on planurstay.com, an online travel agency for hotels and flights.
Today is ${today}. Prices are in ${currency}.

How to help:
- Be warm, brief and practical. Use short paragraphs or a few bullets. No long essays.
- For any price, availability or "find me" request, call search_hotels or search_flights. Never guess or invent prices, hotel names or flight times.
- If dates or the destination are missing, ask one short question. If the user says something like "next weekend", work out the dates from today and say which dates you used.
- Results appear as clickable cards under your message, so don't repeat every detail. Summarise the best 2-3 options and why (price, rating, location, stops).
- Guests see public prices. Signed-in members see lower member prices; you may mention that signing in (free) unlocks member prices.
- You are also PlanurStay customer support. You can look up bookings, check live status and cancellation terms, prepare a hotel cancellation for the customer to confirm, and open support tickets.
- To look up a booking you need the booking ID and the email used at checkout, unless the customer is signed in (then use list_my_bookings). Never reveal booking details unless the tool returns them. Never guess a booking ID.
- Cancelling: only call prepare_cancellation when the customer clearly asks to cancel a specific booking. First tell them the fee and refund. The card lets them confirm; you never cancel yourself and never say it's cancelled until they confirm in the card.
- Flights: the refund may go back to the card or come as an airline voucher; say which. Airlines can take time to confirm a cancellation.
- Changes (dates, names, room type), refunds not received, problems at the hotel, or anything else you can't do: collect the details and open a ticket with create_support_ticket, then give the customer the reference. Our team contacts the hotel, airline or our supplier Nuitee when needed.
- Cancellation deadlines from the tools are in GMT; say so.
- If the customer is at the hotel or airport with an urgent problem, tell them to speak to the front desk or airline too, and open a ticket.

Policies you can explain (details: /cancellation-policy, /terms):
- Free-cancellation rates can be cancelled for a full refund until the deadline shown on the booking; non-refundable rates can't be refunded.
- Some hotels charge local fees at check-in (resort fee, city tax). We show them at checkout as "Pay at hotel".
- Refunds go back to the original card, usually within 5-10 business days.
- PlanurStay Rewards: members earn points on bookings (100 points = $1), released after the stay, redeemable as vouchers at checkout.
- Flight changes and baggage follow the airline's fare rules. Travellers are responsible for passports and visas.

Stay on travel and booking topics. Politely decline unrelated requests. Never ask for card numbers, passwords, passport numbers or verification codes in chat (codes go in the confirmation card only).`;
}

function createChat({ port, support }) {
  const key = () => (process.env.ANTHROPIC_API_KEY || "").trim();
  const model = () => process.env.CHAT_MODEL || "claude-haiku-4-5";
  const base = `http://127.0.0.1:${port}`;

  // Per-IP limit: 40 messages per hour keeps costs predictable.
  const hits = new Map();
  setInterval(() => hits.clear(), 3600 * 1000).unref();

  async function internal(path, { method = "GET", body, cookie } = {}) {
    const r = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
    });
    return r.json().catch(() => ({}));
  }
  const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : null);
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "")).toString();

  async function searchHotels(a, ctx) {
    const checkin = iso(a.checkin), checkout = iso(a.checkout);
    if (!checkin || !checkout || checkout <= checkin) return { error: "Need valid check-in and check-out dates (YYYY-MM-DD, check-out after check-in)." };
    const places = await internal(`/api/places?q=${encodeURIComponent(a.destination)}`);
    const place = (places.data || [])[0];
    if (!place) return { error: `Couldn't find a place called "${a.destination}".` };
    const adults = Math.min(Math.max(+a.adults || 2, 1), 8), rooms = Math.min(Math.max(+a.rooms || 1, 1), 5);
    const r = await internal("/api/stays/search", { method: "POST", cookie: ctx.cookie, body: { placeId: place.placeId, checkin, checkout, adults, rooms, currency: ctx.currency, limit: 120 } });
    if (!r.success) return { error: r.error || "Hotel search failed" };
    let list = (r.data || []).filter(h => !h.memberOnly);
    if (a.min_stars) list = list.filter(h => (h.stars || 0) >= a.min_stars);
    if (a.max_price_per_night) list = list.filter(h => h.perNight <= a.max_price_per_night);
    const score = (h) => (h.rating || 0) * Math.log10(10 + (h.reviews || 0));
    list.sort(a.sort === "cheapest" ? (x, y) => x.total - y.total : a.sort === "top_rated" ? (x, y) => (y.rating || 0) - (x.rating || 0) : (x, y) => score(y) - score(x));
    const top = list.slice(0, 6);
    const dest = `${place.name}${place.detail ? ", " + place.detail : ""}`;
    ctx.cards.push(...top.map(h => ({
      kind: "hotel", name: h.name, photo: h.thumb || h.photo, stars: h.stars, rating: h.rating, reviews: h.reviews,
      area: h.city, total: h.total, perNight: h.perNight, currency: h.currency, nights: h.nights, refundable: h.refundable, board: h.board,
      member: !!h.memberPrice,
      url: `/hotel/${h.id}?${qs({ checkin, checkout, adults, rooms, dest, placeId: place.placeId })}`,
    })));
    ctx.links.push({ label: `See all hotels in ${place.name}`, url: `/hotels?${qs({ placeId: place.placeId, dest, checkin, checkout, adults, rooms })}` });
    return {
      destination: dest, checkin, checkout, adults, rooms, found: list.length,
      pricesAre: r.pricing?.member ? "member prices" : "public prices",
      hotels: top.map(h => ({ name: h.name, stars: h.stars, rating: h.rating, reviews: h.reviews, area: h.city, total: Math.round(h.total), perNight: Math.round(h.perNight), currency: h.currency, freeCancellation: h.refundable, board: h.board, payAtHotelFees: h.taxesExcluded ? Math.round(h.taxesExcluded) : 0 })),
    };
  }

  async function airport(q) {
    if (/^[A-Z]{3}$/i.test(q.trim())) {
      const r = await internal(`/api/airports?q=${encodeURIComponent(q.trim())}`);
      return (r.data || []).find(a => a.code === q.trim().toUpperCase()) || { code: q.trim().toUpperCase(), city: q.trim().toUpperCase() };
    }
    const r = await internal(`/api/airports?q=${encodeURIComponent(q)}`);
    const list = r.data || [];
    // Prefer the main international airport for a city name (Toronto → YYZ, not YTZ)
    return list.find(x => /international|intercontinental/i.test(x.name || "")) || list[0] || null;
  }

  async function searchFlights(a, ctx) {
    const depart = iso(a.depart_date), ret = iso(a.return_date);
    if (!depart) return { error: "Need a departure date (YYYY-MM-DD)." };
    if (ret && ret < depart) return { error: "Return date is before the departure date." };
    const [from, to] = await Promise.all([airport(a.origin), airport(a.destination)]);
    if (!from || !to) return { error: `Couldn't find an airport for "${!from ? a.origin : a.destination}".` };
    const adults = Math.min(Math.max(+a.adults || 1, 1), 9);
    const legs = [{ origin: from.code, destination: to.code, date: depart }, ...(ret ? [{ origin: to.code, destination: from.code, date: ret }] : [])];
    const r = await internal("/api/flights/offers", { method: "POST", cookie: ctx.cookie, body: { legs, adults, currency: ctx.currency } });
    if (!r.success) return { error: r.error || "Flight search failed" };
    let js = (r.data?.journeys || []).map(j => {
      const o = j.cheapestOffer || (j.offers || [])[0] || {};
      const out = j.segments.filter(s => s.direction === "OUTBOUND"), inb = j.segments.filter(s => s.direction === "INBOUND");
      return {
        price: o.pricing?.display?.total, currency: o.pricing?.display?.currency,
        airlines: [...new Set(j.segments.map(s => s.carrier?.marketingName).filter(Boolean))],
        logo: j.segments[0]?.carrier?.marketingLogo,
        outbound: out.length ? { depart: out[0].departureTime, arrive: out[out.length - 1].arrivalTime, stops: out.length - 1, via: out.slice(0, -1).map(s => s.destinationCode) } : null,
        inbound: inb.length ? { depart: inb[0].departureTime, arrive: inb[inb.length - 1].arrivalTime, stops: inb.length - 1, via: inb.slice(0, -1).map(s => s.destinationCode) } : null,
        durationMin: j.totalDuration?.minutes,
      };
    }).filter(j => j.price != null);
    if (a.nonstop_only) js = js.filter(j => j.outbound?.stops === 0 && (!j.inbound || j.inbound.stops === 0));
    js.sort((x, y) => x.price - y.price);
    const cheapest = js.slice(0, 3);
    const fastest = [...js].sort((x, y) => (x.durationMin || 1e9) - (y.durationMin || 1e9))[0];
    const pick = [...cheapest, ...(fastest && !cheapest.includes(fastest) ? [fastest] : [])];
    const search = { from: from.code, fromCity: from.city, fromCountry: from.countryCode, to: to.code, toCity: to.city, depart, return: ret, adults };
    ctx.cards.push(...pick.map(j => ({ kind: "flight", ...j, from: from.code, to: to.code, url: `/flights?${qs(search)}` })));
    ctx.links.push({ label: `See all flights ${from.code} → ${to.code}`, url: `/flights?${qs(search)}` });
    return { from: `${from.city} (${from.code})`, to: `${to.city} (${to.code})`, depart, return: ret || "one way", adults, found: js.length, pricesArePer: adults > 1 ? `all ${adults} travellers` : "1 traveller", options: pick.map(j => ({ price: Math.round(j.price), currency: j.currency, airlines: j.airlines, outbound: j.outbound, inbound: j.inbound, totalHours: j.durationMin ? +(j.durationMin / 60).toFixed(1) : null })) };
  }

  async function claude(messages, currency) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // Prompt caching: the tools, instructions and earlier turns are resent on every tool round and every
      // message; cached reads cost ~10% of normal input.
      body: JSON.stringify({ model: model(), max_tokens: 900, cache_control: { type: "ephemeral" }, system: systemPrompt(currency), tools: TOOLS, messages }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `Assistant error ${r.status}`);
    return j;
  }

  function register(app) {
    // Nuitee's whitelabel chatbot powers "Ask AI" in the homepage search (public key only);
    // our own assistant (Claude) is the support bubble. NUITEE_CHATBOT=off / CHATBOT=off hide them.
    app.get("/api/chat/status", (req, res) => {
      const pub = (process.env.NUITEE_CHATBOT_KEY || "prod_public_fa93b970-5991-4c77-a7a1-b8640d0ca04d").trim();
      const nuitee = (process.env.NUITEE_CHATBOT || "on").toLowerCase() !== "off" && /^(prod|sand)_public_[0-9a-f-]+$/i.test(pub)
        ? { src: `https://components.liteapi.travel/chatbot/v1.js?liteApiKey=${encodeURIComponent(pub)}` } : null;
      const off = (process.env.CHATBOT || "").toLowerCase() === "off";
      res.json({ nuitee, assistant: !off && !!key(), help: !off });
    });

    app.post("/api/chat", async (req, res) => {
      if (!key()) return res.status(503).json({ error: "The assistant isn't available right now." });
      const ip = req.ip || "";
      const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
      if (n > 40) return res.status(429).json({ error: "You've sent a lot of messages. Please try again in a little while, or use the search above." });

      const currency = /^[A-Z]{3}$/.test(req.body?.currency || "") ? req.body.currency : "USD";
      // Only plain text turns from the client; tool calls happen server-side each request.
      const history = (Array.isArray(req.body?.messages) ? req.body.messages : [])
        .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .slice(-MAX_TURNS)
        .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
      while (history.length && history[0].role !== "user") history.shift();
      if (!history.length || history[history.length - 1].role !== "user") return res.status(400).json({ error: "Say something to get started." });

      const ctx = { req, cookie: req.headers.cookie || "", currency, cards: [], links: [], actions: [] };
      try {
        let msgs = history, reply = "";
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const out = await claude(msgs, currency);
          const text = (out.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
          const calls = (out.content || []).filter(b => b.type === "tool_use");
          if (out.stop_reason !== "tool_use" || !calls.length || round === MAX_TOOL_ROUNDS) { reply = text; break; }
          ctx.cards = []; ctx.links = [];
          const results = await Promise.all(calls.map(async (c) => {
            let result;
            try {
              const i = c.input || {};
              if (c.name === "search_hotels") result = await searchHotels(i, ctx);
              else if (c.name === "search_flights") result = await searchFlights(i, ctx);
              else if (c.name === "list_my_bookings") result = support.listMine(req) || { error: "The customer isn't signed in. Ask for the booking ID and the email used at checkout, or suggest signing in." };
              else if (c.name === "booking_status") result = await support.status(req, i.booking_id, i.email);
              else if (c.name === "prepare_cancellation") {
                result = await support.prepareCancellation(req, i.booking_id, i.email);
                if (result.action) { ctx.actions = [result.action]; result = { ...result, action: undefined, confirmationCardShown: true }; }
              }
              else if (c.name === "create_support_ticket") result = support.createTicket(req, { bookingId: i.booking_id, email: i.email, category: i.category, summary: i.summary });
              else result = { error: "Unknown tool" };
            } catch (e) { result = { error: "Search is taking too long. Try again in a moment." }; }
            return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(result).slice(0, 12000) };
          }));
          msgs = [...msgs, { role: "assistant", content: out.content }, { role: "user", content: results }];
        }
        res.json({ success: true, reply: reply || "Sorry, I couldn't find an answer to that. Try rephrasing, or use the search above.", cards: ctx.cards.slice(0, 8), links: ctx.links.slice(0, 2), actions: ctx.actions });
      } catch (err) {
        console.error("Chat error:", err.message);
        res.status(502).json({ error: "The assistant is busy right now. Please try again in a moment." });
      }
    });
  }
  return { register };
}

module.exports = { createChat };
