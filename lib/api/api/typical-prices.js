// api/typical-prices.js
// GET endpoint — returns the current running average price per combo.
// Called by the calculator on load to show "Most customers pay ~$X".
// Seeded with your original high-estimate numbers (see schema.sql) so this
// never returns empty, even before a single real order has finalized.

const { sql } = require('../lib/db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  try {
    const { rows } = await sql`SELECT combo, running_total, order_count FROM price_averages`;
    const averages = {};
    for (const row of rows) {
      averages[row.combo] = Math.round((row.running_total / row.order_count) * 100) / 100;
    }
    res.status(200).json({ averages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load typical prices' });
  }
};
