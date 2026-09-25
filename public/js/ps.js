/* ═══════════════════════════════════════════════════════════════════════════
   PlanurStay — shared UI: header/footer, auth, formatting, search widgets
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  const PS = (window.PS = {});

  // ─── Icons ───
  const I = (d, s = 20, sw = 2) =>
    `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const P = {
    bed: '<path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/><path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M12 4v6"/><path d="M2 18h20"/>',
    plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    tag: '<path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.41 0l8.59-8.59a1 1 0 0 0 0-1.41z"/><circle cx="7" cy="7" r="1.5"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    headset: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
    star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
    bag: '<rect x="6" y="7" width="12" height="14" rx="2"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>',
    suitcase: '<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M8 20v1M16 20v1"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M8 16H3v5"/>',
    map: '<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16M16 6v16"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    trips: '<path d="M8 21h8M12 17v4"/><rect x="2" y="3" width="20" height="14" rx="2"/>',
    coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
    sqm: '<path d="M21 3 3 21M21 3h-6M21 3v6M3 21h6M3 21v-6"/>',
    photo: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    rain: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M16 14v6M8 14v6M12 16v6"/>',
    wifi: '<path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0M12 20h.01"/>',
    car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18 10l-2.7-3.6A2 2 0 0 0 13.7 6H10.3a2 2 0 0 0-1.6.8L6 10l-2.5 1.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M9 17h6"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    sunrise: '<path d="M12 2v8M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M8 6l4-4 4 4M16 18a4 4 0 0 0-8 0"/>',
    sunset: '<path d="M12 10V2M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4 4-4-4M16 18a4 4 0 0 0-8 0"/>',
    landmark: '<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2 20 7H4z"/>',
  };
  PS.icon = (name, size, sw) => I(P[name] || "", size, sw);

  // ─── Utils ───
  // Supplier text sometimes arrives already HTML-encoded ("&amp;"); decode first so it isn't shown literally, then escape.
  const ENT = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
  PS.esc = (s) => String(s ?? "").replace(/&(amp|quot|#39|apos|lt|gt|nbsp);/g, (m) => ENT[m]).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  PS.money = (n, cur = "USD", digits) => {
    if (n == null || isNaN(n)) return "—";
    const d = digits ?? (n >= 1000 ? 0 : n % 1 === 0 ? 0 : 2);
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(n); }
    catch { return `${cur} ${Number(n).toFixed(d)}`; }
  };
  PS.iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  PS.parse = (s) => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return y ? new Date(y, m - 1, d) : null; };
  PS.addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  PS.today = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
  PS.fmtDate = (s, opts = { month: "short", day: "numeric" }) => { const d = typeof s === "string" ? PS.parse(s) : s; return d ? d.toLocaleDateString("en-US", opts) : ""; };
  PS.fmtDay = (s) => PS.fmtDate(s, { weekday: "short", month: "short", day: "numeric" });
  PS.nights = (a, b) => Math.max(1, Math.round((PS.parse(b) - PS.parse(a)) / 86400000));
  PS.plural = (n, w, pl) => `${n} ${n === 1 ? w : pl || w + "s"}`;
  PS.dur = (min) => min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? " " + (min % 60) + "m" : ""}`;
  PS.time = (iso) => iso ? iso.slice(11, 16) : "";
  PS.qs = () => Object.fromEntries(new URLSearchParams(location.search));
  PS.url = (path, params) => {
    const u = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") u.set(k, v); });
    return `${path}?${u}`;
  };
  PS.ratingWord = (r) => r >= 9 ? "Exceptional" : r >= 8.5 ? "Excellent" : r >= 8 ? "Very good" : r >= 7 ? "Good" : r > 0 ? "Pleasant" : "New";
  PS.stars = (n) => n ? "★".repeat(Math.round(n)) : "";
  PS.store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { sessionStorage.removeItem(k); } catch {} },
  };
  PS.local = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  PS.api = async (url, { method = "GET", body, signal } = {}) => {
    const res = await fetch(url, {
      method, signal, credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = {};
    try { json = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(json.error || json.message || `Request failed (${res.status})`); e.status = res.status; e.data = json; throw e; }
    return json;
  };

  PS.toast = (msg, ms = 3200) => {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  };

  // ─── Currency (all LiteAPI currencies; prices come back from LiteAPI already in this currency) ───
  PS.cur = () => { const c = PS.local.get("ps_cur"); return /^[A-Z]{3}$/.test(c || "") ? c : "USD"; };
  const POPULAR_CUR = ["USD", "CAD", "EUR", "GBP", "INR", "AUD", "AED", "MXN", "JPY", "SGD"];
  async function currencyList() {
    const cached = PS.local.get("ps_cur_list");
    if (cached && cached.at > Date.now() - 7 * 86400000 && cached.list?.length) return cached.list;
    try {
      const r = await PS.api("/api/reference/currencies");
      const list = (r.data || []).filter(c => /^[A-Z]{3}$/.test(c.code)).map(c => ({ code: c.code, name: c.currency || c.code }));
      if (list.length) PS.local.set("ps_cur_list", { at: Date.now(), list });
      return list;
    } catch { return POPULAR_CUR.map(code => ({ code, name: code })); }
  }
  const curName = (code) => { try { return new Intl.DisplayNames(["en"], { type: "currency" }).of(code); } catch { return code; } };
  const curSymbol = (code) => { try { return (0).toLocaleString("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).replace(/[\d.,\s]/g, "") || code; } catch { return code; } };
  PS.openCurrency = async () => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal cur-modal" role="dialog" aria-modal="true" aria-label="Choose currency">
      <div class="modal-head"><h2>Choose a currency</h2><button class="modal-close" aria-label="Close">${PS.icon("x", 20)}</button></div>
      <div class="modal-body">
        <div class="field" style="margin-bottom:16px"><input id="curSearch" placeholder="Search currency or code" aria-label="Search currency" autocomplete="off"></div>
        <div id="curList"><div class="loading-note" style="border:0;padding:0"><span class="spinner"></span>Loading currencies…</div></div>
      </div></div>`;
    const close = () => { back.remove(); document.body.style.overflow = ""; };
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.querySelector(".modal-close").onclick = close;
    document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
    document.body.appendChild(back); document.body.style.overflow = "hidden";
    const list = await currencyList();
    const byCode = Object.fromEntries(list.map(c => [c.code, c]));
    const cur = PS.cur();
    const item = (c) => `<button type="button" class="cur-item ${c.code === cur ? "on" : ""}" data-cur="${c.code}"><b>${c.code}</b><span>${PS.esc(curName(c.code) !== c.code ? curName(c.code) : c.name)}</span><em>${PS.esc(curSymbol(c.code))}</em></button>`;
    const paint = (q) => {
      q = (q || "").trim().toLowerCase();
      const match = (c) => !q || c.code.toLowerCase().includes(q) || (c.name || "").toLowerCase().includes(q) || curName(c.code).toLowerCase().includes(q);
      const pop = POPULAR_CUR.filter(c => byCode[c] || c === "USD").map(c => byCode[c] || { code: c, name: c }).filter(match);
      const rest = list.filter(c => !POPULAR_CUR.includes(c.code) && match(c)).sort((a, b) => a.code.localeCompare(b.code));
      back.querySelector("#curList").innerHTML =
        (pop.length ? `<div class="cur-h">Popular</div><div class="cur-grid">${pop.map(item).join("")}</div>` : "") +
        (rest.length ? `<div class="cur-h">All currencies (${list.length})</div><div class="cur-grid">${rest.map(item).join("")}</div>` : "") +
        (!pop.length && !rest.length ? `<div class="ac-empty">No currency matches “${PS.esc(q)}”.</div>` : "");
      back.querySelectorAll("[data-cur]").forEach(b => b.onclick = () => { PS.local.set("ps_cur", b.dataset.cur); location.reload(); });
    };
    paint("");
    const input = back.querySelector("#curSearch");
    input.addEventListener("input", () => paint(input.value));
    if (window.innerWidth > 760) input.focus();
  };

  // ─── Auth ───
  let authPromise = null;
  PS.auth = () => (authPromise ||= fetch("/api/auth/me", { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ loggedIn: false })));
  PS.logout = async () => { await fetch("/api/auth/logout", { method: "POST" }); location.href = "/"; };
  PS.loginUrl = () => `/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;

  // ─── Header / footer ───
  PS.header = ({ active = "", onHero = false } = {}) => {
    const el = document.createElement("header");
    el.className = "site-header" + (onHero ? " on-hero" : "");
    el.innerHTML = `
      <div class="container hdr-inner">
        <a href="/" class="brand" aria-label="PlanurStay home"><span class="brand-mark">${PS.icon("plane", 18, 2.2)}</span>PlanurStay</a>
        <nav class="nav" aria-label="Main">
          <a href="/hotels" class="${active === "stays" ? "active" : ""}">${PS.icon("bed", 18)}Stays</a>
          <a href="/flights" class="${active === "flights" ? "active" : ""}">${PS.icon("plane", 18)}Flights</a>
          <a href="/guides" class="${active === "guides" ? "active" : ""}">${PS.icon("globe", 18)}Guides</a>
          <a href="/membership" class="${active === "rewards" ? "active" : ""}">${PS.icon("gift", 18)}Rewards</a>
        </nav>
        <div class="hdr-right" id="hdrRight">
          <button type="button" class="cur-btn" id="curBtn" aria-label="Currency: ${PS.cur()}">${PS.cur()}</button>
          <a href="/my-bookings" class="hdr-link hide-sm">Trips</a>
        </div>
      </div>`;
    document.body.prepend(el);
    el.querySelector("#curBtn").onclick = PS.openCurrency;

    const mob = document.createElement("nav");
    mob.className = "mobile-nav";
    mob.innerHTML = `
      <a href="/" class="${active === "home" ? "active" : ""}">${PS.icon("home", 20)}Home</a>
      <a href="/hotels" class="${active === "stays" ? "active" : ""}">${PS.icon("bed", 20)}Stays</a>
      <a href="/flights" class="${active === "flights" ? "active" : ""}">${PS.icon("plane", 20)}Flights</a>
      <a href="/my-bookings" class="${active === "trips" ? "active" : ""}">${PS.icon("trips", 20)}Trips</a>`;
    document.body.appendChild(mob);

    PS.auth().then((a) => {
      const right = el.querySelector("#hdrRight");
      if (a.loggedIn) {
        const email = a.user?.email || "";
        right.insertAdjacentHTML("beforeend", `
          <div class="menu-wrap">
            <button class="avatar" id="acctBtn" aria-haspopup="true" aria-label="Account">${PS.esc(email[0]?.toUpperCase() || "U")}</button>
            <div class="menu hidden" id="acctMenu">
              <div class="menu-email">${PS.esc(email)}</div>
              <a href="/my-bookings">My trips</a>
              <a href="/membership">Rewards &amp; membership</a>
              <button id="logoutBtn">Sign out</button>
            </div>
          </div>`);
        const btn = right.querySelector("#acctBtn"), menu = right.querySelector("#acctMenu");
        btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
        document.addEventListener("click", () => menu.classList.add("hidden"));
        right.querySelector("#logoutBtn").onclick = PS.logout;
      } else {
        right.insertAdjacentHTML("beforeend", `<a href="${PS.loginUrl()}" class="btn btn-sm ${onHero ? "btn-white" : "btn-primary"}">Sign in</a>`);
      }
    });
  };

  PS.footer = () => {
    const f = document.createElement("footer");
    f.className = "site-footer dark";
    f.innerHTML = `
      <div class="container">
        <div class="foot-top">
          <div class="foot-brand">
            <a href="/" class="brand"><span class="brand-mark">${PS.icon("plane", 18, 2.2)}</span>PlanurStay</a>
            <p>Your trip, simplified. Hotels and flights worldwide at member prices, backed by real people who help before, during and after you travel.</p>
            <a class="foot-mail" href="mailto:info@planurstay.com">${PS.icon("mail", 16)}info@planurstay.com</a>
          </div>
          <div class="foot-news">
            <h4>Get deals in your inbox</h4>
            <p>Member offers, price drops and trip ideas. No spam, unsubscribe anytime.</p>
            <form id="newsForm" novalidate><input type="email" id="newsEmail" placeholder="Your email" aria-label="Email for newsletter" autocomplete="email" required><button class="btn btn-coral" type="submit">Subscribe</button></form>
            <div id="newsMsg"></div>
          </div>
          <div class="foot-cols">
            <div><h4>Explore</h4><a href="/hotels">Hotels</a><a href="/flights">Flights</a><a href="/guides">Travel guides</a><a href="/membership">Rewards</a></div>
            <div><h4>Your account</h4><a href="/my-bookings">My trips</a><a href="/login">Sign in</a><a href="/membership">Membership</a></div>
            <div><h4>Support</h4><a href="mailto:info@planurstay.com">Contact us</a><a href="/my-bookings">Manage a booking</a><a href="/my-bookings">Find a booking</a></div>
          </div>
        </div>
        <div class="foot-bottom"><span>© ${new Date().getFullYear()} PlanurStay. All rights reserved.</span><span class="pay-note">${PS.icon("lock", 14)}Secure payments · Prices in ${PS.cur()}</span></div>
      </div>`;
    document.body.appendChild(f);
    f.querySelector("#newsForm").onsubmit = async (e) => {
      e.preventDefault();
      const input = f.querySelector("#newsEmail"), msg = f.querySelector("#newsMsg"), btn = e.target.querySelector("button");
      btn.disabled = true;
      try {
        const r = await PS.api("/api/newsletter", { method: "POST", body: { email: input.value.trim(), source: location.pathname } });
        e.target.remove();
        msg.innerHTML = `<p class="news-ok">${PS.icon("check", 16, 3)}${r.already ? "You're already subscribed." : "You're subscribed! Check your inbox."}</p>`;
      } catch (err) { btn.disabled = false; msg.innerHTML = `<p class="news-err">${PS.esc(err.message)}</p>`; }
    };
  };

  // ─── Popover plumbing ───
  let openPop = null;
  function closePop() { if (openPop) { openPop.close(); openPop = null; } }
  document.addEventListener("mousedown", (e) => { if (openPop && !openPop.root.contains(e.target)) closePop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
  function registerPop(root, close) { if (openPop && openPop.root !== root) closePop(); openPop = { root, close }; }

  // ─── Autocomplete ───
  // field: .sfield element containing an <input>. fetcher(q) → items. render(item) → html. onSelect(item).
  PS.autocomplete = (field, { fetcher, render, onSelect, empty = "No matches", suggestions }) => {
    const input = field.querySelector("input");
    let pop = null, items = [], hi = -1, timer = null, seq = 0, pendingEnter = false;
    const close = () => { pop?.remove(); pop = null; field.classList.remove("open"); };
    const show = (html) => {
      if (!pop) { pop = document.createElement("div"); pop.className = "pop"; pop.style.minWidth = "340px"; field.appendChild(pop); registerPop(field, close); field.classList.add("open"); }
      pop.innerHTML = html;
      pop.querySelectorAll(".ac-item").forEach((n, i) => {
        n.onmousedown = (e) => { e.preventDefault(); choose(i); };
      });
    };
    const paint = (list, head) => {
      items = list; hi = list.length ? 0 : -1;
      if (pendingEnter && !head) { pendingEnter = false; if (list.length) { choose(0); return; } }
      show(list.length ? (head ? `<div class="ac-head">${head}</div>` : "") + list.map((it, i) => `<div class="ac-item ${i === hi ? "hi" : ""}">${render(it)}</div>`).join("") : `<div class="ac-empty">${empty}</div>`);
    };
    const choose = (i) => { const it = items[i]; if (!it) return; onSelect(it); close(); };
    input.addEventListener("focus", () => { input.select(); if (!input.value.trim() && suggestions) paint(suggestions, "Popular"); });
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      items = []; hi = -1; pendingEnter = false;
      if (q.length < 2) { if (suggestions) paint(suggestions, "Popular"); else close(); return; }
      show(`<div class="ac-empty" style="display:flex;gap:10px;align-items:center"><span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Searching…</div>`);
      timer = setTimeout(async () => {
        const my = ++seq;
        try { const list = await fetcher(q); if (my === seq) paint(list); }
        catch { if (my === seq) show(`<div class="ac-empty">Search is unavailable, please try again.</div>`); }
      }, 220);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !items.length && input.value.trim().length >= 2) { e.preventDefault(); pendingEnter = true; return; }
      if (!pop || !items.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        pop.querySelectorAll(".ac-item").forEach((n, i) => n.classList.toggle("hi", i === hi));
      } else if (e.key === "Enter") { e.preventDefault(); choose(hi); }
    });
    field.addEventListener("click", () => input.focus());
  };

  // ─── Date range calendar ───
  // Two separate fields (check-in / check-out, depart / return) share one calendar.
  // opts: { startField, endField, start, end, single, onChange(start, end), startLabel, endLabel }
  // startField === endField renders a combined "Oct 20 – Oct 23" value in one field.
  const openCals = new Set();
  PS.closeCalendars = () => [...openCals].forEach(fn => fn());
  PS.rangePicker = (opts) => {
    let { start, end } = opts;
    let single = !!opts.single, active = "start", hover = null, view = null, pop = null;
    const sf = opts.startField, ef = opts.endField || opts.startField, combined = sf === ef;
    const today = PS.today();
    const paint = () => {
      const sv = sf.querySelector(".val"), ev = ef.querySelector(".val");
      if (combined) {
        sv.classList.toggle("placeholder", !start);
        sv.textContent = !start ? "Add dates" : single || !end ? PS.fmtDay(start) : `${PS.fmtDate(start)} – ${PS.fmtDate(end)}`;
        return;
      }
      // Phones: "Nov 10" so the value fits in half-width boxes; wider screens: "Tue, Nov 10"
      const fmt = (d) => window.innerWidth < 560 ? PS.fmtDate(d) : PS.fmtDay(d);
      sv.classList.toggle("placeholder", !start); sv.textContent = start ? fmt(start) : "Add date";
      ev.classList.toggle("placeholder", !end); ev.textContent = end ? fmt(end) : (single ? "One way" : "Add date");
      sf.classList.toggle("active-end", false);
    };
    const markActive = () => {
      [sf, ef].forEach(f => f.classList.remove("cal-on"));
      if (pop) (active === "end" && !combined ? ef : sf).classList.add("cal-on");
    };
    const close = () => { pop?.remove(); pop = null; openCals.delete(close); [sf, ef].forEach(f => f.classList.remove("cal-on", "open")); document.removeEventListener("mousedown", outside, true); window.removeEventListener("resize", place); };
    const outside = (e) => { if (pop && !pop.contains(e.target) && !sf.contains(e.target) && !ef.contains(e.target)) close(); };
    const place = () => {
      if (!pop) return;
      if (window.innerWidth <= 760) { pop.style.cssText = ""; return; }
      const a = sf.getBoundingClientRect(), b = ef.getBoundingClientRect();
      const left = Math.min(a.left, b.left), w = pop.offsetWidth;
      const x = Math.max(12, Math.min(window.innerWidth - w - 12, left));
      pop.style.left = x + window.scrollX + "px";
      pop.style.top = Math.max(a.bottom, b.bottom) + window.scrollY + 10 + "px";
    };
    const dayCell = (dt) => {
      const t = +dt, cls = ["cd"];
      const disabled = dt < today || (active === "end" && !single && start && dt <= start && !combined && false);
      const rangeEnd = end || (active === "end" && hover && start && hover > start ? hover : null);
      if (start && t === +start) cls.push("s");
      if (!single && rangeEnd && t === +rangeEnd) cls.push("e");
      if (!single && start && rangeEnd && t > +start && t < +rangeEnd) cls.push("in");
      if (start && rangeEnd && t === +start && +start !== +rangeEnd) cls.push("has-range");
      if (t === +today) cls.push("today");
      return `<button type="button" class="${cls.join(" ")}" data-d="${PS.iso(dt)}" ${disabled ? "disabled" : ""}>${dt.getDate()}</button>`;
    };
    const month = (y, m) => {
      const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
      let cells = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(d => `<div class="cdow">${d}</div>`).join("");
      for (let i = 0; i < first.getDay(); i++) cells += "<div></div>";
      for (let d = 1; d <= days; d++) cells += dayCell(new Date(y, m, d));
      return `<div class="cmonth"><div class="ctitle">${first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div><div class="cgrid">${cells}</div></div>`;
    };
    const render = () => {
      const y = view.getFullYear(), m = view.getMonth();
      const canBack = new Date(y, m, 1) > new Date(today.getFullYear(), today.getMonth(), 1);
      const n = start && end ? PS.nights(PS.iso(start), PS.iso(end)) : 0;
      const hint = single ? "Pick a date" : active === "start" ? `Pick ${opts.startLabel || "a start date"}` : `Pick ${opts.endLabel || "an end date"}`;
      pop.innerHTML = `
        <button type="button" class="cnav prev" data-nav="-1" ${canBack ? "" : "disabled"} aria-label="Previous month">${PS.icon("left", 20, 2.4)}</button>
        <button type="button" class="cnav next" data-nav="1" aria-label="Next month">${PS.icon("right", 20, 2.4)}</button>
        <div class="cmonths">${month(y, m)}${month(new Date(y, m + 1, 1).getFullYear(), new Date(y, m + 1, 1).getMonth())}</div>
        <div class="cfoot"><span><b>${hint}</b>${n ? ` · ${PS.plural(n, opts.unit || "night")}` : ""}</span><span style="display:flex;gap:8px">${start ? `<button type="button" class="btn btn-sm btn-ghost" data-clear>Clear</button>` : ""}<button type="button" class="btn btn-sm btn-primary" data-done>Done</button></span></div>`;
      pop.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => { view = new Date(y, m + Number(b.dataset.nav), 1); render(); });
      pop.querySelector("[data-done]").onclick = () => { if (!single && start && !end) { end = PS.addDays(start, 1); commit(); } close(); };
      pop.querySelector("[data-clear]")?.addEventListener("click", () => { start = null; end = null; active = "start"; hover = null; paint(); render(); markActive(); });
      pop.querySelectorAll(".cd:not(:disabled)").forEach(b => {
        b.onclick = () => {
          const d = PS.parse(b.dataset.d);
          if (single) { start = d; commit(); close(); return; }
          if (active === "start" || !start || d <= start) {
            start = d;
            if (end && end <= d) end = null;
            active = "end"; hover = null; commit(); render(); markActive();
          } else {
            end = d; commit(); render();
            setTimeout(close, 220);
          }
        };
        b.onmouseenter = () => { if (active === "end" && start && !single) { hover = PS.parse(b.dataset.d); pop.querySelectorAll(".cd").forEach(c => {
          const t = +PS.parse(c.dataset.d), re = end && active !== "end" ? +end : +hover;
          c.classList.toggle("in", t > +start && t < re); c.classList.toggle("e", t === re && re > +start);
          c.classList.toggle("has-range", t === +start && re > +start);
        }); } };
      });
    };
    const commit = () => { paint(); opts.onChange?.(start, end); };
    const openAt = (which) => {
      active = single ? "start" : which;
      if (!pop) {
        PS.closeCalendars();
        openCals.add(close);
        pop = document.createElement("div"); pop.className = "cal";
        document.body.appendChild(pop);
        document.addEventListener("mousedown", outside, true);
        window.addEventListener("resize", place);
        const base = (active === "end" && end) ? end : (start || today);
        view = new Date(base.getFullYear(), base.getMonth() - (active === "end" && end && end.getMonth() !== (start || end).getMonth() ? 1 : 0), 1);
        if (view < new Date(today.getFullYear(), today.getMonth(), 1)) view = new Date(today.getFullYear(), today.getMonth(), 1);
      }
      render(); markActive(); place();
    };
    sf.addEventListener("click", (e) => { if (pop && active === "start" && !combined) { close(); return; } if (pop && combined) { close(); return; } openAt("start"); });
    if (!combined) ef.addEventListener("click", () => { if (single) { opts.onWantReturn?.(); return; } if (pop && active === "end") { close(); return; } openAt(start ? "end" : "start"); });
    paint();
    return {
      setSingle(v) { single = v; if (v) end = null; paint(); if (pop) render(); },
      get: () => ({ start, end }),
      open: openAt,
    };
  };
  PS.datePicker = (field, o) => PS.rangePicker({ ...o, startField: field, endField: field });

  // ─── Guests picker ───
  // opts: { adults, childAges: [], rooms, mode: "stays" | "flights", onChange(state) }
  PS.guestsPicker = (field, opts) => {
    const st = { adults: opts.adults || 2, childAges: opts.childAges || [], rooms: opts.rooms || 1 };
    const flights = opts.mode === "flights";
    const valEl = field.querySelector(".val");
    let pop = null;
    const paint = () => {
      const g = st.adults + st.childAges.length;
      valEl.textContent = flights ? PS.plural(st.adults, "traveler") : `${PS.plural(g, "guest")}, ${PS.plural(st.rooms, "room")}`;
    };
    const close = () => { pop?.remove(); pop = null; field.classList.remove("open"); };
    const row = (key, title, sub, val, min, max) => `
      <div class="g-row"><div><b>${title}</b><small>${sub}</small></div>
        <div class="stepper"><button type="button" data-k="${key}" data-d="-1" ${val <= min ? "disabled" : ""} aria-label="Fewer ${title}">−</button><output>${val}</output><button type="button" data-k="${key}" data-d="1" ${val >= max ? "disabled" : ""} aria-label="More ${title}">+</button></div></div>`;
    const render = () => {
      pop.innerHTML = flights
        ? row("adults", "Adults", "Age 12+", st.adults, 1, 9) + `<div class="hint" style="font-size:12.5px;color:var(--muted);margin-top:6px">Booking for children or infants? Contact us and we'll help.</div>`
        : row("adults", "Adults", "Age 18+", st.adults, 1, 16) +
          row("children", "Children", "Age 0–17", st.childAges.length, 0, 6) +
          (st.childAges.length ? `<div class="child-ages">${st.childAges.map((a, i) => `<div class="field"><select data-age="${i}" aria-label="Child ${i + 1} age">${Array.from({ length: 18 }, (_, n) => `<option value="${n}" ${n === a ? "selected" : ""}>${n === 0 ? "Under 1" : n} ${n === 1 ? "yr" : n ? "yrs" : ""}</option>`).join("")}</select></div>`).join("")}</div>` : "") +
          row("rooms", "Rooms", "", st.rooms, 1, Math.min(8, st.adults));
      pop.insertAdjacentHTML("beforeend", `<button type="button" class="btn btn-primary btn-block btn-sm" style="margin-top:12px" data-done>Done</button>`);
      pop.querySelectorAll("[data-k]").forEach(b => b.onclick = () => {
        const d = Number(b.dataset.d);
        if (b.dataset.k === "children") { if (d > 0) st.childAges.push(8); else st.childAges.pop(); }
        else st[b.dataset.k] += d;
        st.rooms = Math.min(st.rooms, st.adults);
        render(); paint(); opts.onChange?.(st);
      });
      pop.querySelectorAll("[data-age]").forEach(s => s.onchange = () => { st.childAges[+s.dataset.age] = +s.value; opts.onChange?.(st); });
      pop.querySelector("[data-done]").onclick = close;
    };
    field.addEventListener("click", (e) => {
      if (pop && pop.contains(e.target)) return;
      if (pop) { close(); return; }
      pop = document.createElement("div"); pop.className = "pop guests-pop";
      field.appendChild(pop); field.classList.add("open"); registerPop(field, close); render();
    });
    paint();
    return st;
  };

  // ─── Popular destinations (placeIds resolved from LiteAPI /data/places) ───
  PS.DESTS = [
    { name: "Paris", detail: "France", placeId: "ChIJD7fiBh9u5kcRYJSMaMOCCwQ", img: "photo-1502602898657-3e91760cbb34" },
    { name: "New York", detail: "NY, USA", placeId: "ChIJOwg_06VPwokRYv534QaPC8g", img: "photo-1496442226666-8d4d0e62e6e9" },
    { name: "Tokyo", detail: "Japan", placeId: "ChIJ51cu8IcbXWARiRtXIothAS4", img: "photo-1540959733332-eab4deabeeaf" },
    { name: "London", detail: "UK", placeId: "ChIJdd4hrwug2EcRmSrV3Vo6llI", img: "photo-1505761671935-60b3a7427bad" },
    { name: "Dubai", detail: "United Arab Emirates", placeId: "ChIJRcbZaklDXz4RYlEphFBu5r0", img: "photo-1512453979798-5ea266f8880c" },
    { name: "Rome", detail: "Italy", placeId: "ChIJu46S-ZZhLxMROG5lkwZ3D7k", img: "photo-1552832230-c0197dd311b5" },
    { name: "Santorini", detail: "Greece", placeId: "ChIJ6bzjBc7NmRQR26Hvu5LB9Ak", img: "photo-1570077188670-e3a8d69ac5ff" },
    { name: "Bali", detail: "Indonesia", placeId: "ChIJoQ8Q6NNB0S0RkOYkS7EPkSQ", img: "photo-1537996194471-e657df975ab4" },
    { name: "Cancún", detail: "Quintana Roo, Mexico", placeId: "ChIJ21P2rgUrTI8Ris1fYjy3Ms4", img: "photo-1506929562872-bb421503ef21" },
    { name: "Toronto", detail: "ON, Canada", placeId: "ChIJpTvG15DL1IkRd8S0KlBVNTI" },
    { name: "Las Vegas", detail: "NV, USA", placeId: "ChIJ0X31pIK3voARo3mz1ebVzDo" },
    { name: "Miami", detail: "FL, USA", placeId: "ChIJEcHIDqKw2YgRZU-t3XHylv8" },
  ];
  // Leaflet (loaded on demand) + OpenStreetMap tiles
  let leafletP = null;
  PS.leaflet = () => window.L ? Promise.resolve() : (leafletP ||= new Promise((res, rej) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(css);
    const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"; sc.onload = res; sc.onerror = () => { leafletP = null; rej(new Error("Map failed to load")); }; document.head.appendChild(sc);
  }));
  PS.mapTiles = (map) => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19, className: "ps-tiles" }).addTo(map);

  // ─── Animated search loader ───
  // kind: "flights" | "hotels". Returns { el, done() } — progress eases toward 92% until done.
  PS.searchLoader = (kind, { from = "", to = "", place = "" } = {}) => {
    const el = document.createElement("div");
    el.className = "sload";
    const msgs = kind === "flights"
      ? ["Checking hundreds of airlines…", "Comparing fares and fare families…", "Finding the best connections…", "Checking baggage and flexibility…", "Almost there, sorting the best options…"]
      : [`Searching hotels in ${place || "this area"}…`, "Checking live room availability…", "Comparing member prices…", "Looking for free cancellation deals…", "Almost there…"];
    el.innerHTML = kind === "flights"
      ? `<div class="sload-stage"><svg class="arc" viewBox="0 0 520 68" preserveAspectRatio="none"><path d="M 10 62 Q 260 -30 510 62"/></svg><span class="plane">${PS.icon("plane", 26, 2)}</span><div class="sload-codes"><span>${PS.esc(from)}</span><span>${PS.esc(to)}</span></div></div>
         <h3>Finding your flights</h3><p class="msg">${msgs[0]}</p><div class="bar"><i></i></div>`
      : `<div class="sload-pins">${Array.from({ length: 5 }, (_, i) => `<span>${PS.icon(i === 2 ? "bed" : "pin", i === 2 ? 34 : 26, 2)}</span>`).join("")}</div><div class="sload-bed"></div>
         <h3>Finding your stay</h3><p class="msg">${msgs[0]}</p><div class="bar"><i></i></div>`;
    const bar = el.querySelector(".bar i"), msg = el.querySelector(".msg");
    const expected = kind === "flights" ? 35000 : 8000, t0 = Date.now();
    let i = 0;
    const tick = setInterval(() => {
      const p = 92 * (1 - Math.exp(-(Date.now() - t0) / (expected / 2.2)));
      bar.style.width = p.toFixed(1) + "%";
    }, 300);
    const rot = setInterval(() => {
      i = (i + 1) % msgs.length;
      msg.style.opacity = 0;
      setTimeout(() => { msg.textContent = msgs[Math.min(i, msgs.length - 1)]; msg.style.opacity = 1; }, 300);
    }, 3200);
    requestAnimationFrame(() => (bar.style.width = "6%"));
    return { el, done() { clearInterval(tick); clearInterval(rot); bar.style.width = "100%"; } };
  };

  // Placeholder shapes that mirror real result cards and filters while loading
  const sk = (w, h, extra = "") => `<div class="skel" style="width:${w};height:${h}px;${extra}"></div>`;
  PS.skeleton = {
    hotels: (n = 3) => Array.from({ length: n }, () => `<div class="sk-card"><div class="skel sk-img"></div><div class="sk-body">
      <div class="sk-top"><div class="sk-lines">${sk("65%", 22)}${sk("45%", 14)}${sk("35%", 14)}</div><div class="sk-right">${sk("90px", 26)}${sk("70px", 12)}${sk("100px", 12)}</div></div><div></div>
      <div class="sk-foot"><div style="display:flex;gap:8px">${sk("24px", 24)}${sk("120px", 24)}</div>${sk("140px", 40, "border-radius:10px")}</div></div></div>`).join(""),
    flights: (n = 3) => Array.from({ length: n }, () => `<div class="sk-fcard"><div class="legs">${[0, 1].map(() => `<div class="sk-leg"><div style="display:flex;gap:10px;align-items:center">${sk("34px", 34, "border-radius:8px")}<div style="flex:1;display:grid;gap:6px">${sk("90%", 12)}${sk("60%", 10)}</div></div>${sk("100%", 22)}${sk("100%", 4)}${sk("100%", 22)}</div>`).join("")}</div>
      <div class="pr">${sk("60px", 16)}${sk("100px", 28)}${sk("110px", 36, "border-radius:10px")}</div></div>`).join(""),
    filters: (n = 4) => Array.from({ length: n }, (_, i) => `<div class="sk-filter">${sk("45%", 16)}${sk("90%", 12)}${sk("75%", 12)}${i % 2 ? sk("60%", 12) : ""}</div>`).join(""),
  };

  // ─── Weather strip: forecast for a place and date range ───
  PS.weather = async (el, { lat, lng, start, end, title = "Weather" }) => {
    if (!el || lat == null || lng == null || !start) return;
    el.innerHTML = `<div class="wx"><div class="wx-head"><b>${PS.esc(title)}</b></div><div class="wx-row">${Array.from({ length: 4 }, () => `<div class="skel" style="height:96px;border-radius:12px"></div>`).join("")}</div></div>`;
    let days = [];
    try { days = (await PS.api(`/api/extras/weather?lat=${lat}&lng=${lng}&start=${start}&end=${end || start}`)).data || []; } catch {}
    if (!days.length) { el.innerHTML = ""; return; }
    const kind = (d) => d.rainMm >= 2 ? "rain" : (d.cloud ?? 0) >= 60 ? "cloud" : "sun";
    const word = { rain: "Rain", cloud: "Cloudy", sun: "Sunny" };
    const hi = Math.round(Math.max(...days.map(d => d.max))), lo = Math.round(Math.min(...days.map(d => d.min)));
    const rainy = days.filter(d => kind(d) === "rain").length;
    const tip = rainy >= Math.ceil(days.length / 2) ? "Pack an umbrella" : hi >= 28 ? "Pack light, breathable clothes" : lo <= 5 ? "Pack warm layers" : "Pack light layers";
    el.innerHTML = `<div class="wx">
      <div class="wx-head"><b>${PS.esc(title)}</b><span>${lo}° to ${hi}°C · ${rainy ? PS.plural(rainy, "rainy day") : "Mostly dry"} · ${tip}</span></div>
      <div class="wx-row">${days.map(d => { const k = kind(d); return `<div class="wx-day ${k}">
        <small>${PS.fmtDate(d.date, { weekday: "short" })}</small><small class="dt">${PS.fmtDate(d.date)}</small>
        <span class="wx-ico">${PS.icon(k, 26, 2)}</span>
        <b>${Math.round(d.max)}°</b><small>${Math.round(d.min)}° · ${word[k]}</small></div>`; }).join("")}</div>
    </div>`;
  };

  PS.img = (id, w = 900) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=70`;
  const POPULAR_AIRPORTS = [
    { code: "YYZ", city: "Toronto", name: "Toronto Pearson International Airport", countryCode: "CA" },
    { code: "JFK", city: "New York", name: "John F. Kennedy International Airport", countryCode: "US" },
    { code: "LAX", city: "Los Angeles", name: "Los Angeles International Airport", countryCode: "US" },
    { code: "LHR", city: "London", name: "Heathrow Airport", countryCode: "GB" },
    { code: "CDG", city: "Paris", name: "Charles de Gaulle Airport", countryCode: "FR" },
    { code: "DXB", city: "Dubai", name: "Dubai International Airport", countryCode: "AE" },
  ];

  // ─── Search forms ───
  const fieldHTML = (cls, icon, label, inner) => `<div class="sfield ${cls}">${PS.icon(icon, 22)}<div class="sfield-body"><span class="lbl">${label}</span>${inner}</div></div>`;

  PS.staysSearch = (host, init = {}) => {
    PS.closeCalendars();
    const q = { ...init };
    const today = PS.today();
    let checkin = PS.parse(q.checkin) || PS.addDays(today, 14);
    let checkout = PS.parse(q.checkout) || PS.addDays(checkin, 3);
    if (checkin < today) { checkin = PS.addDays(today, 1); checkout = PS.addDays(checkin, 3); }
    let place = q.placeId ? { placeId: q.placeId, name: q.dest || "", detail: q.destDetail || "" } : null;

    host.innerHTML = `<form class="sfields stays" novalidate>
      ${fieldHTML("wide dest", "pin", "Where to?", `<input type="text" placeholder="City, landmark or hotel" autocomplete="off" aria-label="Destination" value="${PS.esc(place ? place.name + (place.detail ? ", " + place.detail : "") : "")}">`)}
      ${fieldHTML("clickable din", "cal", "Check-in", `<span class="val"></span>`)}
      ${fieldHTML("clickable dout", "cal", "Check-out", `<span class="val"></span>`)}
      ${fieldHTML("clickable guests", "users", "Travelers", `<span class="val"></span>`)}
      <button class="btn btn-primary search-go" type="submit">${PS.icon("search", 20, 2.4)}<span>Search</span></button>
    </form>`;
    const form = host.querySelector("form");
    const destField = form.querySelector(".dest");
    const destInput = destField.querySelector("input");
    const kindIcon = { city: "pin", hotel: "bed", airport: "plane", landmark: "landmark" };
    PS.autocomplete(destField, {
      fetcher: async (s) => (await PS.api(`/api/places?q=${encodeURIComponent(s)}`)).data,
      suggestions: PS.DESTS.slice(0, 6).map(d => ({ ...d, kind: "city" })),
      render: (p) => `<span class="ac-icon">${PS.icon(kindIcon[p.kind] || "pin", 18)}</span><span><div class="ac-main">${PS.esc(p.name)}</div><div class="ac-sub">${PS.esc(p.detail || "")}</div></span>`,
      onSelect: (p) => { place = p; destInput.value = p.name + (p.detail ? ", " + p.detail : ""); destField.classList.remove("err"); },
      empty: "No destinations found. Try a city name.",
    });
    destInput.addEventListener("input", () => { place = null; });
    PS.rangePicker({ startField: form.querySelector(".din"), endField: form.querySelector(".dout"), start: checkin, end: checkout, startLabel: "check-in", endLabel: "check-out",
      onChange: (s, e) => { checkin = s; checkout = e; } });
    const guests = PS.guestsPicker(form.querySelector(".guests"), {
      adults: +q.adults || 2, rooms: +q.rooms || 1,
      childAges: q.children ? q.children.split(",").map(Number).filter(n => !isNaN(n)) : [],
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!place) {
        const text = destInput.value.trim();
        if (text.length >= 2) {
          try { const r = await PS.api(`/api/places?q=${encodeURIComponent(text)}`); place = r.data[0] || null; } catch {}
        }
        if (!place) { destInput.focus(); destInput.placeholder = "Please choose a destination"; return; }
      }
      if (!checkin) { form.querySelector(".din").click(); return; }
      if (!checkout) checkout = PS.addDays(checkin, 1);
      location.href = PS.url("/hotels", {
        placeId: place.placeId, dest: place.name, destDetail: place.detail,
        checkin: PS.iso(checkin), checkout: PS.iso(checkout),
        adults: guests.adults, rooms: guests.rooms, children: guests.childAges.join(","),
      });
    });
  };

  PS.flightsSearch = (host, init = {}) => {
    PS.closeCalendars();
    const q = { ...init };
    const today = PS.today();
    let depart = PS.parse(q.depart) || PS.addDays(today, 21);
    if (depart < today) depart = PS.addDays(today, 7);
    let ret = q.return ? PS.parse(q.return) : (q.trip === "oneway" ? null : PS.addDays(depart, 7));
    let trip = q.return || !q.depart ? "round" : "oneway";
    let from = q.from ? { code: q.from, city: q.fromCity || q.from, countryCode: q.fromCountry } : null;
    let to = q.to ? { code: q.to, city: q.toCity || q.to } : null;
    // Box shows the city; the airport code sits next to the label ("FROM · YYZ") so nothing gets cut off
    const label = (a) => a ? a.city : "";
    const codeTag = (half, a) => { const t = half.querySelector(".code-tag"); t.textContent = a ? a.code : ""; t.classList.toggle("hidden", !a); };

    // Round trip / One way switch: the homepage passes its own (in the tab row, so tabs never shift);
    // elsewhere it's rendered above the fields.
    const tripEl = init.tripToggle || null;
    host.innerHTML = `
      ${tripEl ? "" : `<div class="trip-type"><button type="button" class="chip-toggle" data-trip="round">Round trip</button><button type="button" class="chip-toggle" data-trip="oneway">One way</button></div>`}
      <form class="sfields flights" novalidate>
        <div class="sfield route wide">
          <div class="route-half from">${PS.icon("plane", 20)}<div class="sfield-body"><span class="lbl">From <b class="code-tag hidden"></b></span><input type="text" placeholder="City or airport" autocomplete="off" aria-label="From" value="${PS.esc(label(from))}"></div></div>
          <button type="button" class="swap-btn" aria-label="Swap origin and destination">${PS.icon("swap", 16)}</button>
          <div class="route-half to">${PS.icon("pin", 20)}<div class="sfield-body"><span class="lbl">To <b class="code-tag hidden"></b></span><input type="text" placeholder="City or airport" autocomplete="off" aria-label="To" value="${PS.esc(label(to))}"></div></div>
        </div>
        ${fieldHTML("clickable din", "cal", "Depart", `<span class="val"></span>`)}
        ${fieldHTML("clickable dout", "cal", "Return", `<span class="val"></span>`)}
        ${fieldHTML("clickable guests", "user", "Travelers", `<span class="val"></span>`)}
        <button class="btn btn-primary search-go" type="submit">${PS.icon("search", 20, 2.4)}<span>Search</span></button>
      </form>`;
    const form = host.querySelector("form");
    const airportAC = (field, set) => {
      const input = field.querySelector("input");
      PS.autocomplete(field, {
        fetcher: async (s) => (await PS.api(`/api/airports?q=${encodeURIComponent(s)}`)).data,
        suggestions: POPULAR_AIRPORTS,
        render: (a) => `<span class="ac-icon">${PS.icon("plane", 18)}</span><span style="min-width:0"><div class="ac-main">${PS.esc(a.city)}</div><div class="ac-sub">${PS.esc(a.name)}</div></span><span class="ac-code">${a.code}</span>`,
        onSelect: (a) => { set(a); input.value = label(a); codeTag(field, a); },
        empty: "No airports found",
      });
      input.addEventListener("input", () => { set(null); codeTag(field, null); });
    };
    const fromField = form.querySelector(".route-half.from"), toField = form.querySelector(".route-half.to");
    airportAC(fromField, (a) => (from = a));
    airportAC(toField, (a) => (to = a));
    codeTag(fromField, from); codeTag(toField, to);
    form.querySelector(".swap-btn").onclick = () => {
      [from, to] = [to, from];
      fromField.querySelector("input").value = label(from);
      toField.querySelector("input").value = label(to);
      codeTag(fromField, from); codeTag(toField, to);
    };
    const dp = PS.rangePicker({ startField: form.querySelector(".din"), endField: form.querySelector(".dout"), start: depart, end: ret, single: trip === "oneway",
      startLabel: "departure", endLabel: "return", unit: "day",
      onChange: (s, e) => { depart = s; ret = e; },
      onWantReturn: () => { setTrip("round"); setTimeout(() => dp.open("end"), 0); } });
    // One way / round trip lives inside the Return box: ✕ removes the return, tapping the box adds it back.
    const retBox = form.querySelector(".dout");
    retBox.insertAdjacentHTML("beforeend", `<button type="button" class="ret-clear" aria-label="Remove return flight (one way)" title="One way">${PS.icon("x", 14, 2.6)}</button>`);
    retBox.querySelector(".ret-clear").addEventListener("click", (e) => { e.stopPropagation(); PS.closeCalendars(); setTrip("oneway"); });
    const tripButtons = () => [...(tripEl || host).querySelectorAll("[data-trip]")];
    function setTrip(t) {
      trip = t;
      tripButtons().forEach(b => { b.classList.toggle("active", b.dataset.trip === t); b.setAttribute("aria-pressed", b.dataset.trip === t); });
      retBox.classList.toggle("muted", t === "oneway");
      dp.setSingle(t === "oneway");
      if (t === "oneway") ret = null;
    }
    tripButtons().forEach(b => b.onclick = () => {
      PS.closeCalendars();
      setTrip(b.dataset.trip);
      if (b.dataset.trip === "round" && !dp.get().end) setTimeout(() => dp.open("end"), 0);
    });
    setTrip(trip);
    const guests = PS.guestsPicker(form.querySelector(".guests"), { adults: +q.adults || 1, mode: "flights" });

    const resolveTyped = async (field, current) => {
      if (current) return current;
      const text = field.querySelector("input").value.trim();
      const code = (text.match(/\(([A-Z]{3})\)/) || [])[1] || (/^[a-z]{3}$/i.test(text) ? text.toUpperCase() : null);
      if (text.length < 2) return null;
      try { const r = await PS.api(`/api/airports?q=${encodeURIComponent(code || text)}`); return r.data[0] || null; } catch { return null; }
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      from = await resolveTyped(fromField, from);
      to = await resolveTyped(toField, to);
      if (!from) { fromField.querySelector("input").focus(); return PS.toast("Choose where you're flying from"); }
      if (!to) { toField.querySelector("input").focus(); return PS.toast("Choose where you're flying to"); }
      if (from.code === to.code) return PS.toast("Origin and destination must be different");
      const g = dp.get();
      if (!g.start) { form.querySelector(".din").click(); return PS.toast("Choose your departure date"); }
      depart = g.start;
      if (trip === "round" && !g.end) { dp.open("end"); return PS.toast("Choose your return date, or switch to One way"); }
      ret = trip === "round" ? g.end : null;
      location.href = PS.url("/flights", {
        from: from.code, fromCity: from.city, fromCountry: from.countryCode, to: to.code, toCity: to.city,
        depart: PS.iso(depart), return: ret ? PS.iso(ret) : "", adults: guests.adults,
      });
    });
  };
})();
