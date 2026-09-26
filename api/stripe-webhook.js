// api/stripe-webhook.js
// Stripe calls this automatically the instant a shipping payment succeeds.
// This is where the inbound label actually gets generated and emailed — no
// one has to click anything for this to happen.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { purchaseLabel, emailInboundLabel } = require('../lib/labels');
const { totalItemWeight, INBOUND_PACKAGING_BUFFER_LB } = require('../lib/shipping');
const { createSubscriberRecord } = require('../lib/subscriptions');
const { sql } = require('../lib/db');

// Stripe needs the raw, unparsed request body to verify this request really
// came from Stripe (not someone pretending to be Stripe).
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['payment_intent', 'customer']
    });

    // Raffle entries are a completely different kind of checkout — no
    // shipping, no label, no subscription. Branch off early and skip all
    // the normal order-processing logic entirely.
    if (fullSession.metadata && fullSession.metadata.type === 'raffle_entry') {
      try {
        const email = fullSession.metadata.email;
        const quantity = parseInt(fullSession.metadata.quantity, 10) || 1;

        await sql`
          INSERT INTO raffle_entries (email, entry_type, quantity, stripe_session_id)
          VALUES (${email.trim().toLowerCase()}, 'paid', ${quantity}, ${fullSession.id})
        `;
      } catch (raffleErr) {
        console.error('Raffle entry recording failed:', raffleErr);
      }

      return res.status(200).json({ received: true });
    }

    // Stripe moved this field to collected_information.shipping_details in
    // a 2025 API update — check both locations so this works regardless of
    // which API version this Stripe account is pinned to.
    const shippingAddress = (fullSession.collected_information && fullSession.collected_information.shipping_details)
      ? fullSession.collected_information.shipping_details.address
      : (fullSession.shipping_details ? fullSession.shipping_details.address : null);
    const customerEmail = fullSession.customer_details.email;
    const customerName = fullSession.customer_details.name;
    const paymentMethodId = fullSession.payment_intent.payment_method;

    // Save the payment method on the customer record so finalize-order.js
    // can find it later and charge the confirmed total automatically.
    await stripe.customers.update(fullSession.customer.id, {
      metadata: { savedPaymentMethod: paymentMethodId }
    });

    if (shippingAddress) {
      try {
        const toAddress = {
          name: customerName,
          street1: shippingAddress.line1,
          street2: shippingAddress.line2 || '',
          city: shippingAddress.city,
          state: shippingAddress.state,
          zip: shippingAddress.postal_code,
          country: shippingAddress.country,
          // USPS requires these on the SHIPPER'S address — for an inbound
          // label, that's the customer (they're the one sending the
          // package), not our business.
          email: customerEmail,
          phone: fullSession.customer_details.phone
        };

        // Real weight, pulled from the items this checkout was actually
        // for (stored in metadata by create-order.js) instead of a
        // hardcoded guess.
        const items = JSON.parse(fullSession.metadata.items || '[]');
        const weightLb = Math.round((totalItemWeight(items) + INBOUND_PACKAGING_BUFFER_LB) * 100) / 100;

        const label = await purchaseLabel({
          direction: 'inbound',
          customerAddress: toAddress,
          weightLb
        });

        await emailInboundLabel(customerEmail, label);

        // If they checked "subscribe" during checkout, set that up now —
        // this is the point where we finally have both a saved payment
        // method AND a confirmed shipping address to attach to it.
        const subscribeTier = fullSession.metadata.subscribeTier;
        if (subscribeTier) {
          try {
            await createSubscriberRecord({
              sql,
              email: customerEmail,
              stripeCustomerId: fullSession.customer.id,
              tier: subscribeTier,
              defaultConfig: items,
              shippingAddress: toAddress
            });
          } catch (subErr) {
            console.error('Subscription signup during checkout failed:', subErr);
          }
        }
      } catch (err) {
        // Payment already succeeded at this point, so we log this rather
        // than fail the whole webhook — you don't want Stripe retrying a
        // charge that already worked. Check your Vercel logs if a label
        // doesn't go out.
        console.error('Label purchase/email step failed:', err);
      }
    }
  }

  res.status(200).json({ received: true });
};
