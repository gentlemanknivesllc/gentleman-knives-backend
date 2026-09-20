// api/finalize-order.js
// Called (via admin.html) once your friend has actually opened the package
// and knows the real total. Charges the card that was saved during checkout
// — the customer does not need to do anything or click any link.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  // Very simple protection so random people on the internet can't trigger
  // charges. Set ADMIN_SECRET to a long random string in your environment
  // variables, and only share it with your friend.
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
      off_session: true, // this is what allows the charge with no customer present
      confirm: true
    });

    res.status(200).json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error(err);
    // Common real-world case: the card was declined or requires the customer
    // to re-authenticate. err.message will say why.
    res.status(500).json({ error: err.message });
  }
};
