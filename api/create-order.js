// api/create-order.js
// Called by your Squarespace calculator when the customer clicks "Continue to
// shipping & payment". Recalculates shipping live via Shippo server-side
// (never trusts a client-supplied number), enforces the 3-item minimum,
// and logs the order for the typical-price averaging system.
//
// CHARGE SPLIT: this charges ONLY the shipping cost (both directions) right
// now. It also saves the card on file. The sharpening total is a separate,
// later charge — that happens in finalize-order.js once the knives have
// arrived and the real total is known. Two charges, two different times,
// on purpose.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { calculateShipping, MINIMUM_ITEMS } = require('../lib/shipping');
const { sql } = require('../lib/db');
const { checkWeeklyCapacity } = require('../lib/capacity');

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

    // Require a real ZIP before charging anything — falling back to a
    // placeholder here would mean the actual amount charged doesn't
    // reflect the customer's real shipping cost.
    if (!customerZip || !/^\d{5}(-\d{4})?$/.test(customerZip.trim())) {
      return res.status(400).json({ error: 'A valid ZIP code is required to calculate your real shipping cost' });
    }

    const count = items.reduce((sum, i) => sum + (i.qty || 1), 0);
    if (count < MINIMUM_ITEMS) {
      return res.status(400).json({ error: `Minimum order is ${MINIMUM_ITEMS} items` });
    }

    // Weekly capacity check — see lib/capacity.js for the cap itself.
    const capacity = await checkWeeklyCapacity(sql);
    if (!capacity.hasRoom) {
      return res.status(409).json({
        error: 'waitlist',
        message: `We're at capacity for this week (${capacity.cap} orders). Join the waitlist and we'll email you the moment a slot opens.`,
        ordersThisWeek: capacity.ordersThisWeek,
        cap: capacity.cap
      });
    }

    const addressTo = { zip: customerZip.trim(), country: 'US' };
    const shipping = await calculateShipping(items, addressTo);

    // Reuse the same Stripe customer if this email has ordered before
    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
    const customer = existing.data[0] || await stripe.customers.create({
      email: customerEmail,
      name: customerName
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customer.id,
      // Saves the card for the LATER sharpening charge, off-session, once
      // the real total is known.
      payment_intent_data: {
        setup_future_usage: 'off_session'
      },
      shipping_address_collection: { allowed_countries: ['US'] },
      // USPS requires a phone number on the SHIPPER'S address for inbound
      // labels (the customer is the shipper when they're sending knives to
      // us) — without this, Stripe never asks for one and the label
      // purchase fails downstream.
      phone_number_collection: { enabled: true },
      // Only shipping is charged right now — the sharpening total is a
      // separate charge later, once we know the real amount.
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Gentleman Knives — Shipping (both ways)',
            description: 'Covers your shipping label to us and back. Your sharpening total is charged separately, once we receive and measure your items, for an amount at or below your estimate.'
          },
          unit_amount: Math.round(shipping.finalShipping * 100)
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
      cancel_url: 'https://www.gentlemanknives.co/sharpening'
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
