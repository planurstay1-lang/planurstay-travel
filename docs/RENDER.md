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
| `ANTHROPIC_API_KEY` | optional | Turns on the AI Help assistant. Without it the Help bubble shows a simple menu. |
| `CHAT_MODEL` | optional | Assistant model (default `claude-sonnet-5`). |
| `NUITEE_CHATBOT_KEY` | optional | Public key for the "Ask AI" chatbot (defaults to the account's public key). `NUITEE_CHATBOT=off` hides it. |
| `CHATBOT` | optional | `off` hides the Help bubble. |
| `LEGAL_NAME`, `LEGAL_ADDRESS`, `SUPPORT_PHONE`, `LEGAL_COUNTRY` | optional | Shown on /terms, /privacy, /contact. |
| `GSC_HTML_FILE` | optional | Google Search Console verification file name, e.g. `google1a2b3c.html`. |
| `PUBLIC_MARGIN`, `MEMBER_MARGIN` | optional | Defaults only; the markup is normally set in `/admin` (saved in the database). |
| `PARITY_GATE` | optional | `on` hides below-SSP prices from guests. Leave off. |

## Nuitee Connect webhook events

`booking.book`, `booking.book.hotelConfirmationNumber`, `booking.cancel`, `booking.refund`,
`booking.amendment`, `booking.compensation`, `flight.book.confirmed`, `flight.book.cancelled`,
`flight.book.failed`. Leave `booking.prebook` off.
