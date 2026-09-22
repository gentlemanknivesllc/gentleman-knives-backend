// api/subscribe.js
// Called when a customer signs up for a subscription tier (from a
// Squarespace form/block you'll add pointing at this endpoint). Requires a
// card already saved via a prior Stripe Checkout — in practice, point
// subscription signup at a normal create-order checkout first if this is
// someone's first-ever order, then call this endpoint after.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sql } = require('../lib/db');
const { TIER_DISCOUNTS, generateToken, nextRenewalDate } = require('../lib/subscriptions');

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

    const renewal = nextRenewalDate(tier);

    const { rows } = await sql`
      INSERT INTO subscribers (email, stripe_customer_id, tier, discount_pct, default_config, next_renewal)
      VALUES (${customerEmail}, ${customer.id}, ${tier}, ${TIER_DISCOUNTS[tier]}, ${JSON.stringify(defaultConfig)}, ${renewal.toISOString().slice(0, 10)})
      ON CONFLICT (email) DO UPDATE SET tier = EXCLUDED.tier, discount_pct = EXCLUDED.discount_pct,
        default_config = EXCLUDED.default_config, next_renewal = EXCLUDED.next_renewal, status = 'active', consecutive_misses = 0
      RETURNING id
    `;

    const subscriberId = rows[0].id;
    const token = generateToken();

    await sql`
      INSERT INTO renewal_cycles (subscriber_id, token, renewal_date)
      VALUES (${subscriberId}, ${token}, ${renewal.toISOString().slice(0, 10)})
    `;

    res.status(200).json({ success: true, tier, discount: TIER_DISCOUNTS[tier], nextRenewal: renewal.toISOString().slice(0, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create subscription' });
  }
};
