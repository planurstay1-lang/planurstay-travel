/**
 * Reference Data Engine — LiteAPI reference endpoints
 *
 * Provides: IATA codes, airlines, countries, cities, currencies,
 * hotel chains, facilities, room amenities, room types, languages, weather
 */

const liteApi = require("liteapi-node-sdk");

/**
 * Get IATA codes (airports/cities)
 * LiteAPI docs: GET /data/iataCodes — airport and city IATA codes
 * SDK method: getIataCodes(query, limit) — returns all codes, filtered by query string
 */
async function getIataCodes(query, limit = 50) {
  const key = process.env.SAND_API_KEY || process.env.PROD_API_KEY;
  if (!key) return { success: false, error: { code: 500, message: "No API key configured" } };

  try {
    // Use the LiteAPI SDK directly — it handles auth
    const sdk = require("liteapi-node-sdk")(key);
    const result = await sdk.getIataCodes(query || "", limit);
    if (result.status === "failed") {
      return { success: false, error: { code: 500, message: "Failed to fetch IATA codes" } };
    }
    // Transform to clean format
    const codes = (result.data || []).map(item => ({
      code:        item.code,        // IATA code (e.g. "JFK")
      name:        item.name,        // Airport/city name
      latitude:    item.latitude,
      longitude:   item.longitude,
      countryCode: item.countryCode,
      // Also provide city name for autocomplete convenience
      city:        item.name,
      type:        item.type || "airport",
    }));
    return { success: true, data: codes };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Search IATA codes by airport/city name (autocomplete)
 * Used for flight booking form — type "JFK" or "New York" → get matches
 */
async function searchIataCodes(q) {
  if (!q || q.trim().length < 1) {
    return { success: false, error: { code: 400, message: "Query required" } };
  }

  const key = process.env.SAND_API_KEY || process.env.PROD_API_KEY;
  if (!key) return { success: false, error: { code: 500, message: "No API key configured" } };

  try {
    const sdk = require("liteapi-node-sdk")(key);
    const query = q.trim();

    // First try: exact code match (e.g. "JFK", "LHR")
    const codeResult = await sdk.getIataCodes(query.toUpperCase(), 50);
    if (codeResult.status === "failed") {
      return { success: false, error: { code: 500, message: "Failed to fetch IATA codes" } };
    }
    const codeMatches = (codeResult.data || []).filter(c => c.code === query.toUpperCase());
    if (codeMatches.length > 0) {
      return { success: true, data: codeMatches.map(c => ({
        code: c.code, name: c.name, latitude: c.latitude, longitude: c.longitude,
        countryCode: c.countryCode, city: c.name, type: c.type || "airport",
      })) };
    }

    // Second try: name search — SDK filters by name substring
    const nameResult = await sdk.getIataCodes(query, 50);
    if (nameResult.status === "failed") {
      return { success: false, error: { code: 500, message: "Failed to fetch IATA codes" } };
    }
    const nameMatches = (nameResult.data || []).filter(c =>
      c.name.toLowerCase().includes(query.toLowerCase())
    );

    if (nameMatches.length === 0) {
      return { success: false, error: { code: 404, message: `No IATA codes found for "${q}"` } };
    }

    return {
      success: true,
      data: nameMatches.map(c => ({
        code: c.code, name: c.name, latitude: c.latitude, longitude: c.longitude,
        countryCode: c.countryCode, city: c.name, type: c.type || "airport",
      }))
    };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get all airlines
 * Docs: GET /data/flights/airlines — list all airlines
 */
async function getAllAirlines() {
  const key = process.env.SAND_API_KEY || process.env.PROD_API_KEY;
  if (!key) return { success: false, error: { code: 500, message: "No API key configured" } };

  try {
    const res = await fetch(`https://api.liteapi.travel/v3.0/data/flights/airlines`, {
      method: "GET",
      headers: {
        "X-API-Key": key,
        "Accept": "application/json",
      },
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: { code: res.status, message: data.error?.message || "Failed to fetch airlines" } };
    }
    const raw = data.data || [];
    // The response is { data: [{ airlines: [...] }] }
    const airlines = (raw[0] && raw[0].airlines) || raw;
    return { success: true, data: airlines };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get a single airline by IATA code
 * Docs: GET /data/flights/airlines/iatas/{iataCode}
 */
async function getAirlineByIata(iataCode) {
  if (!iataCode || iataCode.length !== 2) {
    return { success: false, error: { code: 400, message: "2-letter IATA code required" } };
  }
  const key = process.env.SAND_API_KEY || process.env.PROD_API_KEY;
  if (!key) return { success: false, error: { code: 500, message: "No API key configured" } };

  try {
    const res = await fetch(`https://api.liteapi.travel/v3.0/data/flights/airlines/iatas/${iataCode}`, {
      method: "GET",
      headers: {
        "X-API-Key": key,
        "Accept": "application/json",
      },
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: { code: res.status, message: data.error?.message || "Airline not found" } };
    }
    const airline = (data.data && data.data[0]) ? data.data[0].airline : data.data;
    return {
      success: true,
      data: {
        iata:      airline.iata,
        icao:      airline.icao,
        name:      airline.name,
        callsign:  airline.callsign,
        country:   airline.country,
        alliance:  airline.alliance,
        active:    airline.active,
        logo:      airline.logo,
      }
    };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get countries
 * Docs: GET /data/countries
 */
async function getCountries() {
  const key = process.env.SAND_API_KEY || process.env.PROD_API_KEY;
  if (!key) return { success: false, error: { code: 500, message: "No API key configured" } };

  try {
    const res = await fetch("https://api.liteapi.travel/v3.0/data/countries", {
      method: "GET",
      headers: { "X-API-Key": key, "Accept": "application/json" },
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: { code: res.status, message: data.error?.message || "Failed to fetch countries" } };
    }
    return { success: true, data: data.data || data };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get cities in a country
 * Docs: GET /data/cities?countryCode={code}
 */
async function getCities(countryCode) {
  if (!countryCode) {
    return { success: false, error: { code: 400, message: "countryCode required" } };
  }
  const key = process.env.SAND_API_KEY || process.env.PROD_API_KEY;
  if (!key) return { success: false, error: { code: 500, message: "No API key configured" } };

  try {
    const res = await fetch(`https://api.liteapi.travel/v3.0/data/cities?countryCode=${encodeURIComponent(countryCode)}`, {
      method: "GET",
      headers: { "X-API-Key": key, "Accept": "application/json" },
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: { code: res.status, message: data.error?.message || "Failed to fetch cities" } };
    }
    return { success: true, data: data.data || data };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get currencies
 * Docs: GET /data/currencies
 */
async function getCurrencies() {
  const key = process.env.SAND_API_KEY || process.env.PROD_API_KEY;
  if (!key) return { success: false, error: { code: 500, message: "No API key configured" } };

  try {
    const res = await fetch("https://api.liteapi.travel/v3.0/data/currencies", {
      method: "GET",
      headers: { "X-API-Key": key, "Accept": "application/json" },
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: { code: res.status, message: data.error?.message || "Failed to fetch currencies" } };
    }
    return { success: true, data: data.data || data };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get hotel chains
 * Docs: GET /data/chains
 */
async function getChains() {
  try {
    const result = await liteApi.getChains();
    if (result.status === "failed") {
      return { success: false, error: { code: 500, message: "Failed to fetch hotel chains" } };
    }
    return { success: true, data: result.data };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get hotel facilities
 * Docs: GET /data/facilities
 */
async function getFacilities() {
  try {
    const result = await liteApi.getFacilities();
    if (result.status === "failed") {
      return { success: false, error: { code: 500, message: "Failed to fetch facilities" } };
    }
    return { success: true, data: result.data };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get room types
 * Docs: GET /data/roomTypes  (or via room-views/amenities)
 */
async function getRoomTypes() {
  try {
    const result = await liteApi.getRoomTypes();
    if (result.status === "failed") {
      return { success: false, error: { code: 500, message: "Failed to fetch room types" } };
    }
    return { success: true, data: result.data };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get room amenities
 * Docs: GET /data/roomAmenities
 */
async function getRoomAmenities() {
  try {
    const result = await liteApi.getRoomAmenities();
    if (result.status === "failed") {
      return { success: false, error: { code: 500, message: "Failed to fetch room amenities" } };
    }
    return { success: true, data: result.data };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get languages
 * Docs: GET /data/languages
 */
async function getLanguages() {
  try {
    const result = await liteApi.getLanguages();
    if (result.status === "failed") {
      return { success: false, error: { code: 500, message: "Failed to fetch languages" } };
    }
    return { success: true, data: result.data };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get weather for a location
 * Docs: GET /data/weather — requires lat/lon
 */
async function getWeather(lat, lon) {
  if (!lat || !lon) {
    return { success: false, error: { code: 400, message: "lat and lon required" } };
  }
  const key = process.env.SAND_API_KEY || process.env.PROD_API_KEY;
  if (!key) return { success: false, error: { code: 500, message: "No API key configured" } };
  try {
    const today = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 7);
    const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const url = `https://api.liteapi.travel/v3.0/data/weather?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&startDate=${startDate.toISOString().split('T')[0]}&endDate=${endDate.toISOString().split('T')[0]}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": key, Accept: "application/json" },
    });
    const json = await res.json();
    if (!res.ok) {
      const err = json.error || { code: res.status, message: "Failed to fetch weather" };
      return { success: false, error: err };
    }
    return { success: true, data: json.data || json };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

/**
 * Get hotel types
 * Docs: GET /data/hotelTypes
 */
async function getHotelTypes() {
  try {
    const result = await liteApi.getHotelTypes();
    if (result.status === "failed") {
      return { success: false, error: { code: 500, message: "Failed to fetch hotel types" } };
    }
    return { success: true, data: result.data };
  } catch (err) {
    return { success: false, error: { code: 500, message: err.message } };
  }
}

module.exports = {
  // IATA codes
  getIataCodes,
  searchIataCodes,

  // Airlines
  getAllAirlines,
  getAirlineByIata,

  // Geographic
  getCountries,
  getCities,

  // Reference
  getCurrencies,
  getChains,
  getFacilities,
  getRoomTypes,
  getRoomAmenities,
  getLanguages,
  getWeather,
  getHotelTypes,
};
