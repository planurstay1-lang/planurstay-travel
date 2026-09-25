/**
 * Travel guides — server-rendered destination pages (good for search engines).
 *
 *   GET /guides            → all guides
 *   GET /guides/:slug      → one guide (+ live hotel deals and weather loaded in the browser)
 *   GET /sitemap.xml, /robots.txt
 */

const img = (id, w = 1600) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;

const GUIDES = [
  {
    slug: "paris", city: "Paris", country: "France", placeId: "ChIJD7fiBh9u5kcRYJSMaMOCCwQ", airport: "CDG", airportName: "Charles de Gaulle",
    lat: 48.8566, lng: 2.3522, photo: "photo-1502602898657-3e91760cbb34",
    tagline: "Cafés, grand museums and evening walks along the Seine.",
    intro: "Paris rewards slow travel: long lunches, neighborhood markets and museums you could spend days in. The city is compact and easy to explore on foot and by Métro, so where you stay shapes your whole trip.",
    facts: { "Best time to visit": "April–June and September–October", "Currency": "Euro (EUR)", "Language": "French", "Main airports": "Charles de Gaulle (CDG), Orly (ORY)" },
    areas: [
      { name: "Le Marais", why: "Historic lanes, boutiques, galleries and great food. Central and lively day and night." },
      { name: "Saint-Germain-des-Prés", why: "Classic Left Bank cafés, bookshops and elegant streets. Ideal for a first visit." },
      { name: "Louvre & 1st arrondissement", why: "Walk to the Louvre, Tuileries and the Seine. Very central, with prices to match." },
      { name: "Latin Quarter", why: "Student energy, bistros and Notre-Dame nearby. Good value for such a central spot." },
      { name: "Montmartre", why: "Village feel on a hilltop, with Sacré-Cœur and artist history. Hilly and a bit further out." },
    ],
    airportInfo: "From Charles de Gaulle, the RER B train runs to central stations such as Gare du Nord and Châtelet in roughly 35–50 minutes. Taxis charge a fixed fare to the city. From Orly, take the Orlyval shuttle to the RER B, or the tram and bus links.",
    todo: ["The Louvre (book a timed entry)", "Eiffel Tower, at sunset if you can", "Musée d'Orsay for Impressionist art", "A boat cruise on the Seine", "Montmartre and Sacré-Cœur", "A day trip to the Palace of Versailles"],
    tips: ["Many museums are closed one day a week, often Monday or Tuesday, so check before you go.", "Buy a Navigo Easy card or use contactless payment for the Métro.", "Tipping is modest: service is included, and rounding up is enough."],
  },
  {
    slug: "london", city: "London", country: "United Kingdom", placeId: "ChIJdd4hrwug2EcRmSrV3Vo6llI", airport: "LHR", airportName: "Heathrow",
    lat: 51.5074, lng: -0.1278, photo: "photo-1505761671935-60b3a7427bad",
    tagline: "Royal history, free world-class museums and neighborhoods with real character.",
    intro: "London is huge, but its best-known sights cluster around the centre and the Thames. Many major museums are free, and the Underground makes it easy to hop between very different neighborhoods in one day.",
    facts: { "Best time to visit": "May–September", "Currency": "Pound sterling (GBP)", "Language": "English", "Main airports": "Heathrow (LHR), Gatwick (LGW), Stansted (STN)" },
    areas: [
      { name: "Covent Garden & the West End", why: "Theatres, restaurants and shopping on your doorstep. Walkable to most sights." },
      { name: "South Bank", why: "Riverside walks, the London Eye and Tate Modern. Great views across the Thames." },
      { name: "Kensington", why: "Elegant and calm, beside Hyde Park and the big museums. Good for families." },
      { name: "Westminster", why: "Next to Parliament, Big Ben and Westminster Abbey. Quieter in the evenings." },
      { name: "Shoreditch", why: "Street art, markets and nightlife in the East End. Trendy and often better value." },
    ],
    airportInfo: "From Heathrow, the Elizabeth line and the Piccadilly line run into central London, and the Heathrow Express reaches Paddington in about 15 minutes. Gatwick is linked by the Gatwick Express and Thameslink trains.",
    todo: ["The British Museum (free)", "Tower of London and the Crown Jewels", "Westminster Abbey and Big Ben", "Tate Modern and a South Bank walk", "Camden or Borough Market", "An evening West End show"],
    tips: ["Tap in and out with a contactless card on the Tube and buses; daily fares are capped.", "Stand on the right on escalators.", "Book popular attractions and shows ahead, especially in summer."],
  },
  {
    slug: "new-york", city: "New York", country: "USA", placeId: "ChIJOwg_06VPwokRYv534QaPC8g", airport: "JFK", airportName: "John F. Kennedy",
    lat: 40.7128, lng: -74.006, photo: "photo-1496442226666-8d4d0e62e6e9",
    tagline: "Skyline views, Broadway nights and food from every corner of the world.",
    intro: "New York moves fast and never really sleeps. Manhattan holds most famous sights, but Brooklyn and the other boroughs are where many locals eat and hang out. The subway runs 24 hours, so staying slightly outside Midtown can save money.",
    facts: { "Best time to visit": "April–June and September–November", "Currency": "US dollar (USD)", "Language": "English", "Main airports": "JFK, LaGuardia (LGA), Newark (EWR)" },
    areas: [
      { name: "Midtown", why: "Times Square, Broadway and the Empire State Building. Busy but very convenient." },
      { name: "Lower Manhattan", why: "Financial District, 9/11 Memorial and ferries to the Statue of Liberty." },
      { name: "SoHo & Greenwich Village", why: "Cast-iron streets, shopping, cafés and a neighborhood feel." },
      { name: "Upper West Side", why: "Leafy and residential, beside Central Park and the Natural History Museum." },
      { name: "Williamsburg, Brooklyn", why: "Bars, restaurants and skyline views, a short subway ride from Manhattan." },
    ],
    airportInfo: "From JFK, the AirTrain connects to the subway (A or E lines) or the Long Island Rail Road into Manhattan. LaGuardia is served by buses and taxis. From Newark, the AirTrain connects to NJ Transit trains to Penn Station.",
    todo: ["A walk or bike ride through Central Park", "The Metropolitan Museum of Art", "Statue of Liberty and Ellis Island", "Sunset from an observation deck", "Walk across the Brooklyn Bridge", "A Broadway show"],
    tips: ["Tap to pay with a contactless card on the subway (OMNY).", "Tipping 18–20% is expected in restaurants.", "Book observation decks and popular shows ahead."],
  },
  {
    slug: "tokyo", city: "Tokyo", country: "Japan", placeId: "ChIJ51cu8IcbXWARiRtXIothAS4", airport: "HND", airportName: "Haneda",
    lat: 35.6762, lng: 139.6503, photo: "photo-1540959733332-eab4deabeeaf",
    tagline: "Neon nights, peaceful shrines and some of the best food anywhere.",
    intro: "Tokyo is a collection of very different neighborhoods joined by one of the world's best train networks. It is safe, spotless and surprisingly easy for first-time visitors, even without Japanese.",
    facts: { "Best time to visit": "Late March–April and October–November", "Currency": "Japanese yen (JPY)", "Language": "Japanese", "Main airports": "Haneda (HND), Narita (NRT)" },
    areas: [
      { name: "Shinjuku", why: "Major transport hub with nightlife, shopping and huge hotel choice." },
      { name: "Shibuya", why: "The famous crossing, youthful energy and easy train links." },
      { name: "Ginza & Tokyo Station", why: "Upscale shopping, great dining and quick bullet-train access." },
      { name: "Asakusa", why: "Traditional atmosphere around Senso-ji temple, often better value." },
      { name: "Roppongi", why: "Art museums, international dining and nightlife." },
    ],
    airportInfo: "Haneda is close to the city, linked by the Keikyu line and the Tokyo Monorail. From Narita, the Narita Express and the Keisei Skyliner reach central Tokyo in about an hour.",
    todo: ["Senso-ji temple in Asakusa", "Shibuya Crossing and the view from above", "Meiji Shrine and Yoyogi Park", "Tsukiji Outer Market for breakfast", "An immersive digital art museum", "A day trip to Nikko or Kamakura"],
    tips: ["Get a Suica or Pasmo IC card (or add one to your phone) for trains and convenience stores.", "Carry some cash; smaller places may not take cards.", "Tipping is not customary."],
  },
  {
    slug: "dubai", city: "Dubai", country: "United Arab Emirates", placeId: "ChIJRcbZaklDXz4RYlEphFBu5r0", airport: "DXB", airportName: "Dubai International",
    lat: 25.2048, lng: 55.2708, photo: "photo-1512453979798-5ea266f8880c",
    tagline: "Record-breaking skyscrapers, desert adventures and year-round sunshine.",
    intro: "Dubai mixes futuristic architecture with the older souks and creek of its historic centre. Winters are warm and sunny, while summers are very hot, so most visitors plan around the cooler months.",
    facts: { "Best time to visit": "November–March", "Currency": "UAE dirham (AED)", "Language": "Arabic (English widely spoken)", "Main airport": "Dubai International (DXB)" },
    areas: [
      { name: "Downtown Dubai", why: "Burj Khalifa, Dubai Mall and the fountain show right outside." },
      { name: "Dubai Marina & JBR", why: "Waterfront walks, beach clubs and plenty of restaurants." },
      { name: "Palm Jumeirah", why: "Resort hotels with private beaches. Best for a relaxing stay." },
      { name: "Deira & Bur Dubai", why: "Old Dubai: souks, the creek and heritage areas. Often better value." },
      { name: "Business Bay", why: "Modern towers next to Downtown with good-value hotels." },
    ],
    airportInfo: "Dubai Metro's Red Line stops at Terminals 1 and 3 and runs to Downtown and the Marina. Taxis are metered and easy to find at arrivals.",
    todo: ["At the Top, Burj Khalifa", "The Dubai Fountain show", "A desert safari", "An abra ride across Dubai Creek", "Al Fahidi historical neighborhood", "Museum of the Future"],
    tips: ["Dress modestly in malls and traditional areas.", "Plan outdoor activities for mornings and evenings.", "The weekend is Saturday–Sunday."],
  },
  {
    slug: "rome", city: "Rome", country: "Italy", placeId: "ChIJu46S-ZZhLxMROG5lkwZ3D7k", airport: "FCO", airportName: "Fiumicino",
    lat: 41.9028, lng: 12.4964, photo: "photo-1552832230-c0197dd311b5",
    tagline: "Ancient ruins, Renaissance art and long dinners on cobblestone squares.",
    intro: "Rome is an open-air museum: you'll pass 2,000-year-old monuments on the way to dinner. The historic centre is walkable, so staying central lets you see the city at its best, early in the morning and late at night.",
    facts: { "Best time to visit": "April–June and September–October", "Currency": "Euro (EUR)", "Language": "Italian", "Main airports": "Fiumicino (FCO), Ciampino (CIA)" },
    areas: [
      { name: "Centro Storico", why: "Around the Pantheon and Piazza Navona. Walk everywhere." },
      { name: "Trastevere", why: "Charming lanes, trattorias and lively evenings across the river." },
      { name: "Monti", why: "Boutiques and wine bars a short walk from the Colosseum." },
      { name: "Prati (near the Vatican)", why: "Calm, elegant and handy for St. Peter's and the Vatican Museums." },
      { name: "Near Termini", why: "Budget-friendly, with the best train and airport connections." },
    ],
    airportInfo: "From Fiumicino, the Leonardo Express train runs non-stop to Roma Termini in about 32 minutes. Buses and taxis (fixed fares to the centre) are also available.",
    todo: ["Colosseum and Roman Forum (book ahead)", "Vatican Museums and the Sistine Chapel", "The Pantheon", "Trevi Fountain early in the morning", "Borghese Gallery (reservations required)", "An evening in Trastevere"],
    tips: ["Validate train and bus tickets, or tap a contactless card where accepted.", "Churches require covered shoulders and knees.", "Carry a refillable bottle; the public fountains have drinking water."],
  },
];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page({ title, description, canonical, image, body, script = "" }) {
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
  ${image ? `<meta property="og:image" content="${esc(image)}">` : ""}<meta property="og:type" content="article">
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/ps.css">
</head><body>
${body}
<script src="/js/ps.js"></script>
<script>PS.header({ active: "guides" }); PS.footer(); document.querySelectorAll("i[data-ico]").forEach(n => n.outerHTML = PS.icon(n.dataset.ico, +n.dataset.s || 18, 2.2));${script}</script>
</body></html>`;
}

function registerGuideRoutes(app, { APP_URL }) {
  const base = (APP_URL || "").replace(/\/$/, "");

  app.get("/guides", (req, res) => {
    const body = `<main class="container guides-index">
      <div class="page-head"><div class="eyebrow">Travel guides</div><h1>Plan a trip you'll love</h1><p>Where to stay, how to get in from the airport and what not to miss, plus live hotel deals.</p></div>
      <div class="guide-grid">${GUIDES.map(g => `
        <a class="guide-card" href="/guides/${g.slug}">
          <img src="${img(g.photo, 900)}" alt="${esc(g.city)}" loading="lazy">
          <div><b>${esc(g.city)}</b><small>${esc(g.country)}</small><p>${esc(g.tagline)}</p><span>Read the guide ${""}</span></div>
        </a>`).join("")}</div>
    </main>`;
    res.send(page({ title: "Travel guides — PlanurStay", description: "Destination guides for Paris, London, New York, Tokyo, Dubai and Rome: where to stay, airport transfers, best time to visit and top things to do.", canonical: `${base}/guides`, body }));
  });

  app.get("/guides/:slug", (req, res, next) => {
    const g = GUIDES.find(x => x.slug === req.params.slug);
    if (!g) return next();
    const others = GUIDES.filter(x => x.slug !== g.slug).slice(0, 3);
    const body = `<main class="container guide">
      <nav class="crumbs"><a href="/">Home</a> › <a href="/guides">Travel guides</a> › <span>${esc(g.city)}</span></nav>
      <header class="guide-hero"><img src="${img(g.photo, 2000)}" alt="${esc(g.city)}"><div class="guide-hero-txt"><small>${esc(g.country)}</small><h1>${esc(g.city)} travel guide</h1><p>${esc(g.tagline)}</p></div></header>

      <div class="guide-layout">
        <article>
          <p class="guide-intro">${esc(g.intro)}</p>

          <section class="guide-facts">${Object.entries(g.facts).map(([k, v]) => `<div><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join("")}</section>

          <section><h2>Where to stay in ${esc(g.city)}</h2>
            <div class="areas">${g.areas.map((a, i) => `<div class="area"><span class="area-n">${i + 1}</span><div><b>${esc(a.name)}</b><p>${esc(a.why)}</p></div></div>`).join("")}</div>
          </section>

          <section><h2>Live hotel deals</h2><p class="muted" id="dealsNote">Checking live prices…</p><div class="guide-deals" id="guideDeals"></div></section>

          <section><h2>Getting in from the airport</h2><p>${esc(g.airportInfo)}</p><p class="muted small">Schedules and fares change, so check the operator's website before you travel.</p></section>

          <section><h2>Top things to do</h2><ol class="todo">${g.todo.map(t => `<li>${esc(t)}</li>`).join("")}</ol></section>

          <section><h2>Local tips</h2><ul class="tips">${g.tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul></section>

          <section id="wxBox"></section>
        </article>

        <aside class="guide-side">
          <div class="panel">
            <h3>Plan your ${esc(g.city)} trip</h3>
            <a class="btn btn-primary btn-block" id="ctaHotels" href="/hotels">Search hotels in ${esc(g.city)}</a>
            <a class="btn btn-ghost btn-block" style="margin-top:10px" id="ctaFlights" href="/flights">Find flights to ${esc(g.city)}</a>
          </div>
          <div class="panel"><h3>More guides</h3>${others.map(o => `<a class="mini-guide" href="/guides/${o.slug}"><img src="${img(o.photo, 200)}" alt="" loading="lazy"><span><b>${esc(o.city)}</b><small>${esc(o.country)}</small></span></a>`).join("")}</div>
        </aside>
      </div>
    </main>`;
    const G = JSON.stringify({ city: g.city, country: g.country, placeId: g.placeId, airport: g.airport, lat: g.lat, lng: g.lng });
    const script = `
      (function () {
        const g = ${G};
        const ci = PS.addDays(PS.today(), 21), co = PS.addDays(ci, 3);
        const hotelsUrl = PS.url("/hotels", { placeId: g.placeId, dest: g.city, destDetail: g.country, checkin: PS.iso(ci), checkout: PS.iso(co), adults: 2, rooms: 1 });
        document.getElementById("ctaHotels").href = hotelsUrl;
        const lf = PS.local.get("ps_last_flights") || {};
        const from = lf.from && lf.from !== g.airport ? { code: lf.from, city: lf.fromCity, cc: lf.fromCountry } : { code: "YYZ", city: "Toronto", cc: "CA" };
        document.getElementById("ctaFlights").href = PS.url("/flights", { from: from.code, fromCity: from.city, fromCountry: from.cc, to: g.airport, toCity: g.city, depart: PS.iso(ci), return: PS.iso(PS.addDays(ci, 7)), adults: 1 });
        PS.api("/api/stays/search", { method: "POST", body: { currency: PS.cur(), placeId: g.placeId, checkin: PS.iso(ci), checkout: PS.iso(co), adults: 2, rooms: 1, limit: 60 } }).then(r => {
          const list = (r.data || []).filter(h => h.rating >= 8 && h.photo && !h.memberOnly).sort((a, b) => a.perNight - b.perNight).slice(0, 4);
          const note = document.getElementById("dealsNote");
          if (!list.length) { note.textContent = "Search hotels to see live prices."; return; }
          note.textContent = "Top-rated hotels for " + PS.fmtDate(ci) + " – " + PS.fmtDate(co) + " (3 nights, 2 guests).";
          document.getElementById("guideDeals").innerHTML = list.map(h => '<a class="gd" href="' + PS.url("/hotel/" + h.id, { checkin: PS.iso(ci), checkout: PS.iso(co), adults: 2, rooms: 1, dest: g.city, placeId: g.placeId }) + '"><img src="' + PS.esc(h.photo) + '" alt="" loading="lazy"><div><b>' + PS.esc(h.name) + '</b><small>' + Number(h.rating).toFixed(1) + ' ' + PS.ratingWord(h.rating) + '</small><span>From <b>' + PS.money(h.perNight, h.currency, 0) + '</b>/night</span></div></a>').join("");
        }).catch(() => { document.getElementById("dealsNote").textContent = "Search hotels to see live prices."; });
        PS.weather(document.getElementById("wxBox"), { lat: g.lat, lng: g.lng, start: PS.iso(PS.today()), end: PS.iso(PS.addDays(PS.today(), 6)), title: "Weather in " + g.city + " this week" });
      })();`;
    res.send(page({ title: `${g.city} travel guide: where to stay, what to do — PlanurStay`, description: `${g.tagline} Best areas to stay in ${g.city}, getting in from the airport, top things to do and live hotel deals.`, canonical: `${base}/guides/${g.slug}`, image: img(g.photo, 1200), body, script }));
  });

  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send(`User-agent: *\nDisallow: /api/\nDisallow: /checkout\nDisallow: /confirmation\nSitemap: ${base}/sitemap.xml\n`);
  });
  app.get("/sitemap.xml", (req, res) => {
    const urls = ["/", "/hotels", "/flights", "/guides", ...GUIDES.map(g => `/guides/${g.slug}`)];
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<url><loc>${base}${u}</loc></url>`).join("")}</urlset>`);
  });
}

module.exports = { registerGuideRoutes, GUIDES };
