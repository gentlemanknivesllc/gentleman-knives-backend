// api/confirm.js
// The page a subscriber lands on from their reminder email. No login
// system — the token in the URL IS the authentication, same pattern as a
// password-reset link. GET renders a small standalone form; POST processes
// their confirmation, charges shipping (both ways, same as a regular
// order's checkout), and buys + emails the inbound label. The sharpening
// total is still charged separately later, by finalize-subscription-order.js.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sql } = require('../lib/db');
const { totalItemWeight, INBOUND_PACKAGING_BUFFER_LB, calculateShipping } = require('../lib/shipping');
const { purchaseLabel, emailInboundLabel } = require('../lib/labels');

module.exports = async (req, res) => {
  const { token } = req.method === 'GET' ? req.query : req.body;
  if (!token) return res.status(400).send('Missing token');

  const { rows } = await sql`
    SELECT rc.*, s.email, s.default_config, s.tier, s.discount_pct, s.shipping_address, s.stripe_customer_id
    FROM renewal_cycles rc JOIN subscribers s ON s.id = rc.subscriber_id
    WHERE rc.token = ${token}
  `;
  const cycle = rows[0];
  if (!cycle) return res.status(404).send('This link is no longer valid.');
  if (cycle.confirmed) return res.status(200).send('You already confirmed this shipment, nothing more to do.');

  if (req.method === 'GET') {
    // Show the real live shipping quote before they confirm, same
    // transparency as a regular checkout.
    let quotedShipping = null;
    try {
      if (Array.isArray(cycle.default_config) && cycle.shipping_address) {
        const quote = await calculateShipping(cycle.default_config, { zip: cycle.shipping_address.zip, country: 'US' });
        quotedShipping = quote.finalShipping;
      }
    } catch (quoteErr) {
      console.error('Could not pre-quote subscription shipping:', quoteErr.message);
    }

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`
      <html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;">
        <h2>Confirm your Gentleman Knives shipment</h2>
        <p>Default: ${JSON.stringify(cycle.default_config)}</p>
        <p style="font-size:13px;color:#666;">Confirming will charge your card on file ${quotedShipping !== null ? `<strong>$${quotedShipping.toFixed(2)}</strong> ` : ''}for shipping (both ways). Your sharpening total is charged separately once we receive and measure your items.</p>
        <form method="POST" action="/api/confirm">
          <input type="hidden" name="token" value="${token}" />
          <p><label><input type="checkbox" name="adjust" value="true" /> I want to adjust what's being sent this time</label></p>
          <p>If adjusting, describe changes: <textarea name="adjustNotes" rows="3" style="width:100%"></textarea></p>
          <p style="font-size:12px;color:#666;">Note: free-text adjustments are still packed and weighed by hand on our end, the shipping label and charge use your standard config's weight as a starting estimate.</p>
          <p><label><input type="radio" name="permanent" value="false" checked /> Just for this order</label><br/>
             <label><input type="radio" name="permanent" value="true" /> Make this my new normal</label></p>
          <button type="submit">Confirm shipment</button>
        </form>
      </body></html>
    `);
  }

  // POST — process confirmation
  const { adjust, adjustNotes, permanent } = req.body;
  const isAdjusting = adjust === 'true' && adjustNotes;
  const usedConfig = isAdjusting ? { notes: adjustNotes } : cycle.default_config;

  // Structured item list (array) lets us calculate real weight and a real
  // shipping charge. A free-text adjustment doesn't, so we fall back to
  // the standing default as the best available estimate for both.
  const itemsForShipping = Array.isArray(usedConfig) ? usedConfig
    : (Array.isArray(cycle.default_config) ? cycle.default_config : []);

  // --- Charge shipping FIRST. If this fails (card declined, etc.), don't
  // ship anything and don't mark the cycle confirmed — leave it for the
  // normal miss-handling in the cron job rather than shipping for free. ---
  let shippingCharge;
  try {
    if (!cycle.shipping_address) throw new Error('No shipping address on file for this subscriber');
    if (!itemsForShipping.length) throw new Error('No structured item list available to calculate shipping');

    const quote = await calculateShipping(itemsForShipping, { zip: cycle.shipping_address.zip, country: 'US' });

    const customer = await stripe.customers.retrieve(cycle.stripe_customer_id);
    if (!customer.metadata.savedPaymentMethod) throw new Error('No saved payment method on file');

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(quote.finalShipping * 100),
      currency: 'usd',
      customer: cycle.stripe_customer_id,
      payment_method: customer.metadata.savedPaymentMethod,
      off_session: true,
      confirm: true
    });

    shippingCharge = { success: true, amount: quote.finalShipping, paymentIntentId: paymentIntent.id };
  } catch (chargeErr) {
    console.error(`Subscription shipping charge failed for ${cycle.email}:`, chargeErr.message);
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`<html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;">
      <h2>We couldn't process your payment</h2>
      <p>We tried to charge your card on file for shipping and it didn't go through. Please contact us so we can update your payment method and get this cycle shipped out.</p>
    </body></html>`);
  }

  // Charge succeeded — now mark confirmed and proceed exactly as before.
  await sql`
    UPDATE renewal_cycles
    SET confirmed = TRUE, confirmed_at = now(), used_config = ${JSON.stringify(usedConfig)},
        made_permanent = ${permanent === 'true'}, shipping_charged = ${shippingCharge.amount}
    WHERE id = ${cycle.id}
  `;

  if (permanent === 'true' && isAdjusting) {
    await sql`UPDATE subscribers SET default_config = ${JSON.stringify(usedConfig)} WHERE email = ${cycle.email}`;
  }

  await sql`UPDATE subscribers SET consecutive_misses = 0 WHERE email = ${cycle.email}`;

  // --- Buy and email the label ---
  let labelResult = { success: false };
  try {
    const weightLb = Math.round((totalItemWeight(itemsForShipping) + INBOUND_PACKAGING_BUFFER_LB) * 100) / 100;

    const label = await purchaseLabel({
      direction: 'inbound',
      customerAddress: cycle.shipping_address,
      weightLb
    });

    await emailInboundLabel(cycle.email, label);
    labelResult = { success: true };
  } catch (labelErr) {
    // The shipping charge already succeeded at this point, so we don't
    // undo that, we just flag that the label needs manual follow-up.
    console.error(`Subscription label purchase failed for ${cycle.email}:`, labelErr.message);
    labelResult = { success: false, error: labelErr.message };
  }

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;">
    <h2>Confirmed!</h2>
    <p>${labelResult.success
      ? 'Your shipping label is on its way to your inbox. Thanks for being a subscriber.'
      : 'Your payment went through, but something went wrong generating your label automatically. We\'ll follow up by email shortly with it directly.'}</p>
  </body></html>`);
};
