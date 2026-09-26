// api/raffle-enter-free.js
// The genuinely free entry path — just an email, no payment. One free
// entry per email (enforced by a unique index in the database) so this
// stays fair and can't be spammed to dominate the odds pool, while still
// being real, no-purchase-necessary participation.

const { sql } = require('../lib/db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record entry' });
  }
};
