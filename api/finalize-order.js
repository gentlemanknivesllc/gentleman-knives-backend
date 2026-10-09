// api/finalize-order.js
// Called (via admin.html) once your friend has actually opened the package
// and knows the real sharpening total. Charges the card saved at checkout,
// updates the "what customers typically pay" averages, and now also buys
// and emails the RETURN shipping label — this is the piece that was
// missing before: the outbound (business -> customer) leg of the trip.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sql } = require('../lib/db');
const { estimateForItem, comboKey } = require('../lib/estimates');
const { totalItemWeight, OUTBOUND_PACKAGING_BUFFER_LB } = require('../lib/shipping');
const { purchaseLabel, emailReturnLabel, emailLocalOrderReady } = require('../lib/labels');

module.exports = async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Not authorized' });
  }

  // GET = read-only dashboard data for admin.html: every order still
  // waiting on a final charge, plus a running total of what's actually
  // been charged so far (a rough revenue figure — it doesn't subtract
  // Stripe fees, Shippo costs, or gas, so it's gross, not profit).
  if (req.method === 'GET') {
    try {
      const pending = await sql`
        SELECT id, customer_email, items, sharpening_total, shipping_charged,
               delivery_fee, fulfillment_type, created_at
        FROM orders
        WHERE finalized_at IS NULL
        ORDER BY created_at ASC
      `;

      const revenue = await sql`
        SELECT
          COALESCE(SUM(sharpening_total), 0) AS total_sharpening,
          COALESCE(SUM(shipping_charged), 0) AS total_shipping,
          COALESCE(SUM(delivery_fee), 0) AS total_delivery,
          COUNT(*) AS order_count
        FROM orders
        WHERE finalized_at IS NOT NULL
      `;

      return res.status(200).json({
        pending: pending.rows,
        revenueSummary: revenue.rows[0]
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use GET or POST' });
  }

  const { customerEmail, finalAmount } = req.body;
  if (!customerEmail || !finalAmount) {
    return res.status(400).json({ error: 'Missing customerEmail or finalAmount' });
  }

  try {
    const customers = await stripe.customers.list({ email: customerEmail, limit: 1 });
    const customer = customers.data[0];

    if (!customer || !customer.metadata.savedPaymentMethod) {
      return res.status(404).json({ error: 'No saved card found for this customer email' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(finalAmount * 100),
      currency: 'usd',
      customer: customer.id,
      payment_method: customer.metadata.savedPaymentMethod,
      off_session: true,
      confirm: true
    });

    // Find this customer's most recent unfinalized order.
    const { rows } = await sql`
      SELECT id, stripe_session_id, items, sharpening_total, fulfillment_type FROM orders
      WHERE customer_email = ${customerEmail} AND finalized_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `;

    let returnLabelResult = { attempted: false, success: false };

    if (rows.length) {
      const order = rows[0];
      const items = order.items;
      const fulfillmentType = order.fulfillment_type || 'mail';

      // --- Update the "typical price" running averages ---
      const estimateSum = items.reduce((sum, i) => sum + estimateForItem(i) * (i.qty || 1), 0);
      const scaleFactor = estimateSum > 0 ? finalAmount / estimateSum : 1;

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

      await sql`
        UPDATE orders SET sharpening_total = ${finalAmount}, finalized_at = now()
        WHERE id = ${order.id}
      `;

      if (fulfillmentType === 'mail') {
        // --- Buy and email the return label ---
        returnLabelResult.attempted = true;
        try {
          const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
          const shippingAddress = (session.collected_information && session.collected_information.shipping_details)
            ? session.collected_information.shipping_details.address
            : (session.shipping_details ? session.shipping_details.address : null);

          if (shippingAddress) {
            const customerAddress = {
              name: session.customer_details.name,
              street1: shippingAddress.line1,
              street2: shippingAddress.line2 || '',
              city: shippingAddress.city,
              state: shippingAddress.state,
              zip: shippingAddress.postal_code,
              country: shippingAddress.country
            };

            const weightLb = Math.round((totalItemWeight(items) + OUTBOUND_PACKAGING_BUFFER_LB) * 100) / 100;

            const label = await purchaseLabel({
              direction: 'outbound',
              customerAddress,
              weightLb
            });

            await emailReturnLabel(customerEmail, label, finalAmount);
            returnLabelResult.success = true;
          } else {
            returnLabelResult.error = 'No shipping address found on the original order';
          }
        } catch (labelErr) {
          // The charge already succeeded — don't fail the whole request over
          // a label hiccup, but surface it clearly so it doesn't go unnoticed.
          console.error('Return label purchase/email failed:', labelErr);
          returnLabelResult.error = labelErr.message;
        }
      } else {
        // Local order (drop-off or delivery) — no shipping label involved.
        // Drop-off just needs a pickup reminder; delivery needs the
        // scheduling link again so they can book the RETURN trip (the fee
        // covers both legs, but each leg is its own appointment).
        returnLabelResult.attempted = false;
        try {
          await emailLocalOrderReady(customerEmail, { fulfillment: fulfillmentType, finalAmount });
        } catch (emailErr) {
          console.error('Local "ready" email failed:', emailErr);
        }
      }
    }

    res.status(200).json({
      success: true,
      paymentIntentId: paymentIntent.id,
      returnLabel: returnLabelResult
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
