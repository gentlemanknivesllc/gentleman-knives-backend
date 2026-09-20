# Gentleman Knives backend

Three small serverless functions that handle the automated part of the
order flow: charge shipping + save the card, generate and email the
inbound label, and charge the final total later.

## What each file does

- `api/create-order.js` — starts a Stripe Checkout session for the shipping
  fee, and tells Stripe to save the card for a later automatic charge.
- `api/stripe-webhook.js` — Stripe calls this automatically once payment
  succeeds. It buys a Shippo label using the customer's address and emails
  it to them.
- `api/finalize-order.js` — you (or your friend) call this once the real
  knives have been received and measured. It charges the saved card for
  the confirmed total, automatically.
- `admin.html` — a bare-bones private page for triggering finalize-order.js
  without needing to write curl commands. Don't link to it from the public
  site.

## Deploying (using Vercel, free)

1. Create a free account at vercel.com.
2. Put this whole folder in a GitHub repo, then "Import Project" on Vercel
   and point it at that repo. (Vercel auto-detects anything in `/api` as a
   serverless function — no extra config needed.)
3. In the Vercel project's Settings → Environment Variables, add:

   ```
   STRIPE_SECRET_KEY=sk_test_...       (from your Stripe dashboard)
   STRIPE_WEBHOOK_SECRET=whsec_...     (see step 5 below)
   SHIPPO_API_KEY=shippo_test_...      (from portal.goshippo.com)
   RESEND_API_KEY=re_...               (see step 6 below)
   ADMIN_SECRET=pick-a-long-random-password
   BUSINESS_NAME=Gentleman Knives
   BUSINESS_STREET=your street address
   BUSINESS_CITY=your city
   BUSINESS_STATE=your state abbreviation
   BUSINESS_ZIP=your zip
   ```

4. Deploy. Vercel gives you a URL like `https://gentleman-knives-backend.vercel.app`.

5. Connect the webhook: in the Stripe Dashboard → Developers → Webhooks →
   Add endpoint. URL: `https://YOUR-VERCEL-URL/api/stripe-webhook`.
   Select the `checkout.session.completed` event. Stripe will show you a
   signing secret starting with `whsec_` — copy that into
   `STRIPE_WEBHOOK_SECRET` in Vercel and redeploy.

6. Sign up for Resend (resend.com, free tier) to send the label emails.
   Grab an API key and put it in `RESEND_API_KEY`. You can use their test
   sending domain to start; verifying your own domain later makes emails
   look more legitimate to customers.

7. Update your Squarespace calculator: instead of redirecting straight to
   a static Stripe Payment Link, have the checkout button POST to
   `https://YOUR-VERCEL-URL/api/create-order` and redirect the browser to
   the `url` it returns. Something like:

   ```js
   fetch("https://YOUR-VERCEL-URL/api/create-order", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify(order) // the same order object you already build
   })
     .then(r => r.json())
     .then(data => { window.location.href = data.url; });
   ```

   You'll also need to collect `customerEmail` and `customerName` on the
   page before checkout (a simple form field above the checkout button) —
   the backend needs those to create the Stripe customer.

## Testing before going live

- Use your Stripe **test** keys and Shippo **test** key while building.
- Stripe's test card number is `4242 4242 4242 4242`, any future expiry,
  any CVC.
- Test-mode Shippo labels are free and won't create real trackable mail.
- Once a full test order works end to end (checkout → email arrives with
  a label → admin.html successfully charges the saved card), switch
  `STRIPE_SECRET_KEY` and `SHIPPO_API_KEY` to their live versions.

## Known simplifications worth revisiting later

- Order details are stored in Stripe's metadata fields (capped at 500
  characters each) rather than a real database. Fine at low volume; if
  order details start getting cut off, add a proper database.
- The package weight/dimensions in `stripe-webhook.js` are hardcoded
  placeholders. Once you're ready, pull the real weight/box tier out of
  the order metadata and use it here instead.
- `admin.html` uses a single shared password rather than real login
  accounts. Fine for two people; revisit if more people need access.
