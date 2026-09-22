// lib/estimates.js
// Mirrors the calculator's own pricing logic, used server-side so
// finalize-order.js can figure out how much of a confirmed real total to
// attribute to each item combo when updating the running price averages.

const SIZE_MAX_INCHES = { small: 4, medium: 7, large: 11 };
const RATE_PER_INCH = { straight: 2, serrated: 4 };

function estimateForItem(item) {
  if (item.category === 'scissors') return 5;
  const maxInches = SIZE_MAX_INCHES[item.size] || 4;
  const rate = RATE_PER_INCH[item.category] || 2;
  return maxInches * rate;
}

function comboKey(item) {
  return item.category === 'scissors' ? 'scissors' : `${item.category}_${item.size}`;
}

module.exports = { estimateForItem, comboKey };
