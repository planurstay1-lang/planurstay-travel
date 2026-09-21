// ─── Hotel booking flow ───
document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const hotelId = params.get("id");
  const initialOfferId = params.get("offerId");
  const checkin = params.get("checkin");
  const checkout = params.get("checkout");
  const adults = params.get("adults");
  const rooms = params.get("rooms");

  const loader = document.getElementById("loader");
  const hotelDetail = document.getElementById("hotelDetail");
  const noHotel = document.getElementById("noHotel");
  const ratesLoader = document.getElementById("ratesLoader");
  const ratesList = document.getElementById("ratesList");
  const paymentSection = document.getElementById("paymentSection");
  const paymentPortal = document.getElementById("paymentPortal");
  const paymentSummary = document.getElementById("paymentSummary");

  // Check auth — force sign-up before booking
  let auth = await checkAuth();
  if (!auth.loggedIn) {
    // Show a friendly prompt to sign up, don't block browsing
    console.log("User not logged in — booking will require sign-up");
  }

  // ─── Fetch payment config to get correct publicKey ───
  let paymentConfig = { publicKey: "sandbox" };
  try {
    const cfgRes = await fetch("/api/payment-sdk/config");
    const cfgData = await cfgRes.json();
    if (cfgData.configTemplate) {
      paymentConfig = cfgData.configTemplate;
    }
  } catch (e) {
    console.warn("Could not fetch payment config, using sandbox default");
  }

  // ─── 1. Load hotel details ───
  if (!hotelId) {
    noHotel.style.display = "block";
    return;
  }

  loader.style.display = "block";
  try {
    const res = await fetch(`/api/hotels/${hotelId}`);
    const hotel = await res.json();

    document.getElementById("hotelMainPhoto").src = hotel.main_photo || "";
    document.getElementById("hotelName").textContent = hotel.name;
    document.getElementById("hotelAddress").textContent =
      `${hotel.address || ""}, ${hotel.city || ""}, ${hotel.country || ""}`;
    document.getElementById("hotelRating").textContent = hotel.rating || "N/A";
    document.getElementById("hotelStars").textContent =
      hotel.starRating ? `⭐ ${hotel.starRating} stars` : "";
    document.getElementById("hotelCity").textContent = hotel.city || "";
    document.getElementById("hotelDescription").textContent =
      hotel.hotelDescription || "No description available.";

    loader.style.display = "none";
    hotelDetail.style.display = "block";
  } catch (err) {
    loader.style.display = "none";
    noHotel.style.display = "block";
    return;
  }

  // ─── 2. Load rates ───
  if (initialOfferId) {
    ratesLoader.style.display = "block";
    try {
      const res = await fetch(
        `/api/hotels/search?city=${params.get("city") || ""}&countryCode=${params.get("country") || "US"}&checkin=${checkin}&checkout=${checkout}&adults=${adults}&rooms=${rooms}`
      );
      const data = await res.json();
      const hotelRates = data.rates.find((r) => r.hotelId === hotelId);
      if (hotelRates) {
        renderRates(hotelRates.roomTypes, initialOfferId);
      } else {
        ratesList.innerHTML = `<p>No rates available.</p>`;
      }
    } catch (err) {
      ratesList.innerHTML = `<p>Could not load rates. Please try again.</p>`;
    }
    ratesLoader.style.display = "none";
  }

  // ─── 3. Render rates ───
  function renderRates(roomTypes, selectedOfferId) {
    ratesList.innerHTML = "";
    let hasRates = false;

    roomTypes.forEach((rt) => {
      const roomName = rt.name || "Room";
      rt.rates.forEach((rate) => {
        const price = rate.retailRate?.total?.[0];
        const msp = rate.retailRate?.suggestedSellingPrice?.[0];
        if (!price) return;
        hasRates = true;

        const isRefundable =
          rate.cancellationPolicies?.refundableTag === "RFN";
        const cancelInfo = rate.cancellationPolicies?.cancelPolicyInfos?.[0];
        const cancelText = cancelInfo
          ? `Cancel by ${new Date(cancelInfo.cancelTime).toLocaleDateString()} — fee: $${cancelInfo.amount}`
          : "Non-refundable";

        const card = document.createElement("div");
        card.className = `rate-card ${
          isRefundable ? "refundable" : "non-refundable"
        }`;
        if (selectedOfferId === rt.offerId) {
          card.classList.add("selected");
        }

        card.innerHTML = `
          <div class="rate-header">
            <h3 class="rate-room-name">${rate.name || roomName}</h3>
            <span class="rate-board">${rate.boardName || rate.boardType}</span>
          </div>
          <div class="rate-price-row">
            <div class="rate-price">
              <span class="price-amount">$${price.amount?.toFixed(2)}</span>
              <span class="price-currency">${price.currency || "USD"}</span>
              <span class="price-period">/ night</span>
            </div>
            ${
              msp && msp.amount && msp.amount !== price.amount
                ? `
              <div class="rate-msp">
                <span class="msp-label">Standard price: </span>
                <span class="msp-value">$${msp.amount.toFixed(2)}</span>
                <span class="msp-save">You save $${(msp.amount - price.amount).toFixed(2)}</span>
              </div>
            `
                : ""
            }
          </div>
          <div class="rate-policies">
            <span class="${
              isRefundable ? "tag-refund" : "tag-non-refund"
            }">
              ${isRefundable ? "Refundable" : "Non-refundable"}
            </span>
            <span class="policy-text">${cancelText}</span>
          </div>
          <button class="btn-primary select-rate-btn" data-offer-id="${
            rt.offerId
          }" data-rate-id="${rate.rateId}">
            Select Room — $${price.amount.toFixed(2)}
          </button>
        `;
        ratesList.appendChild(card);
      });
    });

    if (!hasRates) {
      ratesList.innerHTML =
        `<p style="padding:16px;color:#6b7280;">No rooms available for these dates.</p>`;
      return;
    }

    // Attach select handlers
    ratesList.querySelectorAll(".select-rate-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const offerId = btn.dataset.offerId;
        await proceedToPrebook(offerId, selectedOfferId);
      });
    });
  }

  // ─── Retry helper ───
  async function retryWithFallback(offerIds, allRoomTypes) {
    // Try the next cheapest room if prebook fails
    for (const oid of offerIds) {
      if (oid === initialOfferId) continue;
      try {
        ratesLoader.style.display = "block";
        ratesList.innerHTML =
          `<p style="padding:12px;color:var(--text-secondary)">Trying alternate room...</p>`;
        const res = await fetch("/api/hotels/prebook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offerId: oid }),
        });
        const data = await res.json();
        if (res.ok && data.data?.prebookId) {
          ratesLoader.style.display = "none";
          return data.data;
        }
      } catch (e) {
        console.warn("Fallback prebook attempt failed for", oid, e);
      }
    }
    ratesLoader.style.display = "none";
    return null;
  }

  // ─── 4. Prebook with retry ───
  async function proceedToPrebook(offerId) {
    // Auth check — force sign-up
    if (!auth.loggedIn) {
      ratesLoader.style.display = "none";
      ratesList.innerHTML = `
        <div style="padding:20px;text-align:center;background:var(--primary-light);border-radius:var(--radius);color:var(--primary-dark)">
          <h3 style="margin:0 0 8px;font-size:18px">Sign in to book</h3>
          <p style="margin:0 0 16px;color:var(--text-secondary);font-size:14px">
            You need an account to complete your booking. It's free and gives you better rates.
          </p>
          <a href="/login?redirect=${encodeURIComponent(window.location.href)}" class="btn-primary" style="display:inline-block">
            Sign In / Create Account
          </a>
        </div>
      `;
      return;
    }

    ratesLoader.style.display = "block";
    ratesList.innerHTML = "";
    try {
      // Read voucher code from the form
      const voucherCodeEl = document.getElementById("voucherCode");
      const voucherCode = voucherCodeEl ? voucherCodeEl.value.trim() : "";

      const res = await fetch("/api/hotels/prebook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId, voucherCode }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Prebook failed — offer retry with other rooms
        throw new Error(data.error || "Prebook failed");
      }

      const prebookData = data.data;
      if (!prebookData || !prebookData.prebookId) {
        throw new Error("Invalid prebook response");
      }

      // Show payment section
      ratesList.style.display = "none";
      ratesLoader.style.display = "none";
      paymentSection.style.display = "block";

      // Show summary
      paymentSummary.innerHTML = `
        <div class="summary-row">
          <span class="summary-label">Room</span>
          <span class="summary-value">${prebookData.roomTypes?.[0]?.name || "Selected room"}</span>
        </div>
        <div class="summary-row">
          <span class="summary-label">Check-in / Check-out</span>
          <span class="summary-value">${prebookData.checkin} → ${prebookData.checkout}</span>
        </div>
        ${
          prebookData.voucherTotalAmount
            ? `
        <div class="summary-row summary-discount">
          <span class="summary-label">Voucher</span>
          <span class="summary-value">−$${prebookData.voucherTotalAmount.toFixed(2)}</span>
        </div>
        `
            : ""
        }
        <div class="summary-row">
          <span class="summary-label">Total</span>
          <span class="summary-value summary-price">${prebookData.currency} ${prebookData.price}</span>
        </div>
      `;

      // Initialize payment SDK with correct publicKey
      initializePaymentSDK(prebookData);
    } catch (err) {
      ratesLoader.style.display = "none";

      // If prebook failed, offer retry with other rooms
      const allBtns = ratesList.querySelectorAll(".select-rate-btn");
      const otherOfferIds = Array.from(allBtns)
        .map((b) => b.dataset.offerId)
        .filter((id) => id && id !== offerId);

      if (otherOfferIds.length > 0) {
        ratesList.innerHTML = `
          <div style="padding:20px;text-align:center">
            <p style="color:#ef4444;margin:0 0 12px;font-weight:600">
              Couldn't reserve this room: ${err.message}
            </p>
            <p style="color:var(--text-secondary);margin:0 0 16px;font-size:14px">
              Trying the next best room...
            </p>
            <div class="spinner" style="margin:0 auto"></div>
          </div>
        `;
        // Retry with fallback
        retryWithFallback(otherOfferIds, null).then((fallbackData) => {
          if (fallbackData) {
            ratesList.style.display = "none";
            paymentSection.style.display = "block";
            paymentSummary.innerHTML = `
              <div class="summary-row">
                <span class="summary-label">Room</span>
                <span class="summary-value">${fallbackData.roomTypes?.[0]?.name || "Alternate room"}</span>
              </div>
              <div class="summary-row">
                <span class="summary-label">Check-in / Check-out</span>
                <span class="summary-value">${fallbackData.checkin} → ${fallbackData.checkout}</span>
              </div>
              <div class="summary-row">
                <span class="summary-label">Total</span>
                <span class="summary-value summary-price">${fallbackData.currency} ${fallbackData.price}</span>
              </div>
            `;
            initializePaymentSDK(fallbackData);
          } else {
            ratesList.innerHTML = `
              <p style="color:red;padding:16px;text-align:center">
                All rooms are unavailable. Please try different dates or search again.
              </p>
              <a href="/hotels" class="btn-primary" style="display:block;text-align:center;padding:12px">Search again</a>
            `;
          }
        });
      } else {
        ratesList.innerHTML = `
          <p style="color:red;padding:16px">Error: ${err.message}</p>
          <a href="/hotels" class="btn-primary" style="display:block;text-align:center;padding:12px;margin-top:8px">Search again</a>
        `;
      }
    }
  }

  // ─── 5. Payment SDK ───
  let currentPrebookId = null;
  let currentTransactionId = null;

  function initializePaymentSDK(prebookData) {
    currentPrebookId = prebookData.prebookId;
    currentTransactionId = prebookData.transactionId;

    const config = {
      publicKey: paymentConfig.publicKey || "sandbox",
      appearance: { theme: "flat" },
      options: {
        business: { name: "PlanurStay" },
      },
      targetElement: "#paymentPortal",
      secretKey: prebookData.secretKey,
      returnUrl: `${window.location.origin}/confirmation?prebookId=${
        prebookData.prebookId
      }&transactionId=${prebookData.transactionId}&type=hotel`,
    };

    window.liteAPIPayment = new LiteAPIPayment(config);
    window.liteAPIPayment.handlePayment();
  }

  // ─── 6. Submit booking form ───
  const bookForm = document.querySelector("#paymentForm");
  if (bookForm) {
    // We handle the payment SDK's redirect — user comes back to /confirmation
  }
});
