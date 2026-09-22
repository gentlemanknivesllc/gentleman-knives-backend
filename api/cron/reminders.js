// api/cron/reminders.js
// Runs once a day via Vercel Cron (see vercel.json). Three jobs:
//   1. Send the 7/3/1-day-before reminder emails for upcoming renewals.
//   2. Detect renewals that passed with no confirmation and apply the
//      miss-handling rules (grace -> $5 skip fee -> lapse after 2 misses).
//   3. Once a cycle resolves (confirmed, skipped, or lapsed), queue the
//      next cycle for still-active subscribers.

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sql } = require('../../lib/db');
const { SKIP_FEE, generateToken, nextRenewalDate } = require('../../lib/subscriptions');

const BASE_URL = process.env.BACKEND_URL || 'https://gentleman-knives-backend.vercel.app';

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

async function sendReminder(email, token, daysLeft) {
  const link = `${BASE_URL}/api/confirm?token=${token}`;
  const urgency = daysLeft === 1 ? 'Last call — ' : '';
  await resend.emails.send({
    from: 'onboarding@resend.dev',
    to: email,
    subject: `${urgency}Your Gentleman Knives renewal is coming up`,
    html: `<p>Your subscription renewal ships in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.</p>
           <p><a href="${link}">Click here to confirm and get your shipping label</a>, or adjust what's being sent this time.</p>
           <p>If we don't hear from you, a small $5 skip fee keeps your plan active for next time.</p>`
  });
}

module.exports = async (req, res) => {
  // Vercel Cron sends a secret header — verify it so this can't be triggered
  // by anyone who finds the URL.
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Not authorized' });
  }

  try {
    // --- 1. Send due reminders ---
    const { rows: upcoming } = await sql`
      SELECT rc.id, rc.token, rc.renewal_date, rc.reminder_7_sent, rc.reminder_3_sent, rc.reminder_1_sent, s.email
      FROM renewal_cycles rc
      JOIN subscribers s ON s.id = rc.subscriber_id
      WHERE rc.confirmed = FALSE AND s.status = 'active'
    `;

    for (const cycle of upcoming) {
      const d = daysUntil(cycle.renewal_date);
      if (d === 7 && !cycle.reminder_7_sent) {
        await sendReminder(cycle.email, cycle.token, 7);
        await sql`UPDATE renewal_cycles SET reminder_7_sent = TRUE WHERE id = ${cycle.id}`;
      } else if (d === 3 && !cycle.reminder_3_sent) {
        await sendReminder(cycle.email, cycle.token, 3);
        await sql`UPDATE renewal_cycles SET reminder_3_sent = TRUE WHERE id = ${cycle.id}`;
      } else if (d === 1 && !cycle.reminder_1_sent) {
        await sendReminder(cycle.email, cycle.token, 1);
        await sql`UPDATE renewal_cycles SET reminder_1_sent = TRUE WHERE id = ${cycle.id}`;
      }
    }

    // --- 2. Handle renewals that passed with no confirmation ---
    const { rows: missed } = await sql`
      SELECT rc.id, rc.subscriber_id, s.email, s.stripe_customer_id, s.consecutive_misses, s.tier, s.discount_pct, s.default_config
      FROM renewal_cycles rc
      JOIN subscribers s ON s.id = rc.subscriber_id
      WHERE rc.confirmed = FALSE AND rc.renewal_date < CURRENT_DATE AND s.status = 'active'
    `;

    for (const m of missed) {
      const newMissCount = m.consecutive_misses + 1;

      if (newMissCount === 1) {
        // Grace miss — no charge, just advance to the next cycle.
        await sql`UPDATE subscribers SET consecutive_misses = 1 WHERE id = ${m.subscriber_id}`;
      } else if (newMissCount === 2) {
        // Charge the $5 skip fee, tier stays active.
        try {
          const customer = await stripe.customers.retrieve(m.stripe_customer_id);
          await stripe.paymentIntents.create({
            amount: Math.round(SKIP_FEE * 100),
            currency: 'usd',
            customer: m.stripe_customer_id,
            payment_method: customer.metadata.savedPaymentMethod,
            off_session: true,
            confirm: true
          });
          await sql`UPDATE renewal_cycles SET skip_fee_charged = TRUE WHERE id = ${m.id}`;
        } catch (chargeErr) {
          console.error(`Skip fee charge failed for ${m.email}:`, chargeErr.message);
        }
        await sql`UPDATE subscribers SET consecutive_misses = 2 WHERE id = ${m.subscriber_id}`;
      } else {
        // Third consecutive miss — lapse the subscription.
        await sql`UPDATE subscribers SET status = 'lapsed' WHERE id = ${m.subscriber_id}`;
        continue; // don't queue a next cycle for a lapsed subscriber
      }

      // Queue the next cycle.
      const nextDate = nextRenewalDate(m.tier);
      const nextToken = generateToken();
      await sql`
        INSERT INTO renewal_cycles (subscriber_id, token, renewal_date)
        VALUES (${m.subscriber_id}, ${nextToken}, ${nextDate.toISOString().slice(0, 10)})
      `;
      await sql`UPDATE subscribers SET next_renewal = ${nextDate.toISOString().slice(0, 10)} WHERE id = ${m.subscriber_id}`;
    }

    res.status(200).json({ ok: true, reminded: upcoming.length, missedProcessed: missed.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Cron run failed' });
  }
};
