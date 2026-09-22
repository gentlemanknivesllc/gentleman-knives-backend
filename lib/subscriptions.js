// lib/subscriptions.js

const crypto = require('crypto');

const TIER_DISCOUNTS = {
  quarterly: 0.15,
  semiannual: 0.10,
  annual: 0.05
};

const TIER_MONTHS = {
  quarterly: 3,
  semiannual: 6,
  annual: 12
};

const SKIP_FEE = 5;

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function nextRenewalDate(tier, from = new Date()) {
  return addMonths(from, TIER_MONTHS[tier] || 3);
}

module.exports = { TIER_DISCOUNTS, TIER_MONTHS, SKIP_FEE, generateToken, addMonths, nextRenewalDate };
