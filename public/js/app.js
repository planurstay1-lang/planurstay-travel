// ─── Auth helpers ───
async function checkAuth() {
  const res = await fetch("/api/auth/me");
  return res.json();
}

async function login(email, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  return res.json();
}

async function signup(email, password) {
  const res = await fetch("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  return res.json();
}

function logout() {
  fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/";
}

// ─── Set min dates ───
document.addEventListener("DOMContentLoaded", () => {
  const today = new Date().toISOString().split("T")[0];
  document.querySelectorAll('input[type="date"]').forEach(el => {
    el.min = today;
  });

  // Set default dates: tomorrow check-in, day after checkout
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 3);

  const checkinEl = document.getElementById("hotelCheckin");
  const checkoutel = document.getElementById("hotelCheckout");
  if (checkinEl) checkinEl.value = tomorrow.toISOString().split("T")[0];
  if (checkoutel) checkoutel.value = dayAfter.toISOString().split("T")[0];

  const flightDepart = document.getElementById("flightDepart");
  const flightReturn = document.getElementById("flightReturn");
  if (flightDepart) flightDepart.value = tomorrow.toISOString().split("T")[0];
  if (flightReturn) flightReturn.value = dayAfter.toISOString().split("T")[0];

  // Check auth on load
  checkAuth().then(auth => {
    const userMenu = document.getElementById("userMenu");
    if (!userMenu) return;
    if (auth.loggedIn) {
      userMenu.textContent = auth.user.email;
      userMenu.href = "/my-bookings";
    } else {
      userMenu.textContent = "Sign In";
      userMenu.href = "/login";
    }
  });

  // Hotel search form
  const hotelForm = document.getElementById("hotelSearchForm");
  if (hotelForm) {
    hotelForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const city = document.getElementById("hotelCity").value;
      const country = document.getElementById("hotelCountry").value;
      const checkin = document.getElementById("hotelCheckin").value;
      const checkout = document.getElementById("hotelCheckout").value;
      const adults = document.getElementById("hotelAdults").value;

      window.location.href = `/hotels?city=${encodeURIComponent(city)}&country=${country}&checkin=${checkin}&checkout=${checkout}&adults=${adults}`;
    });
  }

  // Flight search form
  const flightForm = document.getElementById("flightSearchForm");
  if (flightForm) {
    flightForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const from = document.getElementById("flightFrom").value;
      const to = document.getElementById("flightTo").value;
      const depart = document.getElementById("flightDepart").value;
      const retun = document.getElementById("flightReturn").value;
      const adults = document.getElementById("flightAdults").value;

      const legs = [
        { origin: from.toUpperCase(), destination: to.toUpperCase(), date: depart, direction: "OUTBOUND" }
      ];
      if (retun && retun > depart) {
        legs.push({ origin: to.toUpperCase(), destination: from.toUpperCase(), date: retun, direction: "INBOUND" });
      }

      window.location.href = `/flights?from=${encodeURIComponent(from.toUpperCase())}&to=${encodeURIComponent(to.toUpperCase())}&depart=${depart}&return=${retun}&adults=${adults}`;
    });
  }
});
