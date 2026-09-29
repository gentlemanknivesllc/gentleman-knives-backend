// api/raffle-enter.js
// Merged from what used to be two separate files (raffle-enter-free.js and
// raffle-enter-paid.js) to stay under Vercel's Hobby-plan limit of 12
// serverless functions per deployment. Same two entry paths as before,
// now both live here — just pass { type: 'free', email } or
// { type: 'paid', email, quantity } in the request body.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sql } = require('../lib/db');
const { ENTRY_PRICE } = require('../lib/raffle');

async function handleFreeEntry(req, res) {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  try {
    await sql`
      INSERT INTO raffle_entries (email, entry_type, quantity)
      VALUES (${email.trim().toLowerCase()}, 'free', 1)
    `;
  } catch (dbErr) {
    // Unique index violation = this email already has a free entry.
    if (dbErr.message && dbErr.message.includes('duplicate key')) {
      return res.status(409).json({ error: 'This email has already claimed a free entry' });
    }
    throw dbErr;
  }

  res.status(200).json({ success: true });
}

async function handlePaidEntry(req, res) {
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
          name: `Gentleman Knives Raffle: ${qty} extra ${qty === 1 ? 'entry' : 'entries'}`
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
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    if (req.body.type === 'paid') {
      await handlePaidEntry(req, res);
    } else {
      await handleFreeEntry(req, res);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not process entry' });
  }
};
