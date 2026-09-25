// api/create-order.js
// Called by your Squarespace calculator when the customer clicks "Continue to
// shipping & payment". Recalculates shipping live via Shippo server-side
// (never trusts a client-supplied number), enforces the 3-item minimum,
// combines sharpening + shipping into a single line item so no separate
// shipping cost is ever shown to the customer, and logs the order for the
// typical-price averaging system.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { calculateShipping, MINIMUM_ITEMS } = require('../lib/shipping');
const { sql } = require('../lib/db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const {
      items,
      notes,
      sharpeningEstimate,
      customerEmail,
      customerName,
      customerZip, // used only for the pre-checkout quote; Stripe collects the real address
      subscribeTier // optional: 'quarterly' | 'semiannual' | 'annual', set if they checked the subscribe box
    } = req.body;

    if (!customerEmail || !items || !items.length) {
      return res.status(400).json({ error: 'Missing customer email or items' });
    }

    const count = items.reduce((sum, i) => sum + (i.qty || 1), 0);
    if (count < MINIMUM_ITEMS) {
      return res.status(400).json({ error: `Minimum order is ${MINIMUM_ITEMS} items` });
    }

    const addressTo = { zip: customerZip || '10001', country: 'US' };
    const shipping = await calculateShipping(items, addressTo);

    const combinedTotal = Math.round((Number(sharpeningEstimate || 0) + shipping.finalShipping) * 100) / 100;

    // Reuse the same Stripe customer if this email has ordered before
    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
    const customer = existing.data[0] || await stripe.customers.create({
      email: customerEmail,
      name: customerName
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customer.id,
      // Keeps the card on file so the later confirmed-total charge can
      // happen automatically, without the customer present.
      payment_intent_data: {
        setup_future_usage: 'off_session'
      },
      shipping_address_collection: { allowed_countries: ['US'] },
      // USPS requires a phone number on the SHIPPER'S address for inbound
      // labels (the customer is the shipper when they're sending knives to
      // us) — without this, Stripe never asks for one and the label
      // purchase fails downstream.
      phone_number_collection: { enabled: true },
      // Single combined line item — no separate shipping cost is ever shown.
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Gentleman Knives — Estimate (includes shipping both ways)',
            description: 'Your knives ship to us and back. Final charge is confirmed once received, and is always at or below this estimate.'
          },
          unit_amount: Math.round(combinedTotal * 100)
        },
        quantity: 1
      }],
      metadata: {
        items: JSON.stringify(items).slice(0, 400),
        notes: (notes || '').slice(0, 300),
        sharpeningEstimate: String(sharpeningEstimate || 0),
        shippingFinal: String(shipping.finalShipping),
        shippingDiscount: String(shipping.discount),
        itemCount: String(count),
        subscribeTier: subscribeTier || ''
      },
      success_url: 'https://www.gentlemanknives.co/thank-you?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://www.gentlemanknives.co/services'
    });

    // Log the order up front (pending finalization) so nothing depends on
    // the webhook alone for record-keeping.
    await sql`
      INSERT INTO orders (stripe_session_id, customer_email, items, sharpening_total, shipping_charged)
      VALUES (${session.id}, ${customerEmail}, ${JSON.stringify(items)}, ${sharpeningEstimate || 0}, ${shipping.finalShipping})
    `;

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
};
