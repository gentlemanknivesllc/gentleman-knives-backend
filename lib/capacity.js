// lib/capacity.js
// Caps how many orders can come in per week, so a busy stretch (or a video
// going well) can't overwhelm one person's real sharpening capacity. Once
// the cap is hit, create-order.js sends people to the waitlist instead of
// checkout.

const WEEKLY_ORDER_CAP = 19;

// "This week" = Monday through Sunday, based on the server's current time.
function startOfThisWeek() {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

async function checkWeeklyCapacity(sql) {
  const weekStart = startOfThisWeek();

  const { rows } = await sql`
    SELECT COUNT(*) AS count FROM orders WHERE created_at >= ${weekStart.toISOString()}
  `;
  const ordersThisWeek = parseInt(rows[0].count, 10);

  return {
    hasRoom: ordersThisWeek < WEEKLY_ORDER_CAP,
    ordersThisWeek,
    cap: WEEKLY_ORDER_CAP
  };
}

module.exports = { checkWeeklyCapacity, WEEKLY_ORDER_CAP };
