# Owner sign-in

One session, shared by the Onboarding page (`/`), the Dashboard (`/dashboard`) and the Marketplace (`/marketplace`).

| How | What happens |
|---|---|
| Onboard with a **new** email | The server signs the new owner in (`pp_session` cookie) and onboarding goes straight to `/dashboard?agent=…`. |
| Onboard with an email that **already has an account** | The agent is created, but onboarding never signs that email in (anyone could type it). The page sends you to `/login` to sign in with a link. |
| `/login` | Enter your email to get a single-use sign-in link (15 minutes). `/auth/verify?token=…` sets the cookie and returns you to `next` (same-site paths only). |
| Sign out | `POST /api/session/logout` (Dashboard and Marketplace headers). |

- Cookie: `pp_session`, HttpOnly, SameSite=Lax, 30 days, `Secure` when `PAYPALI_PUBLIC_URL` is https. Only SHA-256 hashes of session and link tokens are stored (`OwnerSession`, `LoginLink`).
- `GET /api/session` → `{signedIn, owner: {id, email}, agents}`. The Marketplace lists only these agents.
- **Email delivery.** PayPali does not send email yet. In development `/api/session/login` returns the link (`devLink`), the page shows an "Open sign-in link" button, and the server logs it. In production (`NODE_ENV=production`) without a mailer it refuses with `LOGIN_EMAIL_NOT_CONFIGURED`. Plug a sender into `new SessionService(prisma, { publicUrl, deliver: async (email, link) => … })`.
- **Old `?owner=<id>` links** still open the Dashboard in development, with a **Sign in as <email>** button that turns the link into a real session in one click (dev follows the link directly; production emails it). A signed-in owner always sees their own account, whatever the link says.
- **localhost vs 127.0.0.1** are separate cookie jars. Dev sign-in links open on the host you are browsing, so you stay signed in where you are.
- Pages are served with `cache-control: no-store`, so a browser never keeps showing a page from before an update.

## Strict mode: `PAYPALI_REQUIRE_SESSION=1`
Off by default so the dev harness, the e2e scripts and the seed in `npm run stack` keep working. Turn it on for any shared deployment:
- `/api/owners/:id/*`, `/api/agents/:id/*` and `/api/agentdev/agents/:id/*` need a signed-in owner who owns them (401 `SIGN_IN_REQUIRED`, 403 `NOT_YOUR_ACCOUNT`). Agent acts (`bazaar/buy|run|report|resume`, `orders/*`) stay reachable; MCP clients use their own bearer tokens.
- `GET /api/agents` returns only your agents.
- Onboarding with an existing email is refused unless you are signed in as that owner.
- `npm run stack -- --no-seed` works in strict mode; the seed step uses unauthenticated owner calls.
