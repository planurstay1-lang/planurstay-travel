/**
 * Search landing pages (server-rendered, in the sitemap) for the routes and cities our travelers
 * actually search: Canada ⇄ India ⇄ the Gulf, plus hotels near the big airports.
 *
 *   GET /flights-to/:slug   e.g. /flights-to/toronto-to-dubai
 *   GET /hotels-in/:slug    e.g. /hotels-in/mumbai, /hotels-in/mumbai-airport
 *   GET /travel             index of all of them
 *
 * Copy is deliberately general (no schedules or prices that go stale); live prices load in the
 * browser from our own APIs. Each page carries FAQPage structured data.
 */
const { page, esc } = require("./guides");
const pct = () => require("./pricing").memberSavePct();

const CITY = {
  YYZ: { city: "Toronto", country: "Canada", cc: "CA" }, YVR: { city: "Vancouver", country: "Canada", cc: "CA" },
  YUL: { city: "Montreal", country: "Canada", cc: "CA" }, YYC: { city: "Calgary", country: "Canada", cc: "CA" },
  DXB: { city: "Dubai", country: "United Arab Emirates", cc: "AE" }, AUH: { city: "Abu Dhabi", country: "United Arab Emirates", cc: "AE" },
  DOH: { city: "Doha", country: "Qatar", cc: "QA" },
  DEL: { city: "Delhi", country: "India", cc: "IN" }, BOM: { city: "Mumbai", country: "India", cc: "IN" },
  AMD: { city: "Ahmedabad", country: "India", cc: "IN" }, ATQ: { city: "Amritsar", country: "India", cc: "IN" },
  BLR: { city: "Bangalore", country: "India", cc: "IN" }, HYD: { city: "Hyderabad", country: "India", cc: "IN" },
  COK: { city: "Kochi", country: "India", cc: "IN" }, MAA: { city: "Chennai", country: "India", cc: "IN" },
  LHR: { city: "London", country: "United Kingdom", cc: "GB" },
};
const ROUTES = [
  ["YYZ", "DEL"], ["YYZ", "BOM"], ["YYZ", "DXB"], ["YYZ", "AMD"], ["YYZ", "ATQ"], ["YYZ", "BLR"], ["YYZ", "HYD"], ["YYZ", "LHR"],
  ["YVR", "DEL"], ["YVR", "DXB"], ["YUL", "DEL"], ["YYC", "DEL"],
  ["DXB", "BOM"], ["DXB", "DEL"], ["DXB", "COK"], ["DXB", "YYZ"], ["DEL", "YYZ"], ["BOM", "YYZ"], ["DOH", "BOM"], ["AUH", "DEL"],
].map(([from, to]) => ({ from, to, slug: `${slugify(CITY[from].city)}-to-${slugify(CITY[to].city)}` }));

const STAYS = [
  { slug: "mumbai", name: "Mumbai", q: "Mumbai, India", country: "India" },
  { slug: "delhi", name: "Delhi", q: "New Delhi, India", country: "India" },
  { slug: "dubai", name: "Dubai", q: "Dubai, United Arab Emirates", country: "United Arab Emirates" },
  { slug: "toronto", name: "Toronto", q: "Toronto, Canada", country: "Canada" },
  { slug: "vancouver", name: "Vancouver", q: "Vancouver, Canada", country: "Canada" },
  { slug: "goa", name: "Goa", q: "Goa, India", country: "India" },
  { slug: "bangalore", name: "Bangalore", q: "Bengaluru, India", country: "India" },
  { slug: "doha", name: "Doha", q: "Doha, Qatar", country: "Qatar" },
  { slug: "mumbai-airport", name: "Mumbai Airport (BOM)", q: "Chhatrapati Shivaji Maharaj International Airport", country: "India", airport: true },
  { slug: "delhi-airport", name: "Delhi Airport (DEL)", q: "Indira Gandhi International Airport", country: "India", airport: true },
  { slug: "toronto-pearson-airport", name: "Toronto Pearson Airport (YYZ)", q: "Toronto Pearson International Airport", country: "Canada", airport: true },
  { slug: "dubai-airport", name: "Dubai Airport (DXB)", q: "Dubai International Airport", country: "United Arab Emirates", airport: true },
];

