// ─── Flight results page ───
document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const depart = params.get("depart") || "";
  const retun = params.get("return") || "";
  const adults = params.get("adults") || "1";
  const maxStops = params.get("maxStops") || "";
  const cabin = params.get("cabin") || "";
  const maxPrice = params.get("maxPrice") || "";
  const departTimeFilter = params.get("departTime") || "";

  const loader = document.getElementById("loader");
  const flightResults = document.getElementById("flightResults");
  const noResults = document.getElementById("noResults");
  const filterStops = document.getElementById("filterStops");
  const filterCabin = document.getElementById("filterCabin");
  const filterMaxPrice = document.getElementById("filterMaxPrice");
  const filterDepartTime = document.getElementById("filterDepartTime");
  const clearFiltersBtn = document.getElementById("clearFilters");

  // Sync filter UI with URL params
  if (filterStops) filterStops.value = maxStops;
  if (filterCabin) filterCabin.value = cabin;
  if (filterMaxPrice) filterMaxPrice.value = maxPrice;
  if (filterDepartTime) filterDepartTime.value = departTimeFilter;

  // Clear filters button
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener("click", () => {
      const baseParams = new URLSearchParams({
        from,
        to,
        depart,
        adults,
      });
      if (retun) baseParams.set("return", retun);
      window.location.href = `/flights?${baseParams.toString()}`;
    });
  }

  // Filter change handlers
  function handleFilterChange() {
    const newMaxStops = filterStops?.value || "";
    const newCabin = filterCabin?.value || "";
    const newMaxPrice = filterMaxPrice?.value || "";
    const newDepartTime = filterDepartTime?.value || "";
    const newParams = new URLSearchParams({
      from,
      to,
      depart,
      adults,
    });
    if (retun) newParams.set("return", retun);
    if (newMaxStops) newParams.set("maxStops", newMaxStops);
    if (newCabin) newParams.set("cabin", newCabin);
    if (newMaxPrice) newParams.set("maxPrice", newMaxPrice);
    if (newDepartTime) newParams.set("departTime", newDepartTime);
    window.location.href = `/flights?${newParams.toString()}`;
  }

  if (filterStops) filterStops.addEventListener("change", handleFilterChange);
  if (filterCabin) filterCabin.addEventListener("change", handleFilterChange);
  if (filterMaxPrice) filterMaxPrice.addEventListener("change", handleFilterChange);
  if (filterDepartTime) filterDepartTime.addEventListener("change", handleFilterChange);

  loader.style.display = "block";
  flightResults.innerHTML = "";

  try {
    const legs = [
      { origin: from, destination: to, date: depart, direction: "OUTBOUND" }
    ];
    if (retun && retun > depart) {
      legs.push({ origin: to, destination: from, date: retun, direction: "INBOUND" });
    }

    const res = await fetch("/api/flights/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs,
        adults: parseInt(adults),
        currency: "USD",
        country: "US",
      }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error?.message || "Flight search failed");
    }

    let journeys = [];
    let totalPriceList = [];

    // LiteAPI flight search returns data in various shapes.
    // Shape 1: { data: [{ journeys: [...] }] }
    if (data.data && Array.isArray(data.data)) {
      data.data.forEach((page) => {
        if (page.journeys && Array.isArray(page.journeys)) {
          journeys = journeys.concat(page.journeys);
        }
        if (page.offers && Array.isArray(page.offers)) {
          page.offers.forEach((o) =>
            totalPriceList.push(o.price || o.totalPrice || Infinity)
          );
        }
      });
    }

    // Shape 2: { data: { journeys: [...] } }
    if (!journeys.length && data.data && data.data.journeys && Array.isArray(data.data.journeys)) {
      journeys = data.data.journeys;
    }

    // Shape 3: { offers: [...] } directly
    if (!journeys.length && data.offers && Array.isArray(data.offers)) {
      journeys = data.offers.map((o) => ({
        offers: [o],
        segments: [],
        totalDuration: o.totalDuration || "",
        price: o.price || o.totalPrice || 0,
      }));
    }

    if (!journeys.length) {
      loader.style.display = "none";
      noResults.style.display = "block";
      return;
    }

    loader.style.display = "none";

    const tripType = legs.length === 1 ? "One-way" : "Round-trip";
    const countEl = document.createElement("div");
    countEl.className = "results-info";
    countEl.textContent = `${journeys.length} flights · ${tripType} · ${from} → ${to}`;
    const topDiv = document.querySelector(".results-top");
    if (topDiv) topDiv.appendChild(countEl);

    // Sort by cheapest first
    journeys.sort((a, b) => {
      const aP = (a.offers && a.offers[0])
        ? a.offers[0].price || a.offers[0].totalPrice || Infinity
        : Infinity;
      const bP = (b.offers && b.offers[0])
        ? b.offers[0].price || b.offers[0].totalPrice || Infinity
        : Infinity;
      return aP - bP;
    });

    // Helper: get departure time category
    function getDepartTimeCategory(segments) {
      if (!segments || !segments.length) return "";
      const depTime = segments[0].departureTime || segments[0].departureAt || "";
      if (!depTime) return "";
      const hour = new Date(depTime).getHours();
      if (hour >= 6 && hour < 12) return "morning";
      if (hour >= 12 && hour < 18) return "afternoon";
      if (hour >= 18 && hour < 24) return "evening";
      return "night";
    }

    // Helper: get cabin class from fare family
    function getCabinFromFare(fareFamily) {
      if (!fareFamily) return "economy";
      const ff = fareFamily.toLowerCase();
      if (ff.includes("first") || ff.includes("business")) return "business";
      if (ff.includes("premium")) return "premium";
      return "economy";
    }

    // Helper: count stops from segments
    function countStops(segments) {
      if (!segments) {
        // Check legs for connection info
        return 0;
      }
      return segments.length - 1;
    }

    journeys.forEach((journey, idx) => {
      const offers = journey.offers || [];
      const cheapest = offers[0];
      if (!cheapest) return;

      const price = cheapest.price || cheapest.totalPrice || 0;
      const currency = cheapest.currency || "USD";
      const duration = journey.totalDuration || "";
      const legsArr = journey.legs || [];
      const segments = journey.segments || legsArr;

      // ─── Apply filters ───
      // Max stops filter
      if (maxStops) {
        const stops = countStops(segments);
        if (stops > parseInt(maxStops)) return;
      }

      // Cabin filter
      if (cabin) {
        const offerCabin = getCabinFromFare(cheapest.fareFamily || cheapest.fare?.family);
        if (cabin === "economy" && offerCabin !== "economy") return;
        if (cabin === "premium" && offerCabin !== "premium" && offerCabin !== "economy") return;
        if (cabin === "business" && offerCabin !== "business" && offerCabin !== "first") return;
        if (cabin === "first" && offerCabin !== "first") return;
      }

      // Max price filter
      if (maxPrice && price > parseFloat(maxPrice)) return;

      // Departure time filter
      if (departTimeFilter) {
        const depCat = getDepartTimeCategory(segments);
        if (depCat !== departTimeFilter) return;
      }

      // ─── Build segment HTML ───
      let segmentsHtml = "";
      segments.forEach((seg, i) => {
        if (i > 0) {
          segmentsHtml +=
            `<div class="flight-connector">
              <div class="connector-dot"></div>
              <div class="connector-line-long"></div>
              <div class="connector-dot"></div>
            </div>`;
        }
        const airline = seg.carrier || seg.airline || {};
        const logoUrl =
          (airline.marketingLogo && typeof airline.marketingLogo === "string") ||
          (airline.logoUrl && typeof airline.logoUrl === "string")
            ? airline.marketingLogo || airline.logoUrl
            : "";
        const airlineName = airline.marketingName || airline.name || (seg.airlineName || "Airline");
        const depTime = seg.departureTime || seg.departureAt || seg.departure || "";
        const arrTime = seg.arrivalTime || seg.arrivalAt || seg.arrival || "";
        const origin = seg.originCode || seg.origin || seg.from || "";
        const dest = seg.destinationCode || seg.destination || seg.to || "";

        // Terminal info
        const depTerm = seg.departureTerminal || "";
        const arrTerm = seg.arrivalTerminal || "";

        const depDate = depTime ? new Date(depTime) : new Date();
        const arrDate = arrTime ? new Date(arrTime) : new Date();

        // Layover duration for this segment (time between arrival of this and departure of next)
        let layoverHtml = "";
        if (i < segments.length - 1) {
          const nextDep = new Date(segments[i + 1].departureTime || segments[i + 1].departureAt || "");
          const thisArr = new Date(arrTime);
          const layoverMin = Math.round((nextDep.getTime() - thisArr.getTime()) / 60000);
          const layoverStr = layoverMin >= 60
            ? `${Math.floor(layoverMin / 60)}h ${layoverMin % 60}m`
            : `${layoverMin}m`;
          layoverHtml = `<div class="seg-layover">⛔ ${layoverStr} layover</div>`;
        }

        segmentsHtml +=
          `<div class="flight-segment${i > 0 ? " connector" : ""}">
            <div class="seg-airline">
              <div class="airline-logo">
                <img src="${logoUrl}" alt="${airlineName}" onerror="this.style.display='none'" loading="lazy">
              </div>
              <div class="airline-name">${airlineName}</div>
            </div>
            <div class="seg-times">
              <div class="seg-depart">
                ${isNaN(depDate.getTime()) ? "--:--" : depDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                ${depTerm ? ` <span class="seg-terminal">${depTerm}</span>` : ""}
              </div>
              <div class="seg-depart-sub">
                ${isNaN(depDate.getTime()) ? "" : depDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </div>
              <div class="seg-line">
                <span class="seg-from">${origin}</span>
                <div class="seg-arrow">→</div>
                <span class="seg-to">${dest}</span>
              </div>
              <div class="seg-arrive">
                ${isNaN(arrDate.getTime()) ? "--:--" : arrDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                ${arrTerm ? ` <span class="seg-terminal">${arrTerm}</span>` : ""}
              </div>
              <div class="seg-arrive-sub">
                ${isNaN(arrDate.getTime()) ? "" : arrDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </div>
            </div>
            ${layoverHtml}
          </div>`;
      });

      const stops = segments.length - 1;
      const stopsText =
        stops <= 0
          ? "Direct"
          : stops === 1
          ? "1 stop"
          : stops + " stops";

      // Flight number from first segment
      const flightNum = segments[0]?.flight?.marketingNumber || "";

      const card = document.createElement("div");
      card.className = "flight-card";
      card.innerHTML =
        `<a href="/flight-detail?offerId=${encodeURIComponent(cheapest.offerId || "")}&legs=${encodeURIComponent(JSON.stringify(legs))}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}" style="display:block;text-decoration:none;color:inherit">
          <div class="flight-top">
            <div style="flex:1">
              <div class="flight-duration">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                ${duration}
                ${flightNum ? `<span class="flight-num">Flight ${flightNum}</span>` : ""}
              </div>
              <div class="flight-stops">
                <span class="stop-dot"></span> ${stopsText}
              </div>
            </div>
            <div class="flight-price-large">
              <div class="price-amount">$${Math.round(price)}</div>
              <div class="price-currency">${currency}</div>
            </div>
          </div>
          <div class="flight-route">${segmentsHtml}</div>
          <div class="flight-bottom">
            <div class="flight-fare">
              <span class="fare-family">${cheapest.fareFamily || cheapest.fare?.family || "Standard"}</span>
              <span class="fare-info">
                ${cheapest.baggage?.hasCarryOnBag ? "✈ Carry-on included " : ""}
                ${cheapest.baggage?.hasCheckedBag ? "✓ Checked bag" : ""}
              </span>
            </div>
            <button class="book-flight-btn" data-offer-id="${cheapest.offerId || ""}" data-journey-id="${journey.id || ""}">
              Book — $${Math.round(price)}
            </button>
          </div>
        </a>`;

      flightResults.appendChild(card);
    });

    // Attach book handlers
    flightResults.querySelectorAll(".book-flight-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const offerId = btn.dataset.offerId;
        if (!offerId) return;
        window.location.href =
          `/flight-detail?offerId=${encodeURIComponent(offerId)}&legs=${encodeURIComponent(JSON.stringify(legs))}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&adults=${adults}`;
      });
    });

  } catch (err) {
    loader.style.display = "none";
    noResults.style.display = "block";
    noResults.innerHTML =
      `<p>Error: ${err.message}</p><a href="/" class="btn-primary">Try again</a>`;
    console.error(err);
  }
});
