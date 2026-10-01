// api/raffle-status.js
// GET: called by the raffle page on load (and periodically) to get the
// real, live numbers — total entries for odds display, and the paid-entry
// count that actually drives the knife-count bar and graphic. Public.
//
// POST: admin-only. Draws one random winner, weighted correctly so every
// individual entry (free or paid, including each of a bulk paid purchase)
// has an equal chance — not just an equal chance per database row.
// Combined into this file (rather than a new one) to stay under Vercel's
// Hobby-plan function limit.

const crypto = require('crypto');
const { sql } = require('../lib/db');
const { getRaffleStatus } = require('../lib/raffle');

async function handleStatus(req, res) {
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
}

async function handleDrawWinner(req, res) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Not authorized' });
  }

  const { rows } = await sql`SELECT id, email, entry_type, quantity FROM raffle_entries`;
  if (!rows.length) {
    return res.status(400).json({ error: 'No entries to draw from' });
  }

  const totalEntries = rows.reduce((sum, r) => sum + r.quantity, 0);

  // Picks a random integer across the FULL ticket pool (not a random row),
  // so a bulk paid purchase of, say, 50 entries genuinely gets 50x the
  // chance of a single free entry, exactly as the rules promise.
  const winningTicket = crypto.randomInt(0, totalEntries);

  let runningTotal = 0;
  let winner = null;
  for (const row of rows) {
    runningTotal += row.quantity;
    if (winningTicket < runningTotal) {
      winner = row;
      break;
    }
  }

  res.status(200).json({
    winnerEmail: winner.email,
    winnerEntryType: winner.entry_type,
    winnerRowQuantity: winner.quantity,
    totalEntries,
    totalRows: rows.length,
    winningTicketNumber: winningTicket
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      await handleStatus(req, res);
    } else if (req.method === 'POST') {
      await handleDrawWinner(req, res);
    } else {
      res.status(405).json({ error: 'Use GET or POST' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not process request' });
  }
};