function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
const faqLd = (list) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: list.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) }).replace(/</g, "\\u003c")}</script>`;
const faqHTML = (list) => `<section class="faq"><h2>Frequently asked questions</h2>${list.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</section>`;

function routeFaq(A, B, intl) {
  return [
    [`How do I find cheap flights from ${A.city} to ${B.city}?`, `Search a few dates either side of when you want to travel: mid-week departures are often cheaper. Compare nonstop and one-stop options, and check what each fare includes, because a low fare without a checked bag can end up costing more.`],
    [`Are there nonstop flights from ${A.city} to ${B.city}?`, `It depends on the season and the airline. Tick "Non-stop only" in the search to see only direct flights for your dates.`],
    [`What should I check before booking?`, `Enter names exactly as on the passport, check the baggage allowance on the fare you pick, and look at connection times on one-stop trips.${intl ? " For international trips, check the visa and entry rules for your passport, and your passport's expiry date." : ""}`],
    [`Can I make my ticket refundable?`, `Many routes offer flexible fares. At checkout we show the cheapest refundable fare on the same flights, so you can switch for the price difference.`],
  ];
}

function registerSeoPages(app, { APP_URL }) {
  const hostBase = (req) => process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, "") : (APP_URL && !/localhost/.test(APP_URL) ? APP_URL.replace(/\/$/, "") : `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`);

  app.get("/flights-to/:slug", (req, res, next) => {
    const r = ROUTES.find(x => x.slug === req.params.slug);
    if (!r) return next();
    const A = CITY[r.from], B = CITY[r.to], intl = A.cc !== B.cc;
    const faq = routeFaq(A, B, intl);
    const related = ROUTES.filter(x => x !== r && (x.from === r.from || x.to === r.to)).slice(0, 6);
    const stay = STAYS.find(s => !s.airport && s.name === B.city);
    const body = `<main class="container guide seo-page">
      <nav class="crumbs"><a href="/">Home</a> › <a href="/travel">Routes</a> › <span>${esc(A.city)} to ${esc(B.city)}</span></nav>
      <header class="seo-hero"><small>${esc(A.country)} → ${esc(B.country)}</small><h1>Flights from ${esc(A.city)} to ${esc(B.city)}</h1>
        <p>Compare fares from ${esc(A.city)} (${r.from}) to ${esc(B.city)} (${r.to}) across airlines, with baggage and flexibility shown up front.</p>
        <div class="seo-cta"><a class="btn btn-primary" id="ctaSearch" href="/flights">Search ${esc(r.from)} → ${esc(r.to)} flights</a>${stay ? `<a class="btn btn-ghost" href="/hotels-in/${stay.slug}">Hotels in ${esc(B.city)}</a>` : ""}</div></header>
      <div class="guide-layout"><article>
        <section><h2>Good to know</h2><ul class="tips">
          <li>Fares change daily. Searching dates a few days apart often finds a lower price.</li>
          <li>Every fare shows what's included: carry-on, checked bags, changes and refunds.</li>
          <li>Book this flight on PlanurStay and hotels near ${esc(r.to)} unlock package prices for your dates.</li>
          ${intl ? `<li>Check the entry rules for ${esc(B.country)} for your passport before you book.</li>` : ""}
        </ul></section>
        ${faqHTML(faq)}
      </article>
      <aside class="guide-side">
        <div class="panel"><h3>More routes</h3>${related.map(x => `<a class="mini-link" href="/flights-to/${x.slug}">${esc(CITY[x.from].city)} → ${esc(CITY[x.to].city)}</a>`).join("")}</div>
      </aside></div>
    </main>${faqLd(faq)}`;
    const R = JSON.stringify({ from: r.from, to: r.to, fromCity: A.city, toCity: B.city, fromCountry: A.cc, toCountry: B.cc });
    const script = `(function(){ const r = ${R}; const d = PS.addDays(PS.today(), 30);
      document.getElementById("ctaSearch").href = PS.url("/flights", { ...r, depart: PS.iso(d), return: PS.iso(PS.addDays(d, 14)), adults: 1 }); })();`;
    res.send(page({ title: `Flights from ${A.city} to ${B.city} (${r.from}–${r.to}) — PlanurStay`, description: `Compare flights from ${A.city} to ${B.city}: fares, baggage and flexible options on one page. Book the flight and unlock package prices on hotels in ${B.city}.`, canonical: `${hostBase(req)}/flights-to/${r.slug}`, body, script, active: "flights" }));
  });

  app.get("/hotels-in/:slug", (req, res, next) => {
    const s = STAYS.find(x => x.slug === req.params.slug);
    if (!s) return next();
    const faq = [
      [`How do I get the best hotel price in ${s.name}?`, `Sign in or join free: members see prices about ${pct()}% below our guest prices. Booking a flight with us also unlocks package prices on hotels at your destination.`],
      [`Can I book with free cancellation?`, `Many hotels offer a free-cancellation rate. Each room shows the cancellation deadline before you book, and you can filter for it.`],
      [`Are taxes included in the price?`, `The price you pay today includes the taxes and fees we charge. Some hotels add local taxes paid at the property; we show those before you book.`],
      ...(s.airport ? [[`Do hotels near the airport offer shuttles?`, `Some do. Look for "Airport shuttle" in a hotel's facilities, and check with the hotel for times and charges.`]] : []),
    ];
    const others = STAYS.filter(x => x !== s).slice(0, 8);
    const body = `<main class="container guide seo-page">
      <nav class="crumbs"><a href="/">Home</a> › <a href="/travel">Hotels</a> › <span>${esc(s.name)}</span></nav>
      <header class="seo-hero"><small>${esc(s.country)}</small><h1>${s.airport ? `Hotels near ${esc(s.name)}` : `Hotels in ${esc(s.name)}`}</h1>
        <p>${s.airport ? "Stay close for early departures and late arrivals. " : ""}Live prices, guest ratings and free-cancellation options, with lower prices for members.</p>
        <div class="seo-cta"><a class="btn btn-primary" id="ctaSearch" href="/">Search hotels</a></div></header>
      <div class="guide-layout"><article>
        <section><h2>Top-rated hotels right now</h2><p class="muted" id="dealsNote">Checking live prices…</p><div class="guide-deals" id="guideDeals"></div></section>
        ${faqHTML(faq)}
      </article>
      <aside class="guide-side"><div class="panel"><h3>More places</h3>${others.map(o => `<a class="mini-link" href="/hotels-in/${o.slug}">${esc(o.airport ? "Near " + o.name : o.name)}</a>`).join("")}</div></aside></div>
    </main>${faqLd(faq)}`;
    const S = JSON.stringify({ q: s.q, name: s.name });
    const script = `(async function(){ const s = ${S}; const ci = PS.addDays(PS.today(), 21), co = PS.addDays(ci, 3);
      const note = document.getElementById("dealsNote");
      let p = null; try { p = ((await PS.api("/api/places?q=" + encodeURIComponent(s.q))).data || [])[0]; } catch {}
      if (!p) { note.textContent = "Search hotels to see live prices."; return; }
      const q = { placeId: p.placeId, dest: p.name, destDetail: p.detail, checkin: PS.iso(ci), checkout: PS.iso(co), adults: 2, rooms: 1 };
      document.getElementById("ctaSearch").href = PS.url("/hotels", q);
      try {
        const r = await PS.api("/api/stays/search", { method: "POST", body: { currency: PS.cur(), placeId: p.placeId, checkin: q.checkin, checkout: q.checkout, adults: 2, rooms: 1, limit: 60 } });
        const list = (r.data || []).filter(h => h.rating >= 8 && h.photo && !h.memberOnly).sort((a, b) => b.rating - a.rating || a.perNight - b.perNight).slice(0, 6);
        if (!list.length) { note.textContent = "Search hotels to see live prices."; return; }
        note.textContent = "Top-rated hotels for " + PS.fmtDate(ci) + " – " + PS.fmtDate(co) + " (3 nights, 2 guests).";
        document.getElementById("guideDeals").innerHTML = list.map(h => '<a class="gd" href="' + PS.url("/hotel/" + h.id, { checkin: q.checkin, checkout: q.checkout, adults: 2, rooms: 1, dest: q.dest, placeId: q.placeId }) + '"><img src="' + PS.esc(h.photo) + '" alt="" loading="lazy"><div><b>' + PS.esc(h.name) + '</b><small>' + Number(h.rating).toFixed(1) + ' ' + PS.ratingWord(h.rating) + '</small><span>From <b>' + PS.money(h.perNight, h.currency, 0) + '</b>/night</span></div></a>').join("");
      } catch { note.textContent = "Search hotels to see live prices."; }
    })();`;
    res.send(page({ title: `${s.airport ? `Hotels near ${s.name}` : `Hotels in ${s.name}`}: live prices & member deals — PlanurStay`, description: `Compare ${s.airport ? `hotels near ${s.name}` : `hotels in ${s.name}`} with live prices, guest ratings and free cancellation. Members save about ${pct()}%.`, canonical: `${hostBase(req)}/hotels-in/${s.slug}`, body, script, active: "stays" }));
  });

  app.get("/travel", (req, res) => {
    const body = `<main class="container guide seo-page">
      <header class="seo-hero"><h1>Popular routes and destinations</h1><p>Flights between Canada, India and the Gulf, and hotels where our travelers stay.</p></header>
      <section><h2>Flights</h2><div class="seo-grid">${ROUTES.map(x => `<a class="mini-link" href="/flights-to/${x.slug}">${esc(CITY[x.from].city)} → ${esc(CITY[x.to].city)}</a>`).join("")}</div></section>
      <section><h2>Hotels</h2><div class="seo-grid">${STAYS.map(x => `<a class="mini-link" href="/hotels-in/${x.slug}">${esc(x.airport ? "Near " + x.name : x.name)}</a>`).join("")}</div></section>
    </main>`;
    res.send(page({ title: "Popular routes and destinations — PlanurStay", description: "Flights between Canada, India and the Gulf, and hotels in Mumbai, Delhi, Dubai, Toronto and near their airports.", canonical: `${hostBase(req)}/travel`, body, active: "" }));
  });
}

const SEO_URLS = ["/travel", ...ROUTES.map(r => `/flights-to/${r.slug}`), ...STAYS.map(s => `/hotels-in/${s.slug}`)];
module.exports = { registerSeoPages, SEO_URLS };
