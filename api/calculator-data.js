// api/calculator-data.js
// Merged from what used to be two separate files (typical-prices.js and
// shipping-quote.js) to stay under Vercel's Hobby-plan limit of 12
// serverless functions per deployment. Routed by HTTP method, since these
// were already GET vs POST: GET returns typical prices, POST returns a
// live shipping quote. Same request/response shape as before either way.

const { sql } = require('../lib/db');
const { calculateShipping, nextDiscountTier } = require('../lib/shipping');

async function handleTypicalPrices(req, res) {
  const { rows } = await sql`SELECT combo, running_total, order_count FROM price_averages`;
  const averages = {};
  for (const row of rows) {
    averages[row.combo] = Math.round((row.running_total / row.order_count) * 100) / 100;
  }
  res.status(200).json({ averages });
}

async function handleShippingQuote(req, res) {
  const { items, zip } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'No items provided' });

  if (!zip || !/^\d{5}(-\d{4})?$/.test(zip.trim())) {
    return res.status(400).json({ error: 'A valid ZIP code is required for an accurate quote' });
  }

  const addressTo = {
    name: 'Estimate',
    zip: zip.trim(),
    country: 'US'
  };

  const quote = await calculateShipping(items, addressTo);

  let nudge = null;
  const next = nextDiscountTier(quote.itemCount);
  if (next) {
    const itemsNeeded = next.minItems - quote.itemCount;
    nudge = `Add ${itemsNeeded} more item${itemsNeeded > 1 ? 's' : ''} to save $${next.discount.toFixed(2)} on shipping`;
  }

  res.status(200).json({ ...quote, nudge });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      await handleTypicalPrices(req, res);
    } else if (req.method === 'POST') {
      await handleShippingQuote(req, res);
    } else {
      res.status(405).json({ error: 'Use GET or POST' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load calculator data' });
  }
};
