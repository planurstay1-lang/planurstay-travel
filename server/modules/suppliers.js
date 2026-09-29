/**
 * Supplier switches ("close out" a supplier): admins turn any supplier off or on from /admin, instantly, no redeploy.
 * Stored in site_settings (key "suppliersOff", a JSON list) by admin.js; everything else just asks isOff(key).
 * A switched-off supplier disappears from search, hotel rooms and checkout; bookings already made are not touched.
 */
const SUPPLIERS = [
  { key: "liteapi_hotels", group: "Hotels", label: "LiteAPI hotels" },
  { key: "ratehawk", group: "Hotels", label: "RateHawk (WorldOta)", via: "Travellez" },
  { key: "duffel_stays", group: "Hotels", label: "Duffel Stays", via: "Travellez" },
  { key: "sabre_hotels", group: "Hotels", label: "Sabre hotels (all rates)", via: "Travellez" },
  { key: "sabre_pay_at_hotel", group: "Hotels", label: "Sabre pay-at-the-hotel rates only", via: "Travellez" },
  { key: "liteapi_flights", group: "Flights", label: "LiteAPI flights" },
  { key: "duffel", group: "Flights", label: "Duffel", via: "Travellez" },
  { key: "mystifly", group: "Flights", label: "Mystifly", via: "Travellez" },
  { key: "sabre_flights", group: "Flights", label: "Sabre flights", via: "Travellez" },
  { key: "sabre_cars", group: "Cars", label: "Sabre car rentals", via: "Travellez" },
];
const KEYS = new Set(SUPPLIERS.map(s => s.key));
let off = new Set(), gen = 0; // gen: bumps on every change, part of search cache keys so a switch applies at once

// Travellez hotel types and flight sources → switch keys
const HOTEL_TYPE_KEY = { 1: "duffel_stays", 3: "sabre_hotels", 4: "ratehawk" };
const FLIGHT_SOURCE_KEY = { duffel: "duffel", mystifly: "mystifly", myfarebox: "mystifly", sabre: "sabre_flights" };

module.exports = {
  SUPPLIERS,
  isOff: (key) => off.has(key),
  hotelTypeOff: (type) => off.has(HOTEL_TYPE_KEY[String(type)]),
  flightSourceOff: (src) => off.has(FLIGHT_SOURCE_KEY[String(src || "").toLowerCase()] || String(src || "").toLowerCase()),
  hotelSupplierOff: (name) => off.has({ duffel: "duffel_stays", ratehawk: "ratehawk", sabre: "sabre_hotels" }[name] || ""),
  setOff: (list) => { off = new Set((list || []).filter(k => KEYS.has(k))); gen++; return [...off]; },
  gen: () => gen,
  offList: () => [...off],
};
