// api/stripe-webhook.js
// Stripe calls this automatically the instant a shipping payment succeeds.
// This is where the label actually gets generated and emailed — no one has
// to click anything for this to happen.

const Stripe = require('stripe');
const { Shippo } = require('shippo');
const { Resend } = require('resend');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const shippo = new Shippo({ apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}` });
const resend = new Resend(process.env.RESEND_API_KEY);

// Stripe needs the raw, unparsed request body to verify this request really
// came from Stripe (not someone pretending to be Stripe).
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['payment_intent', 'customer']
    });

    const shippingAddress = fullSession.shipping_details ? fullSession.shipping_details.address : null;
    const customerEmail = fullSession.customer_details.email;
    const customerName = fullSession.customer_details.name;
    const paymentMethodId = fullSession.payment_intent.payment_method;

    // Save the payment method on the customer record so finalize-order.js
    // can find it later and charge the confirmed total automatically.
    await stripe.customers.update(fullSession.customer.id, {
      metadata: { savedPaymentMethod: paymentMethodId }
    });

    if (shippingAddress) {
      try {
        const fromAddress = {
          name: process.env.BUSINESS_NAME,
          street1: process.env.BUSINESS_STREET,
          city: process.env.BUSINESS_CITY,
          state: process.env.BUSINESS_STATE,
          zip: process.env.BUSINESS_ZIP,
          country: 'US'
        };

        const toAddress = {
          name: customerName,
          street1: shippingAddress.line1,
          street2: shippingAddress.line2 || '',
          city: shippingAddress.city,
          state: shippingAddress.state,
          zip: shippingAddress.postal_code,
          country: shippingAddress.country
        };

        // NOTE: weight/dimensions are hardcoded for now. Once you're ready,
        // pull the box tier + estimated weight from the calculator's order
        // data (it's sitting in fullSession.metadata) and set these dynamically.
        const shipment = await shippo.shipments.create({
          addressFrom: fromAddress,
          addressTo: toAddress,
          parcels: [{
            length: '10',
            width: '8',
            height: '4',
            distanceUnit: 'in',
            weight: '2',
            massUnit: 'lb'
          }],
          async: false
        });

        const cheapestRate = shipment.rates
          .slice()
          .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];

        const transaction = await shippo.transactions.create({
          rate: cheapestRate.objectId,
          labelFileType: 'PDF',
          async: false
        });

        await resend.emails.send({
          from: 'onboarding@resend.dev',
          to: customerEmail,
          subject: 'Your Gentleman Knives shipping label',
          html: `
            <p>Thanks for your order! Print the label below and ship your knives to us.</p>
            <p><a href="${transaction.labelUrl}">Download your shipping label</a></p>
            <p>Tracking number: ${transaction.trackingNumber}</p>
            <p>We'll email you the final total once we receive and measure your items.</p>
          `
        });
      } catch (err) {
        // Payment already succeeded at this point, so we log this rather
        // than fail the whole webhook — you don't want Stripe retrying a
        // charge that already worked. Check your Vercel logs if a label
        // doesn't go out.
        console.error('Shippo/email step failed:', err);
      }
    }
  }

  res.status(200).json({ received: true });
};
