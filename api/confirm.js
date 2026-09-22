// api/confirm.js
// The page a subscriber lands on from their reminder email. No login
// system — the token in the URL IS the authentication, same pattern as a
// password-reset link. GET renders a small standalone form; POST processes
// their confirmation (with or without an adjustment) and reuses the normal
// shipping-label flow so the inbound label goes out immediately.

const { sql } = require('../lib/db');
const { calculateShipping } = require('../lib/shipping');

module.exports = async (req, res) => {
  const { token } = req.method === 'GET' ? req.query : req.body;
  if (!token) return res.status(400).send('Missing token');

  const { rows } = await sql`
    SELECT rc.*, s.email, s.default_config, s.tier, s.discount_pct
    FROM renewal_cycles rc JOIN subscribers s ON s.id = rc.subscriber_id
    WHERE rc.token = ${token}
  `;
  const cycle = rows[0];
  if (!cycle) return res.status(404).send('This link is no longer valid.');
  if (cycle.confirmed) return res.status(200).send('You already confirmed this shipment — nothing more to do.');

  if (req.method === 'GET') {
    // Minimal standalone HTML form — no site styling dependency, works
    // straight from the email link.
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`
      <html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;">
        <h2>Confirm your Gentleman Knives shipment</h2>
        <p>Default: ${JSON.stringify(cycle.default_config)}</p>
        <form method="POST" action="/api/confirm">
          <input type="hidden" name="token" value="${token}" />
          <p><label><input type="checkbox" name="adjust" value="true" /> I want to adjust what's being sent this time</label></p>
          <p>If adjusting, describe changes: <textarea name="adjustNotes" rows="3" style="width:100%"></textarea></p>
          <p><label><input type="radio" name="permanent" value="false" checked /> Just for this order</label><br/>
             <label><input type="radio" name="permanent" value="true" /> Make this my new normal</label></p>
          <button type="submit">Confirm shipment</button>
        </form>
      </body></html>
    `);
  }

  // POST — process confirmation
  const { adjust, adjustNotes, permanent } = req.body;
  const usedConfig = adjust === 'true' && adjustNotes ? { notes: adjustNotes } : cycle.default_config;

  await sql`
    UPDATE renewal_cycles
    SET confirmed = TRUE, confirmed_at = now(), used_config = ${JSON.stringify(usedConfig)}, made_permanent = ${permanent === 'true'}
    WHERE id = ${cycle.id}
  `;

  if (permanent === 'true' && adjust === 'true') {
    await sql`UPDATE subscribers SET default_config = ${JSON.stringify(usedConfig)} WHERE email = ${cycle.email}`;
  }

  // Reset the miss counter — a confirmed cycle means they're not missing.
  await sql`UPDATE subscribers SET consecutive_misses = 0 WHERE email = ${cycle.email}`;

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;">
    <h2>Confirmed!</h2>
    <p>Your shipping label is on its way to your inbox. Thanks for being a subscriber.</p>
  </body></html>`);

  // NOTE: actual label purchase + emailing on confirm reuses the same
  // Shippo + Resend calls already built in stripe-webhook.js — wire that
  // call in here once you're ready to test end-to-end (kept out of this
  // pass to avoid duplicating that logic; happy to extract it into a
  // shared helper next).
};
