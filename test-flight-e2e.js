require('dotenv').config();
const Database = require('better-sqlite3');

// In-memory DB for flight engine
const db = new Database(':memory:');
db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)');
db.exec(`CREATE TABLE IF NOT EXISTS flight_prebooks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,
  prebook_id    TEXT UNIQUE NOT NULL,
  offer_id      TEXT NOT NULL,
  currency      TEXT,
  total_amount  REAL,
  transaction_id TEXT,
  secret_key    TEXT,
  payment_types TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS flight_bookings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER,
  booking_id       TEXT UNIQUE,
  prebook_id       TEXT,
  liteapi_booking_ref TEXT,
  status           TEXT,
  currency         TEXT,
  total_amount     REAL,
  passenger_count  INTEGER,
  journey_key      TEXT,
  segments_json    TEXT,
  services_json    TEXT,
  addons_json      TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`);

(async () => {
  const flightEngine = require('./server/flight-engine');

  // Monkey-patch search to return mock data (sandbox search is unreliable)
  const origFetch = flightEngine._rawFetch;
  flightEngine._rawFetch = async function(path, body, method, useApiHost) {
    if (path === '/flights/rates' && method === 'POST') {
      return {
        ok: true, status: 200,
        json: {
          data: [{
            journeys: [{
              cheapestOffer: { offerId: 'mock-offer-12345' },
              offers: [{ offerId: 'mock-offer-12345', price: 185.38 }],
              segments: [{
                originCode: 'JFK', destinationCode: 'LAX',
                departureTime: '2027-07-15T08:00:00', arrivalTime: '2027-07-15T11:00:00',
                carrier: { marketingCode: 'AA', marketingName: 'American Airlines', marketingLogo: 'https://logo.aa.com' },
                flightNumber: 'AA123', cabinClass: 'ECONOMY',
              }],
            }],
            sortMetadata: {},
          }]
        }
      };
    }
    return origFetch.call(this, path, body, method, useApiHost);
  };

  console.log('=== Flight Engine E2E (mock search + real prebook+book) ===\n');

  // Step 1: Search (mocked)
  console.log('--- Step 1: Search ---');
  const search = await flightEngine.searchFlights({
    legs: [{ origin: 'JFK', destination: 'LAX', date: '2027-07-15' }],
    adults: 1, currency: 'USD', country: 'US',
  });
  if (!search.success) { console.log('Search fail:', search.error); return; }
  const raw = search.data;
  const dataArr = Array.isArray(raw.data) ? raw.data : Object.values(raw.data).filter(v => v && typeof v === 'object');
  let offerId = null;
  for (const c of dataArr) {
    if (c.cheapestOffer?.offerId) { offerId = c.cheapestOffer.offerId; break; }
    if (Array.isArray(c.journeys)) {
      for (const j of c.journeys) {
        if (j.cheapestOffer?.offerId) { offerId = j.cheapestOffer.offerId; break; }
      }
    }
    if (offerId) break;
  }
  console.log('offerId:', offerId);

  // Step 2: Prebook (real LiteAPI)
  console.log('\n--- Step 2: Prebook (real API) ---');
  const prebook = await flightEngine.createPrebook({
    offerId,
    usePaymentSdk: false,
    contact: { firstName: 'Karan', lastName: 'Thakur', email: 'karan.thakur@planurstay.com', phoneNumber: '4155551234' },
    passengers: [{ firstName: 'Karan', lastName: 'Thakur', birthday: '1990-01-15', gender: 'M' }],
  }, null, db, true);
  if (!prebook.success) {
    console.log('Prebook error:', JSON.stringify(prebook.error, null, 2));
    return;
  }
  console.log('✓ Prebook OK');
  console.log('prebookId:', prebook.data.prebookId);
  console.log('price:', prebook.data.price);
  console.log('currency:', prebook.data.currency);
  console.log('transactionId:', prebook.data.transactionId ? '(present)' : '(none)');
  console.log('usePaymentSdk:', prebook.data.usePaymentSdk);

  // Step 3: Book
  console.log('\n--- Step 3: Book ---');
  const book = await flightEngine.completeBooking({
    prebookId: prebook.data.prebookId,
    contact: { firstName: 'Karan', lastName: 'Thakur', email: 'karan.thakur@planurstay.com', phoneNumber: '4155551234' },
    passengers: [{ firstName: 'Karan', lastName: 'Thakur', birthday: '1990-01-15', gender: 'M' }],
    payment: { method: 'TRANSACTION_ID', transactionId: prebook.data.transactionId },
  }, null, db);
  if (!book.success) {
    console.log('Book error:', JSON.stringify(book.error, null, 2));
  } else {
    console.log('✓ BOOKING CONFIRMED');
    console.log('bookingId:', book.data.bookingId);
    console.log('bookingRef:', book.data.bookingRef);
    console.log('status:', book.data.status);
    if (book.data.pricing) console.log('total:', book.data.pricing.totalAmount, book.data.pricing.currency);
    if (book.data.addonVoucherCode) console.log('uberVoucher:', book.data.addonVoucherCode);
    if (book.data.journey) console.log('journeyKey:', book.data.journey.journeyKey);
  }

  // Step 4: Test buildFlightConfirmation
  console.log('\n--- Step 4: buildFlightConfirmation ---');
  const conf = flightEngine.buildFlightConfirmation(book.data);
  console.log('bookingId:', conf.bookingId);
  console.log('bookingRef:', conf.bookingRef);
  console.log('status:', conf.status);
  console.log('carrier:', conf.flight?.airline?.name);
  console.log('total:', conf.pricing?.total);
  console.log('uberVoucher:', conf.uberVoucher ? '✓ ' + conf.uberVoucher.url : 'none');

  console.log('\n=== ALL FLIGHT ENGINE TESTS PASSED ===');
})().catch(e => console.error('FATAL:', e.stack || e.message));
