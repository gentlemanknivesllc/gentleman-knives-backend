// api/raffle-enter-paid.js
// Creates a Stripe Checkout session for paid raffle entries, $5 each. The
// entry doesn't actually get recorded here — only once Stripe confirms the
// payment succeeded, via the webhook (same pattern as regular orders:
// never record something as "paid" before the money has actually cleared).

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { ENTRY_PRICE } = require('../lib/raffle');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const { email, quantity } = req.body;
    const qty = parseInt(quantity, 10);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!qty || qty < 1 || qty > 500) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 500' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Gentleman Knives Raffle — ${qty} extra ${qty === 1 ? 'entry' : 'entries'}`
          },
          unit_amount: Math.round(ENTRY_PRICE * 100)
        },
        quantity: qty
      }],
      metadata: {
        type: 'raffle_entry',
        email,
        quantity: String(qty)
      },
      success_url: 'https://www.gentlemanknives.co/promotions?entered=1',
      cancel_url: 'https://www.gentlemanknives.co/promotions'
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
};
