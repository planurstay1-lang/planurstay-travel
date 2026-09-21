// ─── Flight booking page ───
document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const offerId = params.get("offerId");
  const legsParam = params.get("legs");

  const loader = document.getElementById("loader");
  const flightDetail = document.getElementById("flightDetail");
  const noFlight = document.getElementById("noFlight");
  const paymentSection = document.getElementById("paymentSection");
  const paymentPortal = document.getElementById("paymentPortal");
  const paymentSummary = document.getElementById("paymentSummary");
  const initPaymentBtn = document.getElementById("initPaymentBtn");

  if (!offerId || !legsParam) {
    noFlight.style.display = "block";
    return;
  }

  const legs = JSON.parse(decodeURIComponent(legsParam));

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

  // Check auth
  const auth = await checkAuth();

  // ─── 1. Get flight offer details ───
  loader.style.display = "block";
  try {
    const searchRes = await fetch("/api/flights/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs,
        adults: 1,
        currency: "USD",
        country: "US",
      }),
    });
    const searchData = await searchRes.json();

    if (!searchRes.ok || searchData.error) {
      throw new Error(searchData.error?.message || "Search failed");
    }

    const journeys = searchData.data?.[0]?.journeys || [];
    const journey = journeys.find((j) => {
      return j.offers?.some((o) => o.offerId === offerId);
    });

    if (!journey) throw new Error("Flight not found");

    const offer = journey.offers.find((o) => o.offerId === offerId);
    if (!offer) throw new Error("Offer not found");

    const p = offer.pricing?.display;

    // Display flight route
    const segs = journey.segments;
    document.getElementById("bigAirlineLogo").src =
      segs[0]?.carrier?.marketingLogo || "";
    document.getElementById("bigDepartTime").textContent = new Date(
      segs[0]?.departureTime || ""
    ).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("bigFrom").textContent = segs[0]?.originCode || "";
    document.getElementById("bigTo").textContent = segs[0]?.destinationCode || "";
    document.getElementById("bigArriveTime").textContent = new Date(
      segs[0]?.arrivalTime || ""
    ).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    if (segs.length > 1) {
      document.getElementById("bigConnector").style.display = "block";
      document.getElementById("bigSeg2").style.display = "block";
      document.getElementById("bigAirlineLogo2").src =
        segs[1]?.carrier?.marketingLogo || "";
      document.getElementById("bigDepartTime2").textContent = new Date(
        segs[1]?.departureTime || ""
      ).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      document.getElementById("bigFrom2").textContent = segs[1]?.originCode || "";
      document.getElementById("bigTo2").textContent = segs[1]?.destinationCode || "";
      document.getElementById("bigArriveTime2").textContent = new Date(
        segs[1]?.arrivalTime || ""
      ).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    }

    document.getElementById("fdmDuration").textContent =
      journey.totalDuration?.iso8601 || "";
    document.getElementById("fdmStops").textContent =
      segs.length - 1 === 0
        ? "Nonstop"
        : `${segs.length - 1} stop${segs.length - 1 > 1 ? "s" : ""}`;
    document.getElementById("fdmAirline").textContent =
      segs[0]?.carrier?.marketingName || "Unknown";

    // Meal info from segment amenities
    const mealAmenity = segs[0]?.segmentAmenities?.find(
      (a) => a.amenities?.some((am) => am.category === "food")
    );
    document.getElementById("fdmMeal").textContent =
      mealAmenity && mealAmenity.amenities.some((a) => a.category === "food")
        ? (mealAmenity.amenities.find((a) => a.category === "food")?.details ||
            "Meal available")
        : "Not specified";

    // Check-in info (online check-in available?)
    const checkinAmenity = segs[0]?.segmentAmenities?.find(
      (a) => a.amenities?.some((am) => am.category === "checkin")
    );
    document.getElementById("fdmCheckin").textContent =
      checkinAmenity
        ? checkinAmenity.amenities
            .filter((a) => a.category === "checkin")
            .map((a) => a.details || "Available")
            .join(", ")
        : "Not specified";

    document.getElementById("flightPrice").textContent = `$${p?.total?.toFixed(2) || "N/A"}`;
    document.getElementById("flightCurrency").textContent = p?.currency || "USD";
    document.getElementById("fareFamily").textContent =
      offer.fare?.family || "Economy";

    // Baggage
    const baggage = offer.baggage || {};
    const baggageHtml = [];
    if (baggage.hasCarryOnBag)
      baggageHtml.push("✓ Carry-on bag included");
    if (baggage.hasCheckedBag)
      baggageHtml.push("✓ Checked bag included");
    baggage.paid?.forEach((b) => {
      baggageHtml.push(
        `+ ${b.description}: $${b.pricing?.display?.amount?.toFixed(2)}`
      );
    });
    // Include bag count info if available
    if (baggage.included) {
      baggage.included.forEach((b) => {
        if (b.pieces && b.pieces > 0) {
          baggageHtml.push(
            `✓ ${b.description} (x${b.pieces}) — free`
          );
        }
      });
    }
    document.getElementById("baggageInfo").innerHTML = baggageHtml.length
      ? baggageHtml.map((b) => `<p>${b}</p>`).join("")
      : "<p>No baggage information available</p>";

    // Layover/connection info
    if (segs.length > 1) {
      const layoverHtml = [];
      for (let i = 0; i < segs.length - 1; i++) {
        const arrTime = new Date(segs[i].arrivalTime || "");
        const depTime = new Date(segs[i + 1].departureTime || "");
        const layoverMinutes =
          (depTime.getTime() - arrTime.getTime()) / 60000;
        const layoverHours = Math.floor(layoverMinutes / 60);
        const layoverMins = Math.round(layoverMinutes % 60);
        const layoverStr = layoverHours > 0
          ? `${layoverHours}h ${layoverMins}m`
          : `${layoverMins}m`;
        layoverHtml.push(
          `<p>Stop ${i + 1}: ${segs[i].destinationCode} → ${segs[i + 1].originCode} · ${layoverStr} layover</p>`
        );
      }
      const existingBaggage = document.getElementById("baggageInfo");
      existingBaggage.innerHTML =
        layoverHtml.join("") +
        (baggageHtml.length
          ? `<hr style="margin:12px 0;border:none;border-top:1px solid var(--border)">` +
            baggageHtml.map((b) => `<p>${b}</p>`).join("")
          : "");
    }

    // Cancellation
    const terms = offer.terms || {};
    const cancelHtml = [];
    if (terms.refundable) cancelHtml.push("✓ Refundable");
    else cancelHtml.push("✗ Non-refundable");
    if (terms.changeable) cancelHtml.push("✓ Changes allowed");
    else cancelHtml.push("✗ No changes");
    if (terms.hasChangeFee) cancelHtml.push("Change fee applies");
    if (terms.summary) {
      terms.summary.forEach((s) => {
        cancelHtml.push(
          `<p style="color:${
            s.level === "danger"
              ? "#ef4444"
              : s.level === "warning"
              ? "#f59e0b"
              : "#059669"
          };font-size:13px;">${s.message}</p>`
        );
      });
    }
    document.getElementById("cancellationInfo").innerHTML = cancelHtml.join("");

    // Seat selection
    const seats = offer.seats || {};
    const seatHtml = [];
    if (seats.seatReservation?.status === "included")
      seatHtml.push("✓ Seat selection included");
    else if (seats.seatReservation?.status === "chargeable")
      seatHtml.push(
        `+ Seat selection: $${seats.seatReservation?.pricing?.display?.amount?.toFixed(2)}`
      );
    else seatHtml.push("Seat selection not available");
    if (seats.extraRoom?.status === "chargeable")
      seatHtml.push(
        `+ Extra legroom: $${seats.extraRoom?.pricing?.display?.amount?.toFixed(2)}`
      );
    document.getElementById("seatInfo").innerHTML = seatHtml.join("");

    loader.style.display = "none";
    flightDetail.style.display = "block";
  } catch (err) {
    loader.style.display = "none";
    noFlight.style.display = "block";
    noFlight.innerHTML = `<p>${err.message}</p><a href="/flights" class="btn-primary">Search again</a>`;
    return;
  }

  // ─── 2. Prebook on button click ───
  initPaymentBtn.addEventListener("click", async () => {
    // Auth check — force sign-up
    if (!auth.loggedIn) {
      initPaymentBtn.textContent = "Proceed to Payment";
      initPaymentBtn.disabled = false;
      alert(
        "You need to sign in to book flights. Please sign in or create an account."
      );
      window.location.href = `/login?redirect=${encodeURIComponent(
        window.location.href
      )}`;
      return;
    }

    initPaymentBtn.textContent = "Processing...";
    initPaymentBtn.disabled = true;

    const firstName = document.getElementById("fFirstName").value;
    const lastName = document.getElementById("fLastName").value;
    const email = document.getElementById("fEmail").value;
    const phone = document.getElementById("fPhone").value;
    const nationality = document.getElementById("fNationality").value;
    const birthday = document.getElementById("fBirthday").value;

    try {
      // Read voucher code from the form
      const voucherCodeEl = document.getElementById("fVoucher");
      const voucherCode = voucherCodeEl ? voucherCodeEl.value.trim() : "";

      const prebookRes = await fetch("/api/flights/prebook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offerId,
          usePaymentSdk: true,
          voucherCode,
          contact: {
            firstName,
            lastName,
            email,
            phoneNumber: phone,
          },
          passengers: [
            {
              firstName,
              lastName,
              email,
              nationality,
              type: "ADT",
              birthday,
              gender: "M",
              documentType: "passport",
              documentNumber: "TEST123456",
              documentExpiration: "2030-01-01",
              documentIssueCountry: "US",
            },
          ],
        }),
      });

      const prebookData = await prebookRes.json();
      if (!prebookRes.ok || !prebookData.success || !prebookData.data) {
        throw new Error(prebookData.error?.message || "Prebook failed");
      }

      const pb = prebookData.data;
      paymentSection.style.display = "block";
      flightDetail.style.display = "none";

      // Summary
      paymentSummary.innerHTML = `
        <div class="summary-row">
          <span class="summary-label">Route</span>
          <span class="summary-value">
            ${legs[0].origin} → ${legs[0].destination}
            ${legs.length > 1 ? ` (${legs[1].origin} → ${legs[1].destination})` : ""}
          </span>
        </div>
        <div class="summary-row">
          <span class="summary-label">Depart</span>
          <span class="summary-value">${legs[0].date}</span>
        </div>
        ${legs.length > 1 ? `
        <div class="summary-row">
          <span class="summary-label">Return</span>
          <span class="summary-value">${legs[1].date}</span>
        </div>
        ` : ""}
        ${pb.voucherTotalAmount
          ? `
        <div class="summary-row summary-discount">
          <span class="summary-label">Voucher</span>
          <span class="summary-value">−$${pb.voucherTotalAmount.toFixed(2)}</span>
        </div>
        `
          : ""}
        <div class="summary-row">
          <span class="summary-label">Total</span>
          <span class="summary-value summary-price">${pb.currency} ${pb.price}</span>
        </div>
      `;

      // Initialize payment SDK with correct publicKey
      window.liteAPIPayment = new LiteAPIPayment({
        publicKey: paymentConfig.publicKey || "sandbox",
        appearance: { theme: "flat" },
        options: { business: { name: "PlanurStay" } },
        targetElement: "#paymentPortal",
        secretKey: pb.secretKey,
        returnUrl: `${window.location.origin}/confirmation?prebookId=${pb.prebookId}&transactionId=${pb.transactionId}&type=flight`,
      });
      window.liteAPIPayment.handlePayment();

    } catch (err) {
      alert(`Prebook failed: ${err.message}`);
      initPaymentBtn.textContent = "Proceed to Payment";
      initPaymentBtn.disabled = false;
    }
  });
});
