// lib/delivery.js
// Real drive-time based delivery fee for the local pickup/drop-off service.
//
// Your friend's actual driving cost is $12 per 80 minutes of driving, i.e.
// $0.15/min. "Both directions" (confirmed) covers 4 one-way legs total —
// the round trip to pick knives up, and the round trip to drop them back
// off — so the fee is:
//
//   fee = oneWayMinutes x 4 x $0.15/min = oneWayMinutes x $0.60
//
// capped at the 30-minute max delivery range, i.e. a $18 ceiling. Anything
// further than 30 minutes one-way isn't eligible for delivery at all —
// those customers should use free drop-off instead.
//
// Requires GOOGLE_MAPS_API_KEY (a Google Cloud API key with the Distance
// Matrix API enabled) in your Vercel env vars. Reuses the same
// BUSINESS_STREET/CITY/STATE/ZIP env vars already set up for Shippo as the
// starting point for the drive.

const ONE_WAY_RATE_PER_MINUTE = 0.60; // 4 legs x $0.15/min
const MAX_ONE_WAY_MINUTES = 30;
const MAX_FEE = Math.round(MAX_ONE_WAY_MINUTES * ONE_WAY_RATE_PER_MINUTE * 100) / 100; // $18

function businessOrigin() {
  return [
    process.env.BUSINESS_STREET,
    process.env.BUSINESS_CITY,
    process.env.BUSINESS_STATE,
    process.env.BUSINESS_ZIP
  ].filter(Boolean).join(', ');
}

// Calls Google's Distance Matrix API for real driving time from the
// business address to the customer's address. Throws if the API isn't
// reachable/configured or the address can't be geocoded — callers should
// not silently fall back to a guessed fee, since that's real money.
async function getDriveTimeMinutes(address) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY is not set — delivery distance cannot be calculated');
  }

  const destination = [address.street1, address.street2, address.city, address.state, address.zip]
    .filter(Boolean).join(', ');

  const params = new URLSearchParams({
    origins: businessOrigin(),
    destinations: destination,
    mode: 'driving',
    units: 'imperial',
    key: process.env.GOOGLE_MAPS_API_KEY
  });

  const response = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`);
  const data = await response.json();

  const element = data.rows && data.rows[0] && data.rows[0].elements && data.rows[0].elements[0];
  if (!element || element.status !== 'OK') {
    throw new Error(`Could not calculate drive time for that address (${element ? element.status : data.status || 'no response'})`);
  }

  return Math.ceil(element.duration.value / 60); // seconds -> whole minutes, rounded up
}

// Main entry point: given a customer address, returns whether delivery is
// offered there and, if so, the real fee to charge.
async function calculateDeliveryFee(address) {
  const oneWayMinutes = await getDriveTimeMinutes(address);
  const eligible = oneWayMinutes <= MAX_ONE_WAY_MINUTES;
  const fee = eligible
    ? Math.min(MAX_FEE, Math.round(oneWayMinutes * ONE_WAY_RATE_PER_MINUTE * 100) / 100)
    : 0;

  return { oneWayMinutes, eligible, fee };
}

module.exports = { calculateDeliveryFee, getDriveTimeMinutes, ONE_WAY_RATE_PER_MINUTE, MAX_ONE_WAY_MINUTES, MAX_FEE };
