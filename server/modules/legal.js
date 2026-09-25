/**
 * Legal and support pages: /terms, /privacy, /cancellation-policy, /contact
 *
 * Business details come from env so they can be filled in without a code change:
 *   LEGAL_NAME      registered business name (default "PlanurStay")
 *   LEGAL_ADDRESS   postal address shown on the pages (optional)
 *   SUPPORT_EMAIL   default info@planurstay.com
 *   SUPPORT_PHONE   optional
 *   LEGAL_COUNTRY   governing law, e.g. "Ontario, Canada" (optional)
 */
const { page, esc } = require("./guides");

const UPDATED = "September 25, 2026";

function biz() {
  return {
    name: process.env.LEGAL_NAME || "PlanurStay",
    address: process.env.LEGAL_ADDRESS || "",
    email: process.env.SUPPORT_EMAIL || "info@planurstay.com",
    phone: process.env.SUPPORT_PHONE || "",
    law: process.env.LEGAL_COUNTRY || "",
  };
}

const NAV = [
  ["/terms", "Terms of service"],
  ["/privacy", "Privacy policy"],
  ["/cancellation-policy", "Cancellations & refunds"],
  ["/contact", "Contact us"],
];

function shell(path, title, intro, sections) {
  const b = biz();
  const toc = sections.map((s, i) => `<a href="#s${i + 1}">${esc(s[0])}</a>`).join("");
  return `<main class="container legal">
    <nav class="crumbs"><a href="/">Home</a> › <span>${esc(title)}</span></nav>
    <div class="legal-wrap">
      <aside class="legal-nav">${NAV.map(([h, t]) => `<a href="${h}"${h === path ? ' class="on"' : ""}>${t}</a>`).join("")}</aside>
      <article class="legal-body">
        <h1>${esc(title)}</h1>
        <p class="legal-upd">Last updated ${UPDATED}</p>
        <p class="legal-intro">${intro}</p>
        ${sections.length > 3 ? `<nav class="legal-toc">${toc}</nav>` : ""}
        ${sections.map((s, i) => `<section id="s${i + 1}"><h2>${esc(s[0])}</h2>${s[1]}</section>`).join("")}
        <div class="legal-contact"><b>Questions?</b> Email <a href="mailto:${esc(b.email)}">${esc(b.email)}</a>${b.phone ? ` or call ${esc(b.phone)}` : ""}.${b.address ? `<br>${esc(b.name)}, ${esc(b.address)}` : ""}</div>
      </article>
    </div>
  </main>`;
}

function terms() {
  const b = biz(), n = esc(b.name);
  return shell("/terms", "Terms of service",
    `These terms apply when you use the ${n} website and when you book a hotel or flight through us. By searching or booking, you agree to them. Please read them together with our <a href="/privacy">privacy policy</a> and <a href="/cancellation-policy">cancellation and refund policy</a>.`,
    [
      ["Who we are", `<p>${n} is an online travel agency. We are not a hotel or an airline. We work with licensed travel suppliers, including our booking partner Nuitee (LiteAPI), who give us access to rates from hotels, wholesalers and airlines. When you book, your contract for the stay or flight is with the hotel or airline (the "supplier"). We arrange the booking and take your payment on the supplier's behalf.</p>`],
      ["Using the website", `<ul><li>You must be at least 18 to book, and you must have authority to book for everyone named in the booking.</li><li>Use the site for genuine bookings only. Automated scraping, reselling our rates or making speculative bookings is not allowed.</li><li>Keep your account password private. You are responsible for activity on your account.</li></ul>`],
      ["Prices and what's included", `<ul><li>Prices are shown in the currency you choose. Currency conversion is approximate; your card may be charged in a different currency, and your bank may add fees.</li><li>The total at checkout is what you pay us. It includes the room or fare and the taxes we are required to collect.</li><li>Some hotels charge local fees directly at check-in, such as resort fees, city tax or tourism fees. When the hotel tells us about them, we show them at checkout as "Pay at hotel". Amounts may change with the hotel's own rules or exchange rates.</li><li>Prices can change until your booking is confirmed. We re-check the price before you pay and tell you if it changed.</li><li>If a price is clearly wrong because of a technical error, we may cancel the booking and give you a full refund.</li></ul>`],
      ["Member prices and rewards", `<p>Signed-in members may see prices that are not available to the public. Member prices are for the member's own travel and may not be shared, published or resold. PlanurStay Rewards points are earned and redeemed under the rules shown on the <a href="/membership">Rewards page</a>. Points have no cash value, can't be transferred, and may be removed if a booking is cancelled or the program is misused. We may change or end the Rewards program with reasonable notice; points you already have will stay usable for at least 90 days after any such notice.</p>`],
      ["Booking and payment", `<ul><li>A booking is confirmed only when you receive a confirmation number from us.</li><li>Payment is taken at the time of booking through our secure payment partner. We never see or store your full card number.</li><li>Make sure names match the ID or passport each traveller will use. Airlines may refuse boarding if they don't match, and name changes may not be possible.</li><li>The hotel may ask for a credit card and a security deposit at check-in.</li></ul>`],
      ["Changes and cancellations", `<p>Each rate has its own cancellation rules, which we show before you pay and in your confirmation. See our <a href="/cancellation-policy">cancellation and refund policy</a> for full details. Non-refundable rates cannot be cancelled or changed for a refund.</p>`],
      ["Flights", `<ul><li>Airline fare rules apply, including baggage allowance, seat selection, changes and refunds.</li><li>You are responsible for passports, visas, transit visas and health requirements for every country on your trip.</li><li>If a flight involves a change of airport or terminal, allow enough time. Where tickets are separate, a missed connection may not be protected.</li><li>Schedule changes are made by the airline. We will pass on any change we are told about.</li></ul>`],
      ["Hotels", `<ul><li>Photos, amenities and descriptions come from the hotel and our suppliers. We work to keep them accurate but can't guarantee every detail.</li><li>Check-in and check-out times, age limits, pet rules and deposits are set by the hotel.</li><li>Special requests (such as a bed type or a late arrival) are passed on to the hotel but can't be guaranteed.</li></ul>`],
      ["Our responsibility", `<p>We are responsible for arranging your booking with reasonable care and skill. We are not responsible for the supplier's own acts or omissions, such as overbooking, a change of room, a flight delay or a hotel closure. When those happen, we will help you claim your rights from the supplier. To the extent the law allows, our total liability for a booking is limited to the amount you paid us for it. Nothing in these terms limits rights you have under consumer protection laws that can't be excluded.</p>`],
      ["Complaints", `<p>If something goes wrong, contact the hotel or airline right away so they can try to fix it on the spot, and let us know at <a href="mailto:${esc(b.email)}">${esc(b.email)}</a>. We aim to reply within 2 business days.</p>`],
      ["Changes to these terms", `<p>We may update these terms from time to time. The version on this page when you book applies to that booking.</p>${b.law ? `<p>These terms are governed by the laws of ${esc(b.law)}.</p>` : ""}`],
    ]);
}

