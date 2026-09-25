// api/finalize-subscription-order.js
// The subscription equivalent of finalize-order.js. Your friend enters the
// REAL sharpening total (same as he does for a normal order, based on what
// he actually inspected) — this endpoint automatically applies that
// subscriber's discount, charges the reduced amount, and buys + emails the
// return label. This is the piece that was missing: a confirmed
// subscription cycle previously had no way to actually get charged or
// shipped back.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sql } = require('../lib/db');
const { estimateForItem, comboKey } = require('../lib/estimates');
const { totalItemWeight, OUTBOUND_PACKAGING_BUFFER_LB } = require('../lib/shipping');
const { purchaseLabel, emailReturnLabel } = require('../lib/labels');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Not authorized' });
  }

  // finalAmount here is the PRE-discount real sharpening total — enter it
  // exactly like a normal order. The subscriber's discount is applied
  // automatically below.
  const { customerEmail, finalAmount } = req.body;
  if (!customerEmail || !finalAmount) {
    return res.status(400).json({ error: 'Missing customerEmail or finalAmount' });
  }

  try {
    const { rows: subRows } = await sql`
      SELECT * FROM subscribers WHERE email = ${customerEmail} AND status = 'active'
    `;
    if (!subRows.length) {
      return res.status(404).json({ error: 'No active subscriber found with this email' });
    }
    const subscriber = subRows[0];

    // Find the most recent confirmed-but-not-yet-finalized cycle for them.
    const { rows: cycleRows } = await sql`
      SELECT * FROM renewal_cycles
      WHERE subscriber_id = ${subscriber.id} AND confirmed = TRUE AND finalized_at IS NULL
      ORDER BY confirmed_at DESC LIMIT 1
    `;
    if (!cycleRows.length) {
      return res.status(404).json({ error: 'No confirmed, unfinalized cycle found for this subscriber' });
    }
    const cycle = cycleRows[0];

    const discountedAmount = Math.round(finalAmount * (1 - subscriber.discount_pct) * 100) / 100;

    const customers = await stripe.customers.list({ email: customerEmail, limit: 1 });
    const customer = customers.data[0];
    if (!customer || !customer.metadata.savedPaymentMethod) {
      return res.status(404).json({ error: 'No saved card found for this customer email' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(discountedAmount * 100),
      currency: 'usd',
      customer: customer.id,
      payment_method: customer.metadata.savedPaymentMethod,
      off_session: true,
      confirm: true
    });

    // Update the typical-price running averages using the REAL discounted
    // amount actually charged — same logic as finalize-order.js.
    const items = Array.isArray(cycle.used_config) ? cycle.used_config : subscriber.default_config;
    const estimateSum = items.reduce((sum, i) => sum + estimateForItem(i) * (i.qty || 1), 0);
    const scaleFactor = estimateSum > 0 ? discountedAmount / estimateSum : 1;

    for (const item of items) {
      const key = comboKey(item);
      const realPricePerUnit = Math.round(estimateForItem(item) * scaleFactor * 100) / 100;
      const qty = item.qty || 1;

      await sql`
        UPDATE price_averages
        SET running_total = CASE WHEN seeded THEN ${realPricePerUnit * qty} ELSE running_total + ${realPricePerUnit * qty} END,
            order_count = CASE WHEN seeded THEN ${qty} ELSE order_count + ${qty} END,
            seeded = FALSE
        WHERE combo = ${key}
      `;
    }

    // Buy and email the return label.
    let returnLabelResult = { attempted: true, success: false };
    try {
      const weightLb = Math.round((totalItemWeight(items) + OUTBOUND_PACKAGING_BUFFER_LB) * 100) / 100;

      const label = await purchaseLabel({
        direction: 'outbound',
        customerAddress: subscriber.shipping_address,
        weightLb
      });

      await emailReturnLabel(customerEmail, label, discountedAmount);
      returnLabelResult.success = true;
    } catch (labelErr) {
      console.error('Subscription return label failed:', labelErr);
      returnLabelResult.error = labelErr.message;
    }

    await sql`
      UPDATE renewal_cycles SET finalized_at = now(), charged_amount = ${discountedAmount}
      WHERE id = ${cycle.id}
    `;

    res.status(200).json({
      success: true,
      paymentIntentId: paymentIntent.id,
      originalAmount: finalAmount,
      discountPct: subscriber.discount_pct,
      chargedAmount: discountedAmount,
      returnLabel: returnLabelResult
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
