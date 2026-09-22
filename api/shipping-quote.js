// api/shipping-quote.js
// POST endpoint the calculator calls as the customer builds their cart, so
// they can see the live combined total (and the "add 1 more to save $X"
// nudge) before checkout. Does NOT charge anything — checkout re-runs this
// same calculation server-side in create-order.js so a tampered client
// value can never be trusted.

const { calculateShipping, MINIMUM_ITEMS, DISCOUNT_CAP_ITEM_COUNT } = require('../lib/shipping');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const { items, zip } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items provided' });

    // Address only needs to be good enough for a rate quote at this stage —
    // full address collection happens in Stripe Checkout.
    const addressTo = {
      name: 'Estimate',
      zip: zip || '10001', // fallback ZIP for a rough quote if not yet entered
      country: 'US'
    };

    const quote = await calculateShipping(items, addressTo);

    // Build the "one more item saves you $X" nudge, if applicable.
    let nudge = null;
    if (quote.itemCount < DISCOUNT_CAP_ITEM_COUNT) {
      const nextCount = quote.itemCount + 1;
      if (nextCount > MINIMUM_ITEMS) {
        const currentDiscount = quote.discount;
        const nextDiscount = Math.min(nextCount - MINIMUM_ITEMS, DISCOUNT_CAP_ITEM_COUNT - MINIMUM_ITEMS) * 0.75;
        const gain = Math.round((nextDiscount - currentDiscount) * 100) / 100;
        if (gain > 0) nudge = `Add 1 more item to save $${gain.toFixed(2)} on shipping`;
      }
    }

    res.status(200).json({ ...quote, nudge });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not calculate shipping' });
  }
};