function privacy() {
  const b = biz(), n = esc(b.name);
  return shell("/privacy", "Privacy policy",
    `This policy explains what personal information ${n} collects, why, who we share it with, and the choices you have. We only collect what we need to find and book your trip and to run the site.`,
    [
      ["What we collect", `<ul><li><b>Booking details:</b> names of travellers, email, phone number, dates of birth and passport details where an airline requires them, and your trip details.</li><li><b>Account details:</b> your name, email and a securely hashed password if you create an account, plus your trips and Rewards points.</li><li><b>Payment:</b> handled by our payment partner. We receive a payment reference, never your full card number.</li><li><b>Usage:</b> pages visited and searches made, using an anonymous visitor ID stored in your browser (not linked to your name). We use this only to improve the site.</li><li><b>Messages:</b> anything you send us by email, and price alerts or newsletter sign-ups.</li></ul>`],
      ["How we use it", `<ul><li>To make, manage and support your bookings and send confirmations.</li><li>To run your account and PlanurStay Rewards.</li><li>To send price alerts and newsletters you asked for. You can unsubscribe at any time.</li><li>If you search while signed in and don't book, to send you one reminder with current prices for that trip. Every reminder has a link to turn them off.</li><li>To prevent fraud and keep the site secure.</li><li>To understand which pages and searches work well, so we can improve them.</li></ul>`],
      ["Who we share it with", `<p>We share only what each partner needs to deliver your booking:</p><ul><li><b>Hotels and airlines</b>, and our booking partner Nuitee (LiteAPI), which passes your booking to them.</li><li><b>Payment processing</b>, through our payment partner.</li><li><b>Email delivery</b> for confirmations and alerts (Resend).</li><li><b>Hosting</b> of our website and database (Render).</li><li><b>Authorities</b>, where the law requires it (for example, airline passenger data rules).</li></ul><p>We don't sell your personal information.</p>`],
      ["Cookies and local storage", `<p>We use a small number of cookies and browser storage for: keeping you signed in, remembering your currency and recent searches, and counting visits anonymously. We don't use advertising cookies.</p>`],
      ["How long we keep it", `<p>We keep booking records for as long as tax and accounting laws require (usually up to 7 years). Account information is kept while your account is open. Anonymous usage data is kept for up to 13 months.</p>`],
      ["Your rights", `<p>Depending on where you live (including under GDPR, UK GDPR, PIPEDA and US state privacy laws), you can ask to see, correct, download or delete your personal information, or object to how we use it. Email <a href="mailto:${esc(b.email)}">${esc(b.email)}</a> from the address on your account. We'll reply within 30 days. Some booking information must be kept for legal reasons even if you ask us to delete it.</p>`],
      ["International transfers", `<p>Hotels, airlines and our service providers are located around the world, so your information may be processed outside your country. We work with providers who protect it appropriately.</p>`],
      ["Security", `<p>We use encrypted connections (HTTPS), hashed passwords and a payment partner that handles card data. No system is perfectly secure; if we become aware of a breach affecting you, we'll tell you as the law requires.</p>`],
      ["Children", `<p>Our site is not directed at children under 16. Children's details are collected only as travellers on a booking made by an adult.</p>`],
      ["Changes", `<p>We'll post any changes on this page and update the date at the top.</p>`],
    ]);
}

