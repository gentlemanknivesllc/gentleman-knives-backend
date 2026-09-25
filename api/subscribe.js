// api/subscribe.js
// Standalone endpoint for signing up for a subscription AFTER a prior
// order already exists (e.g. an existing customer decides to subscribe
// later). For signing up DURING checkout, see the metadata.subscribeTier
// handling in stripe-webhook.js instead — that's the primary path the
// calculator's subscription tab uses.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sql } = require('../lib/db');
const { TIER_DISCOUNTS, createSubscriberRecord } = require('../lib/subscriptions');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const { customerEmail, tier, defaultConfig } = req.body;
    if (!customerEmail || !TIER_DISCOUNTS[tier] || !defaultConfig) {
      return res.status(400).json({ error: 'Missing or invalid customerEmail, tier, or defaultConfig' });
    }

    const customers = await stripe.customers.list({ email: customerEmail, limit: 1 });
    const customer = customers.data[0];
    if (!customer || !customer.metadata.savedPaymentMethod) {
      return res.status(400).json({ error: 'No saved card on file — customer must complete a checkout first' });
    }

    const { rows: orderRows } = await sql`
      SELECT stripe_session_id FROM orders WHERE customer_email = ${customerEmail}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!orderRows.length) {
      return res.status(400).json({ error: 'No previous order found — customer must complete a checkout first' });
    }

    const session = await stripe.checkout.sessions.retrieve(orderRows[0].stripe_session_id);
    const shippingAddress = (session.collected_information && session.collected_information.shipping_details)
      ? session.collected_information.shipping_details.address
      : (session.shipping_details ? session.shipping_details.address : null);
    if (!shippingAddress) {
      return res.status(400).json({ error: 'No shipping address found on file for this customer' });
    }

    const shippingAddressForShippo = {
      name: session.customer_details.name,
      street1: shippingAddress.line1,
      street2: shippingAddress.line2 || '',
      city: shippingAddress.city,
      state: shippingAddress.state,
      zip: shippingAddress.postal_code,
      country: shippingAddress.country
    };

    const result = await createSubscriberRecord({
      sql,
      email: customerEmail,
      stripeCustomerId: customer.id,
      tier,
      defaultConfig,
      shippingAddress: shippingAddressForShippo
    });

    res.status(200).json({ success: true, tier, discount: TIER_DISCOUNTS[tier], nextRenewal: result.nextRenewal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create subscription' });
  }
};
