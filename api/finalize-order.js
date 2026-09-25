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
const { purchaseLabel, emailReturnLabel } = require('../lib/labels');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Not authorized' });
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
      SELECT id, stripe_session_id, items, sharpening_total FROM orders
      WHERE customer_email = ${customerEmail} AND finalized_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `;

    let returnLabelResult = { attempted: false, success: false };

    if (rows.length) {
      const order = rows[0];
      const items = order.items;

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