function cancellation() {
  const b = biz();
  return shell("/cancellation-policy", "Cancellations & refunds",
    `Every hotel rate and airline fare has its own rules. We show them clearly before you pay and in your confirmation email. Here's how it works.`,
    [
      ["Hotels: free cancellation rates", `<p>Rates marked <b>Free cancellation</b> can be cancelled for a full refund up to the deadline shown on your booking. Deadlines are shown in the hotel's local time unless stated otherwise. After the deadline, the hotel's cancellation fee applies (often the first night or the full stay).</p>`],
      ["Hotels: non-refundable rates", `<p>Rates marked <b>Non-refundable</b> are cheaper because they can't be cancelled, changed or refunded, including if you don't show up. Consider travel insurance if your plans might change.</p>`],
      ["Hotels: no-shows and early departures", `<p>If you don't arrive, or leave early, the hotel may charge the full stay. Contact the hotel directly if you'll arrive late so the room is held.</p>`],
      ["Flights", `<p>Airline fare rules decide whether a ticket can be changed or refunded, and what it costs. Basic fares are usually non-refundable. If the airline cancels or significantly changes your flight, you're entitled to a refund or rebooking under the airline's rules and local passenger rights laws. We'll help you with it.</p>`],
      ["How to cancel", `<p>Signed-in members can see their bookings under <a href="/my-bookings">My trips</a>. To cancel, email <a href="mailto:${esc(b.email)}">${esc(b.email)}</a> with your booking ID and the email used at checkout${b.phone ? `, or call ${esc(b.phone)}` : ""}. We'll confirm the cancellation in writing.</p>`],
      ["Refunds", `<p>Refunds go back to the card you paid with, usually within 5 to 10 business days after the cancellation is confirmed. Your bank may take longer to show it. Card or currency conversion fees charged by your bank are not refundable by us. Pay-at-hotel fees are settled with the hotel directly.</p>`],
      ["Rewards points and vouchers", `<p>Points from a cancelled booking are not released. If you used a Rewards voucher on a booking that is refunded, contact us and we'll reissue the voucher value.</p>`],
      ["If the hotel can't honour your booking", `<p>If a hotel can't provide your confirmed room (for example because of overbooking), contact us right away. We'll work with the hotel to find a comparable room, or give you a full refund for the nights affected.</p>`],
    ]);
}

function contact() {
  const b = biz();
  return `<main class="container legal">
    <nav class="crumbs"><a href="/">Home</a> › <span>Contact us</span></nav>
    <div class="legal-wrap">
      <aside class="legal-nav">${NAV.map(([h, t]) => `<a href="${h}"${h === "/contact" ? ' class="on"' : ""}>${t}</a>`).join("")}</aside>
      <article class="legal-body">
        <h1>Contact us</h1>
        <p class="legal-intro">Real people, happy to help before, during and after your trip.</p>
        <div class="contact-grid">
          <a class="contact-card" href="mailto:${esc(b.email)}"><b>Email</b><span>${esc(b.email)}</span><small>We reply within 1 business day, usually sooner.</small></a>
          ${b.phone ? `<a class="contact-card" href="tel:${esc(b.phone.replace(/[^\d+]/g, ""))}"><b>Phone</b><span>${esc(b.phone)}</span><small>For urgent help with a booking.</small></a>` : ""}
          <a class="contact-card" href="/my-bookings"><b>Manage a booking</b><span>My trips</span><small>Find a booking with your booking ID and email.</small></a>
        </div>
        <h2>Tips to get help faster</h2>
        <ul><li>Include your booking ID and the email used at checkout.</li><li>At the hotel or airport right now? Speak to the front desk or airline first; they can often fix it on the spot. Then let us know.</li><li>For cancellations, see our <a href="/cancellation-policy">cancellation and refund policy</a>.</li></ul>
        ${b.address ? `<p class="legal-upd">${esc(b.name)}, ${esc(b.address)}</p>` : ""}
      </article>
    </div>
  </main>`;
}

const PAGES = {
  "/terms": { title: "Terms of service", desc: "The terms that apply when you book hotels and flights with PlanurStay.", body: terms },
  "/privacy": { title: "Privacy policy", desc: "How PlanurStay collects, uses and protects your personal information.", body: privacy },
  "/cancellation-policy": { title: "Cancellations & refunds", desc: "How hotel and flight cancellations and refunds work at PlanurStay.", body: cancellation },
  "/contact": { title: "Contact us", desc: "Get help with a PlanurStay booking by email or phone.", body: contact },
};

function registerLegalRoutes(app) {
  for (const [path, p] of Object.entries(PAGES)) {
    app.get(path, (req, res) => {
      const base = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
      res.send(page({ title: `${p.title} — PlanurStay`, description: p.desc, canonical: base + path, body: p.body(), active: "" }));
    });
  }
}

module.exports = { registerLegalRoutes, LEGAL_PATHS: Object.keys(PAGES) };
