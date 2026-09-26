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
| `GA4_ID` | optional | Google Analytics 4 measurement ID (`G-XXXXXXX`). Tracks search → view → checkout → payment → purchase. |
| `META_PIXEL_ID` | optional | Meta (Facebook/Instagram) Pixel ID (digits). Same funnel events, for Instagram/Facebook ads and retargeting. |
| `WHATSAPP_NUMBER` | optional | WhatsApp number with country code, digits only (e.g. `14165550000`). Shows a WhatsApp button on hotel pages and checkout. |
| `REVIEWS_URL`, `REVIEWS_LABEL` | optional | Link to your Trustpilot / Google reviews and the badge text (e.g. `4.8 on Trustpilot`). Shown next to the Pay button. |

## Nuitee Connect webhook events

`booking.book`, `booking.book.hotelConfirmationNumber`, `booking.cancel`, `booking.refund`,
`booking.amendment`, `booking.compensation`, `flight.book.confirmed`, `flight.book.cancelled`,
`flight.book.failed`. Leave `booking.prebook` off.
