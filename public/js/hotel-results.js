// ─── Hotel results page ───
document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const city = params.get("city") || "";
  const country = params.get("countryCode") || "US";
  const checkin = params.get("checkin") || "";
  const checkout = params.get("checkout") || "";
  const adults = params.get("adults") || "2";
  const rooms = params.get("rooms") || "1";
  const starMin = params.get("starMin") || "";
  const maxPrice = params.get("maxPrice") || "";
  const refundableOnly = params.get("refundableOnly") || "";

  document.getElementById("cityDisplay").textContent = city || "Travel destinations";

  const loader = document.getElementById("loader");
  const hotelList = document.getElementById("hotelList");
  const noResults = document.getElementById("noResults");
  const filterStars = document.getElementById("filterStars");
  const filterMaxPrice = document.getElementById("filterMaxPrice");
  const filterRefundable = document.getElementById("filterRefundable");
  const clearFiltersBtn = document.getElementById("clearFilters");
  const resultsMeta = document.getElementById("resultsMeta");

  // Sync filter UI with URL params
  if (filterStars) filterStars.value = starMin;
  if (filterMaxPrice) filterMaxPrice.value = maxPrice;
  if (filterRefundable) filterRefundable.checked = refundableOnly === "1";

  // Build meta string
  const filterParts = [];
  if (starMin) filterParts.push(`⭐ ${starMin}+ stars`);
  if (maxPrice) filterParts.push(`💰 under $${maxPrice}`);
  if (refundableOnly === "1") filterParts.push("🔄 refundable only");
  if (filterParts.length) {
    resultsMeta.textContent = "· " + filterParts.join(" · ");
  }

  // Clear filters button
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener("click", () => {
      window.location.href = `/hotels?city=${encodeURIComponent(city)}&countryCode=${country}&checkin=${checkin}&checkout=${checkout}&adults=${adults}`;
    });
  }

  // Filter change handlers — re-search with new params
  function handleFilterChange() {
    const newStarMin = filterStars?.value || "";
    const newMaxPrice = filterMaxPrice?.value || "";
    const newRefundable = filterRefundable?.checked ? "1" : "";
    const newParams = new URLSearchParams({
      city,
      countryCode: country,
      checkin,
      checkout,
      adults,
      rooms,
    });
    if (newStarMin) newParams.set("starMin", newStarMin);
    if (newMaxPrice) newParams.set("maxPrice", newMaxPrice);
    if (newRefundable) newParams.set("refundableOnly", newRefundable);
    window.location.href = `/hotels?${newParams.toString()}`;
  }

  if (filterStars) filterStars.addEventListener("change", handleFilterChange);
  if (filterMaxPrice) filterMaxPrice.addEventListener("change", handleFilterChange);
  if (filterRefundable) filterRefundable.addEventListener("change", handleFilterChange);

  loader.style.display = "block";
  hotelList.innerHTML = "";

  try {
    const res = await fetch(
      `/api/hotels/search?city=${encodeURIComponent(city)}&countryCode=${country}&checkin=${checkin}&checkout=${checkout}&adults=${adults}&rooms=${rooms}${starMin ? "&starMin=" + encodeURIComponent(starMin) : ""}${maxPrice ? "&maxPrice=" + encodeURIComponent(maxPrice) : ""}${refundableOnly ? "&refundableOnly=1" : ""}`
    );
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Search failed");

    // The backend returns { hotels, rates }
    const hotelsArr = data.hotels || [];
    const ratesArr = data.rates || [];

    if (!ratesArr.length) {
      loader.style.display = "none";
      noResults.style.display = "block";
      return;
    }

    loader.style.display = "none";

    // Build hotel→rates map
    const hotelMap = new Map();
    ratesArr.forEach((rate) => {
      let hotel = rate.hotel;
      if (!hotel && rate.hotelId) {
        hotel = hotelsArr.find((h) => String(h.id) === String(rate.hotelId));
      }
      if (!hotel) return;

      const hid = hotel.id;
      if (!hotelMap.has(hid)) {
        hotelMap.set(hid, { hotel, rates: [] });
      }
      hotelMap.get(hid).rates.push({ rate, hotel });
    });

    // Render each hotel
    hotelMap.forEach(({ hotel, rates }) => {
      // Flatten all rate options across room types
      const rateOptions = [];
      rates.forEach(({ rate }) => {
        const roomTypes = rate.roomTypes || [];
        roomTypes.forEach((rt) => {
          const rtRates = rt.rates || [];
          rtRates.forEach((r) => {
            let priceAmount = null;
            let priceCurrency = "USD";
            const retailRate = r.retailRate || r;
            if (retailRate.total && Array.isArray(retailRate.total)) {
              const t = retailRate.total[0];
              if (typeof t === "object" && t !== null) {
                priceAmount = t.amount;
                priceCurrency = t.currency || priceCurrency;
              } else if (typeof t === "number") {
                priceAmount = t;
              }
            } else if (typeof retailRate.amount === "number") {
              priceAmount = retailRate.amount;
              priceCurrency = retailRate.currency || priceCurrency;
            }

            if (priceAmount == null) return;

            // Apply client-side filter for refundable
            const isRefundable = r.cancellable;
            if (refundableOnly === "1" && !isRefundable) return;

            rateOptions.push({
              offerId: r.offerId || rt.offerId,
              roomName: rt.name || r.roomType || "Room",
              board: r.boardType || rt.boardType || "",
              price: priceAmount,
              currency: priceCurrency,
              cancellable: r.cancellable,
              rateObj: r,
            });
          });
        });
      });

      if (!rateOptions.length) return;

      // Cheapest rate for display
      rateOptions.sort((a, b) => a.price - b.price);
      const cheapest = rateOptions[0];

      // Star filter: skip hotels that don't meet star minimum
      const hotelStarRating = hotel.starRating || 0;
      if (starMin && hotelStarRating < parseInt(starMin)) return;

      // Max price filter: skip hotels whose cheapest rate exceeds max
      if (maxPrice && cheapest.price > parseFloat(maxPrice)) return;

      // Hotel image
      const img =
        hotel.main_photo ||
        hotel.mainPhoto ||
        hotel.photo ||
        hotel.images?.[0] ||
        "";

      // Rating
      const rating = hotel.rating || hotel.score || null;
      const starRating = hotel.starRating || null;

      // Address
      const addrParts = [];
      if (hotel.address) addrParts.push(hotel.address);
      if (hotel.city) addrParts.push(hotel.city);
      if (hotel.country) addrParts.push(hotel.country);
      const address = addrParts.join(", ") || "";

      // Stars HTML
      const starsHtml = starRating
        ? `<span class="meta-tag">⭐ ${starRating} stars</span>`
        : "";

      const refundable = cheapest.cancellable;
      const refundTag = refundable
        ? `<span class="meta-tag refundable">Refundable</span>`
        : `<span class="meta-tag non-refundable">Non-refundable</span>`;

      const card = document.createElement("div");
      card.className = "hotel-card";
      card.innerHTML =
        `<div class="hotel-image">${
          img
            ? `<img src="${img}" alt="${hotel.name || "Hotel"}" loading="lazy" onerror="this.style.display='none'">`
            : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--border);color:var(--text-muted);font-size:12px">No photo</div>`
        }</div>` +
        `<div class="hotel-info">${
          rating || starRating
            ? `<div class="hotel-rating-row">${
                rating ? `<span class="rating-score">${rating}</span>` : ""
              }${
                rating ? `<span class="rating-label">/10</span>` : ""
              }<div class="rating-stars">${
                starRating ? "★".repeat(Math.round(starRating / 2)) : ""
              }</div></div>`
            : ""
        }` +
        `<h3 class="hotel-name">${hotel.name || "Hotel"}</h3>` +
        (address ? `<div class="hotel-address">${address}</div>` : "") +
        `<div class="hotel-meta">${starsHtml}${refundTag}</div>` +
        `<div class="hotel-price-row">
          <span class="price-amount">$${Math.round(cheapest.price)}</span>
          <span class="price-currency">${cheapest.currency}</span>
          <span class="price-period"> / night · ${cheapest.roomName}</span>
        </div>` +
        `<div class="hotel-book-row">
          <button class="book-btn" data-offer-id="${cheapest.offerId}" data-hotel-id="${hotel.id}" data-city="${encodeURIComponent(city)}" data-country="${country}" data-checkin="${checkin}" data-checkout="${checkout}" data-adults="${adults}" data-rooms="${rooms}">Book Now</button>
          <button class="book-btn outline" data-offer-id="${cheapest.offerId}" data-hotel-id="${hotel.id}" data-city="${encodeURIComponent(city)}" data-country="${country}" data-checkin="${checkin}" data-checkout="${checkout}" data-adults="${adults}" data-rooms="${rooms}">View Deal</button>
        </div>`;

      hotelList.appendChild(card);
    });

    // Attach handlers — go to hotel detail page
    hotelList.querySelectorAll(".book-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const offerId = btn.dataset.offerId;
        const hotelId = btn.dataset.hotelId;
        const url =
          `/hotel/${hotelId}?offerId=${encodeURIComponent(offerId)}&city=${encodeURIComponent(city)}&countryCode=${country}&checkin=${checkin}&checkout=${checkout}&adults=${adults}&rooms=${rooms}`;
        window.location.href = url;
      });
    });

  } catch (err) {
    loader.style.display = "none";
    noResults.style.display = "block";
    noResults.innerHTML =
      `<p>Something went wrong: ${err.message}</p><a href="/" class="btn-primary">Try again</a>`;
    console.error(err);
  }
});
