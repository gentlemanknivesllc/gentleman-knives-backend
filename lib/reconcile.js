// lib/reconcile.js
//
// WHY THIS EXISTS: on at least one real payment, Stripe's webhook never
// recorded the raffle entry in the database — the charge went through fine,
// but nothing got written to raffle_entries. Diagnosing that normally means
// digging through Stripe's dashboard (Developers -> Webhooks -> Events),
// which requires the Stripe login that only lives on one phone. This
// sidesteps that entirely: it asks Stripe directly, using the same secret
// key the server already has, "which raffle checkouts actually completed?"
// and backfills anything the database is missing. No dashboard needed.
//
// SAFE BY DESIGN: this only ever inserts rows into raffle_entries. It never
// touches Stripe (no charges, no refunds), never buys a shipping label, and
// never sends an email. A raffle entry has no side effects beyond "it counts
// toward the pool," so backfilling one late is harmless. (Deliberately NOT
// doing this same trick for sharpening orders — those involve labels/emails
// that could double-send, so a missing mail-in/local order should still be
// checked by hand.)
//
// NOT its own api/ file on purpose — Vercel's Hobby plan caps a deployment
// at 12 serverless functions, and this project is already right at that
// limit. This plain lib/ file gets called from inside raffle-status.js's
// existing POST handler instead of adding a 13th function.
//
// Safe to run as many times as you want — it only inserts a session's
// entry if that stripe_session_id isn't already in the table, so running
// it twice in a row does nothing the second time.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sql } = require('./db');

async function reconcileRaffleEntries() {
    // Pull completed Checkout Sessions straight from Stripe — this is the
    // ground truth, independent of whether any webhook ever fired. 100 is
    // Stripe's per-page max; this business isn't doing more than 100
    // checkouts between runs of this, so one page is enough.
    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      status: 'complete'
    });

    const raffleSessions = sessions.data.filter(
      (s) => s.metadata && s.metadata.type === 'raffle_entry'
    );

    const results = [];

    for (const session of raffleSessions) {
      const { rows } = await sql`
        SELECT id FROM raffle_entries WHERE stripe_session_id = ${session.id}
      `;

      if (rows.length > 0) {
        results.push({ sessionId: session.id, status: 'already recorded', email: session.metadata.email });
        continue;
      }

      const email = (session.metadata.email || '').trim().toLowerCase();
      const quantity = parseInt(session.metadata.quantity, 10) || 1;

      if (!email) {
        results.push({ sessionId: session.id, status: 'SKIPPED — no email in metadata, needs manual look' });
        continue;
      }

      await sql`
        INSERT INTO raffle_entries (email, entry_type, quantity, stripe_session_id)
        VALUES (${email}, 'paid', ${quantity}, ${session.id})
      `;

      results.push({
        sessionId: session.id,
        status: 'BACKFILLED — was missing, now inserted',
        email,
        quantity,
        amountPaid: session.amount_total / 100,
        paidAt: new Date(session.created * 1000).toISOString()
      });
    }

    const backfilled = results.filter((r) => r.status.startsWith('BACKFILLED'));

    return {
      totalRaffleCheckoutsFoundInStripe: raffleSessions.length,
      backfilledCount: backfilled.length,
      details: results
    };
}

module.exports = { reconcileRaffleEntries };
