// api/local-order.js
// Called by the local-sharpening page once the customer fills out the
// intake form and picks drop-off or delivery.
//
// DROP-OFF: no charge right now — just saves a card on file (Stripe
// "setup" mode checkout), exactly like create-order.js saves a card for
// the LATER sharpening charge on mail-in orders. finalize-order.js charges
// the real total once your friend has measured the knives.
//
// DELIVERY: charges the delivery fee RIGHT NOW (a real Google Distance
// Matrix drive-time lookup decides the fee and whether the address even
// qualifies — see lib/delivery.js) and ALSO saves the card for that same
// later sharpening charge. Same "charge the logistics cost now, sharpening
// cost later" split as the mail-in flow's shipping charge.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sql } = require('../lib/db');
const { MINIMUM_ITEMS } = require('../lib/shipping');
const { checkWeeklyCapacity } = require('../lib/capacity');
const { calculateDeliveryFee } = require('../lib/delivery');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const {
      fulfillment, // 'dropoff' | 'delivery'
      items,
      notes,
      sharpeningEstimate,
      customerEmail,
      customerName,
      customerPhone,
      address // required for delivery: { street1, street2, city, state, zip }
    } = req.body;

    if (fulfillment !== 'dropoff' && fulfillment !== 'delivery') {
      return res.status(400).json({ error: 'fulfillment must be "dropoff" or "delivery"' });
    }

    // Preview mode: called live from the calculator as the customer types
    // their address, just to show the delivery fee before they commit to
    // anything. No order is created, no capacity is checked, no Stripe
    // session happens here — it only runs the same real distance lookup
    // that the real booking below uses, so the number shown never drifts
    // from what actually gets charged.
    if (req.body.preview) {
      if (fulfillment !== 'delivery') return res.status(200).json({ fee: 0, eligible: true });
      if (!address || !address.street1 || !address.city || !address.state || !address.zip) {
        return res.status(400).json({ error: 'A full address is required to preview the delivery fee' });
      }
      try {
        const delivery = await calculateDeliveryFee(address);
        return res.status(200).json({
          eligible: delivery.eligible,
          fee: delivery.fee,
          oneWayMinutes: delivery.oneWayMinutes,
          message: !delivery.eligible
            ? `That address is about ${delivery.oneWayMinutes} min away, which is outside our 30-minute delivery range. Please choose drop-off instead.`
            : undefined
        });
      } catch (distErr) {
        console.error('Delivery preview lookup failed:', distErr.message);
        return res.status(502).json({ error: 'Could not look up that address right now.' });
      }
    }

    if (!customerEmail || !items || !items.length) {
      return res.status(400).json({ error: 'Missing customer email or items' });
    }

    const count = items.reduce((sum, i) => sum + (i.qty || 1), 0);
    if (count < MINIMUM_ITEMS) {
      return res.status(400).json({ error: `Minimum order is ${MINIMUM_ITEMS} items` });
    }

    // Local orders count against the same weekly capacity as mail-in ones —
    // it's the same person sharpening either way.
    const capacity = await checkWeeklyCapacity(sql);
    if (!capacity.hasRoom) {
      return res.status(409).json({
        error: 'waitlist',
        message: `We're at capacity for this week (${capacity.cap} orders). Join the waitlist and we'll email you the moment a slot opens.`,
        ordersThisWeek: capacity.ordersThisWeek,
        cap: capacity.cap
      });
    }

    let deliveryFee = 0;
    let oneWayMinutes = null;

    if (fulfillment === 'delivery') {
      if (!address || !address.street1 || !address.city || !address.state || !address.zip) {
        return res.status(400).json({ error: 'A full address is required for delivery' });
      }

      let delivery;
      try {
        delivery = await calculateDeliveryFee(address);
      } catch (distErr) {
        console.error('Delivery distance lookup failed:', distErr.message);
        return res.status(502).json({ error: 'Could not verify your delivery distance right now. Please try drop-off instead, or contact us directly.' });
      }

      if (!delivery.eligible) {
        return res.status(400).json({
          error: 'too_far',
          message: `That address is about ${delivery.oneWayMinutes} min away, which is outside our 30-minute delivery range. Please choose drop-off instead, or contact us directly.`
        });
      }
      deliveryFee = delivery.fee;
      oneWayMinutes = delivery.oneWayMinutes;
    }

    // Reuse the same Stripe customer if this email has ordered before.
    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
    const customer = existing.data[0] || await stripe.customers.create({
      email: customerEmail,
      name: customerName,
      phone: customerPhone
    });

    const metadata = {
      type: 'local_order',
      fulfillment,
      items: JSON.stringify(items).slice(0, 400),
      notes: (notes || '').slice(0, 300),
      sharpeningEstimate: String(sharpeningEstimate || 0),
      deliveryFee: String(deliveryFee),
      oneWayMinutes: oneWayMinutes !== null ? String(oneWayMinutes) : '',
      itemCount: String(count)
    };

    let session;
    if (fulfillment === 'dropoff') {
      // Nothing charged today — this just gets a card on file so the real
      // sharpening total can be charged later, off-session.
      session = await stripe.checkout.sessions.create({
        mode: 'setup',
        customer: customer.id,
        payment_method_types: ['card'],
        metadata,
        success_url: 'https://www.gentlemanknives.co/thank-you-local?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://www.gentlemanknives.co/sharpening'
      });
    } else {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customer.id,
        // Saves the card for the LATER sharpening charge, same as shipping
        // does on the mail-in flow.
        payment_intent_data: { setup_future_usage: 'off_session' },
        phone_number_collection: { enabled: true },
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Gentleman Knives — Local delivery (both ways)',
              description: `Covers us picking up and dropping off your knives (about ${oneWayMinutes} min each way). Your sharpening total is charged separately, once we measure your items.`
            },
            unit_amount: Math.round(deliveryFee * 100)
          },
          quantity: 1
        }],
        metadata,
        success_url: 'https://www.gentlemanknives.co/thank-you-local?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://www.gentlemanknives.co/sharpening'
      });
    }

    // Log the order up front (pending finalization), same pattern as
    // create-order.js — nothing depends on the webhook alone for records.
    await sql`
      INSERT INTO orders (stripe_session_id, customer_email, items, sharpening_total, shipping_charged, fulfillment_type, delivery_fee)
      VALUES (${session.id}, ${customerEmail}, ${JSON.stringify(items)}, ${sharpeningEstimate || 0}, 0, ${fulfillment}, ${deliveryFee})
    `;

    res.status(200).json({ url: session.url, deliveryFee, oneWayMinutes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
};
