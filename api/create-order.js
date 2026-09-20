// api/create-order.js
// Called by your Squarespace calculator when the customer clicks "Continue to
// shipping & payment". Creates a Stripe Checkout Session that charges the
// shipping fee now AND saves the card so we can charge the final total later
// without the customer doing anything.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    const {
      items,
      notes,
      sharpeningEstimate,
      shippingEstimate,
      customerEmail,
      customerName
    } = req.body;

    if (!customerEmail || !shippingEstimate) {
      return res.status(400).json({ error: 'Missing customer email or shipping amount' });
    }

    // Reuse the same Stripe customer if this email has ordered before
    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
    const customer = existing.data[0] || await stripe.customers.create({
      email: customerEmail,
      name: customerName
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customer.id,
      // This is the key line: it tells Stripe to keep the card on file so a
      // later charge can happen automatically, without the customer present.
      payment_intent_data: {
        setup_future_usage: 'off_session'
      },
      // Collects the customer's mailing address right in Stripe's checkout,
      // which the webhook below uses to generate the shipping label.
      shipping_address_collection: { allowed_countries: ['US'] },
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Shipping to Gentleman Knives',
            description: 'Your knives ship to us. Final sharpening total is charged separately once received.'
          },
          unit_amount: Math.round(shippingEstimate * 100) // Stripe uses cents
        },
        quantity: 1
      }],
      // Stripe metadata fields are capped at 500 characters each, so a very
      // large order's item list could get cut off here. Fine for launch;
      // if orders get big, move this into a real database instead.
      metadata: {
        items: JSON.stringify(items || []).slice(0, 490),
        notes: (notes || '').slice(0, 490),
        sharpeningEstimate: String(sharpeningEstimate || 0),
        shippingEstimate: String(shippingEstimate)
      },
      success_url: 'https://YOURSITE.com/thank-you?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://YOURSITE.com/estimate'
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
};
