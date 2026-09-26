// api/raffle-status.js
// Called by the raffle page on load (and periodically) to get the real,
// live numbers — total entries for odds display, and the paid-entry count
// that actually drives the knife-count bar and graphic.

const { sql } = require('../lib/db');
const { getRaffleStatus } = require('../lib/raffle');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  try {
    const { rows: freeRows } = await sql`
      SELECT COUNT(*) AS count FROM raffle_entries WHERE entry_type = 'free'
    `;
    const { rows: paidRows } = await sql`
      SELECT COALESCE(SUM(quantity), 0) AS count FROM raffle_entries WHERE entry_type = 'paid'
    `;

    const freeEntryCount = parseInt(freeRows[0].count, 10);
    const paidEntryCount = parseInt(paidRows[0].count, 10);

    const status = getRaffleStatus(paidEntryCount);

    res.status(200).json({
      ...status,
      freeEntryCount,
      totalEntriesForOdds: freeEntryCount + paidEntryCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load raffle status' });
  }
};
