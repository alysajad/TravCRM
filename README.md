# TravCRM

Travel CRM for multiple companies, with a React/TypeScript frontend, a Node/Fastify API, and Supabase Auth, Postgres, and Storage. The old ERP is a read-only reference; this repository does not connect to or alter it.

## What is built

- Full-width company workspaces, invite-only sign-in, staff, configurable roles, company settings, private files, and activity records.
- TravCRM owner portal with customer health, SaaS revenue, subscriptions, support access, suspension, archiving, restoration, and guarded tenant erasure.
- Queries, follow-ups, lead sources, clients, day plans, hotels, houseboats, room types, cabs, and supporting catalogs.
- Quotation builder with one day plan per day and one hotel per night, server-calculated INR/GST totals, duplicate/edit/delete, branded PDF, and outbound email/WhatsApp sending.
- Recorded client and hotel payments, client and hotel ledgers, invoices with a GST percentage calculation, expenses, stay and cab vouchers, and PDFs.
- Meta OAuth lead-ad intake, branded hosted website forms, secure website lead endpoints, and per-company SMTP and WhatsApp connections.
- Company-controlled PDF layouts, section order, policies, signature, colors, and a discreet TravCRM footer.

The interface follows the supplied dashboard reference with the #FDF2FB, #4A3A52, #C084FC, and #A5D8FF palette and self-hosted Spectral/Karla fonts. The shared design layer is in `apps/web/src/theme.css`. Each company can set its document logo and accent color independently.

## Local setup

1. Create a Supabase project. Run the files in `supabase/migrations` in filename order in the SQL editor. Existing installations should run only migrations they have not yet applied; the SaaS owner portal requires `0002_saas_management.sql`. Keep the `crm-private` Storage bucket private.
2. In Supabase Auth, disable public sign-up. Create your own user with a password in **Authentication → Users**, then run:

   ```sql
   insert into public.platform_admins (user_id) values ('YOUR_AUTH_USER_UUID');
   ```

3. Copy `apps/api/.env.example` to `apps/api/.env` and `apps/web/.env.example` to `apps/web/.env`. Set the Supabase project URL, publishable key, and server secret key. Generate `INTEGRATION_ENCRYPTION_KEY` with `openssl rand -hex 32` and keep it stable and private.
4. Add `http://localhost:5173/set-password` to Supabase Auth redirect URLs. Before creating the first company, configure custom SMTP under **Authentication → Emails → SMTP Settings** so the company admin invitation can reach any address. Supabase's default sender only reaches pre-authorized project-team addresses and is intended for testing.
5. Run `npm install` and `npm run dev`. Open `http://localhost:5173`, sign in, create a company, and select it. Invited users set their passwords through the email link; the login screen also supports password resets. Add day plans and hotels before preparing a quotation. Invite staff from **Team** and assign roles from **Roles**.

The API listens on port 4000 by default. `GET /health` is its health endpoint. Run `npm run check`, `npm run test`, and `npm run build` before deployment.

## External connections

- **Email:** each company enters its SMTP host, port, username, password, and sender address under **Connections**.
- **WhatsApp:** each company enters its WhatsApp Business Platform phone number ID and token. Create approved quotation and voucher templates, each with a document header and one body variable for the client or guest name; enter their names and language in **Connections**. Set `META_APP_SECRET`, `META_VERIFY_TOKEN`, and the Graph API version on the API. Point the Meta webhook to `https://YOUR_API_DOMAIN/api/v1/webhooks/meta` and subscribe to WhatsApp message status events.
- **Meta leads:** configure a TravCRM Meta app with the API callback URL, then companies connect through Meta login and select their Page under **Connections**. Subscribe the webhook to Page `leadgen` events. The API stores each external lead once.
- **Website leads:** each company can publish a hosted form, copy an iframe snippet, allow website origins, or generate a write key for a custom server-side form. Write keys are shown once and only their hashes are stored.

Credentials are encrypted with AES-GCM before storage. The API secret and encryption key belong only in the API environment. A failed send remains visible as a failed message; email status means accepted by SMTP, while WhatsApp statuses are updated from Meta webhooks.

## Deployment

For Vercel, import this repository as a project and leave **Root Directory** at the repository root. The included `vercel.json` installs dependencies, builds only the React workspace, serves `apps/web/dist`, and rewrites application routes to `index.html`. Set `VITE_API_URL` (including `/api/v1`), `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` in Vercel's frontend environment. The Supabase secret key and integration encryption key belong only in the API host. Vercel Hobby is limited to personal, non-commercial use; choose an eligible plan for a live business CRM.

For the API, create a **Blueprint** in Render from this GitHub repository. The root `render.yaml` creates a free Node web service in Singapore, builds only `@travcrm/api`, and checks `/health`. It sets `WEB_ORIGIN` and `PUBLIC_APP_URL` to the current frontend origin, `https://travcrm-ten.vercel.app`; update both if that domain changes. Enter the prompted environment variables in Render: the Supabase URL and publishable key (`SUPABASE_ANON_KEY`), the server-only secret key, and the existing 64-character hex `INTEGRATION_ENCRYPTION_KEY`. Render supplies `PORT`. After deployment, verify `https://YOUR-RENDER-HOST/health` returns `{ "ok": true }`, then set Vercel's `VITE_API_URL` to `https://YOUR-RENDER-HOST/api/v1` and redeploy the frontend. Add `https://travcrm-ten.vercel.app/set-password` to Supabase Auth redirect URLs.

For one-click Meta connection, add `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, and `META_REDIRECT_URI=https://YOUR-RENDER-HOST/api/v1/integrations/meta/oauth/callback` in Render. Add that exact callback as a valid OAuth redirect URI in Meta. Optional website-form spam protection uses a Cloudflare Turnstile site key and secret in `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.

Cloudflare Pages is also an option for the static frontend: build from the repository root with `npm run build --workspace @travcrm/web` and publish `apps/web/dist`. Use separate Supabase projects for staging and production when ready.

**Free-tier hosting limits:** Render Free sleeps after 15 minutes idle and blocks outbound SMTP ports 25, 465, and 587, so the current per-company quotation email sender cannot work there. Use it for a pilot without quotation email, move the API to a suitable paid service, or change quotation sending to an HTTPS email provider API. Supabase Auth's SMTP setting is separate from the CRM's per-company quotation SMTP settings. Vercel Hobby is limited to personal, non-commercial use, so it is unsuitable for a commercial CRM. Cloudflare Pages can host the static frontend, but the existing Fastify API is a separate Node service and is not a drop-in Pages deployment.

## Verification still needed

This repository builds and its local business checks pass. Test company isolation, live email/WhatsApp sends, Facebook leads, and the full journey in staging before using real records. Because the reference ERP was only inspected without changing entries, review each module’s save and document behavior against your business process before production sign-off.

Invoice PDFs reproduce the observed client, item, subtotal, and GST flow. They do not yet collect every particular required for an official Indian tax invoice; confirm the final invoice fields and numbering with your accountant before issuing them as tax invoices.
