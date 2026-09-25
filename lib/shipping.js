// lib/shipping.js
// Live shipping cost calculation. Replaces the old fixed weight-tier table
// with a real-time Shippo quote, plus the per-item discount agreed on.
//
// Per-item base weights (lbs) — used to build the package Shippo quotes:
const ITEM_WEIGHT = {
  straight_small: 0.25,
  straight_medium: 0.4,
  straight_large: 0.6,
  serrated_small: 0.25,
  serrated_medium: 0.4,
  serrated_large: 0.6,
  scissors: 0.3
};

// Packaging buffers — inbound is unknown (customer's own box/envelope), so we
// pad generously to avoid an under-paid label getting flagged at the post
// office. Outbound is packed by us, so it can stay lean.
const INBOUND_PACKAGING_BUFFER_LB = 0.3;
const OUTBOUND_PACKAGING_BUFFER_LB = 0.2;

// Item-count discount: flat jumps at two thresholds, rewarding bigger
// bundled orders more clearly than a small per-item increment did.
const MINIMUM_ITEMS = 3;
const DISCOUNT_TIERS = [
  { minItems: 8, discount: 5 },
  { minItems: 5, discount: 3 }
]; // checked in this order (highest threshold first) so the biggest tier a count qualifies for wins

function totalItemWeight(items) {
  return items.reduce((sum, item) => {
    const key = item.category === 'scissors' ? 'scissors' : `${item.category}_${item.size}`;
    const perItem = ITEM_WEIGHT[key] || 0.4; // fallback if something unexpected slips through
    return sum + perItem * (item.qty || 1);
  }, 0);
}

function itemCount(items) {
  return items.reduce((sum, item) => sum + (item.qty || 1), 0);
}

function calculateDiscount(count) {
  for (const tier of DISCOUNT_TIERS) {
    if (count >= tier.minItems) return tier.discount;
  }
  return 0;
}

// Tells the calculator how close the customer is to the next discount
// jump, for the "add N more to save $X" nudge. Returns null if they're
// already at the top tier.
function nextDiscountTier(count) {
  const ascending = DISCOUNT_TIERS.slice().sort((a, b) => a.minItems - b.minItems);
  for (const tier of ascending) {
    if (count < tier.minItems) return tier;
  }
  return null;
}

// Pulls a real Ground Advantage quote from Shippo for a given weight (lbs).
// Falls back to a conservative estimate if Shippo is unreachable, so
// checkout never hard-fails over a shipping-quote hiccup.
async function getShippoQuote(weightLb, addressTo) {
  // Reuses the same address object as lib/labels.js instead of keeping a
  // separate copy — this was the actual root cause of the 429s: this
  // duplicate was missing the email/phone fields USPS requires.
  const { businessAddress } = require('./labels');
  const addressFrom = businessAddress();

  // Simple box-size heuristic off weight; refine later with real dimensions
  // once you know what boxes/envelopes you're actually using.
  const dims = weightLb <= 1
    ? { length: '9', width: '6', height: '2', distanceUnit: 'in' }
    : weightLb <= 4
      ? { length: '11', width: '8.5', height: '4', distanceUnit: 'in' }
      : { length: '13', width: '11', height: '6', distanceUnit: 'in' };

  try {
    // Setting up the Shippo client now lives INSIDE this try block. Before,
    // it sat above the try — so if this setup ever failed for any reason,
    // the whole request crashed with a 500 instead of falling back to the
    // conservative estimate below like it was supposed to.
    const ShippoModule = require('shippo');
    const ShippoClient = ShippoModule.Shippo || ShippoModule.default || ShippoModule;
    const shippo = new ShippoClient({ apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}` });

    const shipment = await shippo.shipments.create({
      addressFrom,
      addressTo,
      parcels: [{
        ...dims,
        weight: String(weightLb),
        massUnit: 'lb'
      }],
      async: false
    });

    const groundAdvantage = (shipment.rates || [])
      .filter(r => r.provider === 'USPS' && /ground advantage/i.test(r.servicelevel?.name || ''))
      .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];

    if (groundAdvantage) return parseFloat(groundAdvantage.amount);

    // No Ground Advantage rate returned — fall back to cheapest available.
    const cheapest = (shipment.rates || []).sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];
    if (cheapest) return parseFloat(cheapest.amount);

    throw new Error('No rates returned from Shippo');
  } catch (err) {
    console.error('Shippo quote failed, using fallback estimate:', err.message);
    // Conservative fallback so checkout still works if Shippo is down.
    if (weightLb <= 1) return 9;
    if (weightLb <= 2) return 11;
    if (weightLb <= 5) return 14;
    return 17;
  }
}

// Main entry point: given the cart items and a destination address, returns
// the full shipping breakdown for checkout.
async function calculateShipping(items, addressTo) {
  const count = itemCount(items);
  const baseWeight = totalItemWeight(items);

  const inboundWeight = Math.round((baseWeight + INBOUND_PACKAGING_BUFFER_LB) * 100) / 100;
  const outboundWeight = Math.round((baseWeight + OUTBOUND_PACKAGING_BUFFER_LB) * 100) / 100;

  const [inboundCost, outboundCost] = await Promise.all([
    getShippoQuote(inboundWeight, addressTo),
    getShippoQuote(outboundWeight, addressTo)
  ]);

  const roundTripCost = Math.round((inboundCost + outboundCost) * 100) / 100;
  const discount = calculateDiscount(count);
  const finalShipping = Math.max(0, Math.round((roundTripCost - discount) * 100) / 100);

  return {
    itemCount: count,
    inboundWeight,
    outboundWeight,
    roundTripCost,
    discount,
    finalShipping,
    meetsMinimum: count >= MINIMUM_ITEMS
  };
}

module.exports = {
  calculateShipping,
  itemCount,
  totalItemWeight,
  MINIMUM_ITEMS,
  nextDiscountTier,
  INBOUND_PACKAGING_BUFFER_LB,
  OUTBOUND_PACKAGING_BUFFER_LB
};
