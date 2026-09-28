# Render setup

Service: `planurstay-travel` (Node, paid instance). Deploys automatically from `main`.

## Disk

Persistent disk `data` mounted at `/var/data`. The SQLite database lives at `DB_PATH=/var/data/bookings.db`
(accounts, bookings, Rewards, support tickets, analytics, markup settings, webhook log).
Without the disk every deploy starts with an empty database.

## Environment variables

Never commit the values. Set them in Render → Environment.

| Key | Required | Purpose |
|---|---|---|
| `PROD_API_KEY` | yes | LiteAPI live key (`prod_…`). `SAND_API_KEY` is used only when no prod key is set. |
| `JWT_SECRET` | yes | Signs login cookies and cancellation tokens. |
| `DB_PATH` | yes | `/var/data/bookings.db` |
| `APP_URL` | yes | `https://planurstay-travel.onrender.com` (or the custom domain) |
| `ADMIN_EMAILS` | yes | Comma-separated emails that can open `/admin`. |
| `LITEAPI_WEBHOOK_SECRET` | yes | Same value as the Authentication Token in Nuitee Connect → Webhooks (URL `/api/webhooks/liteapi`). |
| `SUPPORT_EMAIL` | yes | Inbox for support tickets (default `info@planurstay.com`). |
| `RESEND_API_KEY` | for email | Confirmations, cancel codes, ticket emails. |
| `EMAIL_FROM` | for email | Sender on a domain verified in Resend, e.g. `PlanurStay <bookings@planurstay.com>`. |
| `EMAIL_REPLY_TO` | optional | Reply-to address (default `info@planurstay.com`). |
| `ANTHROPIC_API_KEY` | optional | Turns on the AI Help assistant and the AI trip planner (`/plan`). Without it the Help bubble shows a simple menu and the planner says it isn't available. |
| `CHAT_MODEL` | optional | Assistant model (default `claude-haiku-4-5`, the cheapest: $1/$5 per million tokens). |
| `TRIP_MODEL` | optional | Trip planner model (default `claude-haiku-4-5`; `claude-sonnet-5` plans a little better at 2× the price). |
| `NUITEE_CHATBOT_KEY` | optional | Public key for the "Ask AI" chatbot (defaults to the account's public key). `NUITEE_CHATBOT=off` hides it. |
| `CHATBOT` | optional | `off` hides the Help bubble. |
| `LEGAL_NAME`, `LEGAL_ADDRESS`, `SUPPORT_PHONE`, `LEGAL_COUNTRY` | optional | Shown on /terms, /privacy, /contact. |
| `GSC_HTML_FILE` | optional | Google Search Console verification file name, e.g. `google1a2b3c.html`. |
| `PUBLIC_MARGIN`, `MEMBER_MARGIN` | optional | Defaults only; the markup is normally set in `/admin` (saved in the database). |
| `FLEX_EXTRA_MARGIN` | optional | Extra margin points on free-cancellation hotel rates (default `6`), so non-refundable rates stay the cheap headline price. Also editable in `/admin`. |
| `MAX_SSP_MARGIN` | optional | Highest margin used when pricing up to a hotel's own price (default `100`). Guards against bogus SSPs. |
| `PARITY_GATE` | optional | `on` hides below-SSP prices from guests. Leave off. |
| `PAID_EXTRA_ESSENTIAL`, `PAID_EXTRA_PLUS` | optional | Extra hotel discount for paid members, in margin points (default `2` and `3`). |
| `PAID_MARGIN_FLOOR` | optional | Lowest margin a paid-member discount can bring a hotel down to (default `2`). |
| `COMEBACK_BONUS_POINTS` | optional | Bonus points in the "Welcome back" email for booking again within 30 days (default `500`). |
| `INSURANCE_URL`, `TRANSFERS_URL`, `CAR_HIRE_URL` | optional | Partner (affiliate) links shown as "Complete your trip" after booking. HTTPS only; placeholders `{city}` `{country}` `{checkin}` `{checkout}` `{airport}` are filled in. Unset = hidden. |
| `SITATA_ORG_ID`, `SITATA_PUBLIC_TOKEN` | optional | Sitata travel insurance widget ("Protect your trip") on the confirmation page, pre-filled from the booking. Sitata sells and charges the policy (`merchantOfRecord: false`); we earn commission. Use the **public widget token**, never the private API key. Unset = hidden. |
| `SITATA_CHAT_ID`, `SITATA_CONTACT_EMAIL` | optional | Chat ID and support email Sitata gives you for the widget. |
| `SITATA_API_KEY` | optional | **Private** Sitata API key (server only, never shown in the browser). With `SITATA_ORG_ID` set, checkout shows fixed-price "Protect your trip" plans from Sitata quotes; a customer who picks one pays Sitata on the confirmation page. Unset = no checkout box. |
| `SITATA_API_BASE` | optional | Sitata API address. Default `https://www.sitata.com`; set to their sandbox address if they give you one. |
| `TRAVELLEZ_EMAIL`, `TRAVELLEZ_PASSWORD` | optional | PlanurStay's own Travellez account (Sabre car rentals). With these set, the **Cars** page and menu link appear and search works. |
| `CARS_BOOKING_ENABLED` | optional | Set to `true` to allow real car reservations. Leave unset until you've done one test booking yourself and confirmed with Travellez what the company card is used for: there is no Travellez test environment. |
| `CARS_PAYMENT` | optional | `counter` (default): **reserve now, pay at pick-up**. Sabre car rates are pay-at-counter, so PlanurStay charges nothing and adds no markup. `prepay`: PlanurStay charges the customer through Stripe (price + `CAR_MARKUP_PCT`); only use this for rates Travellez actually prepays. |
| `CAR_COMMISSION_VENDORS` | optional | Sabre vendor codes that pay you commission, comma-separated. Default `EY` (Economy Rent a Car). These cars get a "Recommended" badge and rank higher in the Recommended sort. |
| `CARS_VIA` | optional | Cars go through the Travellez MCP automatically once `TRAVELLEZ_MCP_URL` is set. Set `direct` to call Travellez directly instead (the original route). |
| `TRAVELLEZ_MCP_URL` | optional | Address of the Travellez MCP (e.g. `https://mcp.example.com`). PlanurStay signs in with `TRAVELLEZ_EMAIL` / `TRAVELLEZ_PASSWORD` and uses its `/api/v2` endpoints for every Travellez supplier. |
| `MCP_FLIGHTS` | optional | `on`: flights from the MCP (Duffel, Mystifly, Sabre…) are merged into search, cheapest per flight wins, **only once booking is on**. `preview`: show them without booking (every visitor sees them, so use preview on a local/test copy, not the live site). Unset = LiteAPI only. |
| `MCP_BOOKING` | optional | `on` lets customers book MCP flights and hotels (paid upfront). For flights: the card is held with PlanurStay's Stripe, the flight is booked through the MCP (company card), then the card is charged; released if the airline refuses. Needs `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`. |
| `MCP_FLIGHT_MARKUP_PCT` | optional | Markup on MCP flight prices. Default `3`. |
| `MCP_SEARCH_TIMEOUT_MS` | optional | How long flight search waits for the MCP before showing LiteAPI results alone. Default `25000`. |
| `MCP_FLIGHT_SUPPLIERS` | optional | Which MCP flight suppliers customers see once `MCP_FLIGHTS=on`. Default `duffel`: Mystifly and Sabre fares come back from Travellez without the passenger ids the booking step needs, so they'd fail at checkout. Add `mystifly` / `sabre` once their booking works end to end. (Preview shows all.) |
| `MCP_FX_BUFFER_PCT` | optional | Travellez prices in USD; customers see and pay in their own currency, converted at the day's rate plus this buffer for card/bank FX costs. Default `2`. Set `0` for no buffer. |
| `MCP_HOTELS` | optional | `on`: hotels from the MCP (RateHawk, Duffel Stays) join hotel search, rooms and booking, **only once booking is on** (`MCP_BOOKING=on`). The same hotel from LiteAPI and the MCP shows once at the lower price, with both suppliers' rooms. `preview`: show them without booking. |
| `MCP_HOTEL_MARKUP_PCT` | optional | Markup on MCP hotel prices. Default `8`. |
| `MCP_HOTEL_TIMEOUT_MS`, `MCP_HOTEL_WAIT_MS` | optional | Travellez hotel search often takes 30-40s. The hotel page shows LiteAPI results after at most `MCP_HOTEL_WAIT_MS` (default `6000`) and adds the MCP hotels when they arrive; the MCP search itself may run up to `MCP_HOTEL_TIMEOUT_MS` (default `75000`). |
| `MCP_HOTEL_TYPES` | optional | Which MCP hotel suppliers may be sold (paid in full at booking). Default `1,4` (Duffel Stays, RateHawk). Add Sabre's type only once its rates are confirmed prepaid, never "pay at hotel". |
| `CAR_MARKUP_PCT` | optional | Pay-now mode only: markup on the Travellez car price. Default `3`. |
| `CAR_FREE_CANCEL_HOURS` | optional | Pay-now mode only: free cancellation until this many hours before pick-up; no refund after. Default `48`. |
| `TRAVELLEZ_CARD_ID` | optional | Which saved Travellez card pays for cars. Default: the account's default (or first) card. |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | for car bookings | Customer card payments for cars. The card is only held first and charged once the car is confirmed. |
| `GA4_ID` | optional | Google Analytics 4 measurement ID (`G-XXXXXXX`). Tracks search → view → checkout → payment → purchase. |
| `META_PIXEL_ID` | optional | Meta (Facebook/Instagram) Pixel ID (digits). Same funnel events, for Instagram/Facebook ads and retargeting. |
| `WHATSAPP_NUMBER` | optional | WhatsApp number with country code, digits only (e.g. `14165550000`). Shows a WhatsApp button on hotel pages and checkout. |
| `REVIEWS_URL`, `REVIEWS_LABEL` | optional | Link to your Trustpilot / Google reviews and the badge text (e.g. `4.8 on Trustpilot`). Shown next to the Pay button. |

## Nuitee Connect webhook events

`booking.book`, `booking.book.hotelConfirmationNumber`, `booking.cancel`, `booking.refund`,
`booking.amendment`, `booking.compensation`, `flight.book.confirmed`, `flight.book.cancelled`,
`flight.book.failed`. Leave `booking.prebook` off.
