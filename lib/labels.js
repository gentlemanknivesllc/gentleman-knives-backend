// lib/labels.js
// Shared "actually buy a Shippo label and email it" logic. Used by three
// places that all needed this: the checkout webhook (inbound label), the
// finalize step (outbound/return label), and the subscription confirm page
// (inbound label for that cycle's shipment). Written once here so those
// three don't each carry their own slightly-different copy.

const ShippoModule = require('shippo');
const ShippoClient = ShippoModule.Shippo || ShippoModule.default || ShippoModule;
const { Resend } = require('resend');

const shippo = new ShippoClient({ apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}` });
const resend = new Resend(process.env.RESEND_API_KEY);

function businessAddress() {
  return {
    name: process.env.BUSINESS_NAME,
    street1: process.env.BUSINESS_STREET,
    city: process.env.BUSINESS_CITY,
    state: process.env.BUSINESS_STATE,
    zip: process.env.BUSINESS_ZIP,
    country: 'US',
    // USPS requires the SENDER's email and phone on every shipment.
    email: process.env.BUSINESS_EMAIL,
    phone: process.env.BUSINESS_PHONE
  };
}

function dimsForWeight(weightLb) {
  if (weightLb <= 1) return { length: '9', width: '6', height: '2', distanceUnit: 'in' };
  if (weightLb <= 4) return { length: '11', width: '8.5', height: '4', distanceUnit: 'in' };
  return { length: '13', width: '11', height: '6', distanceUnit: 'in' };
}

// Buys a real label. direction is 'inbound' (customer -> business) or
// 'outbound' (business -> customer) — just flips which address is from/to.
async function purchaseLabel({ direction, customerAddress, weightLb }) {
  const business = businessAddress();
  const addressFrom = direction === 'inbound' ? customerAddress : business;
  const addressTo = direction === 'inbound' ? business : customerAddress;

  const shipment = await shippo.shipments.create({
    addressFrom,
    addressTo,
    parcels: [{
      ...dimsForWeight(weightLb),
      weight: String(weightLb),
      massUnit: 'lb'
    }],
    async: false
  });

  const groundAdvantage = (shipment.rates || [])
    .filter(r => r.provider === 'USPS' && /ground advantage/i.test(r.servicelevel?.name || ''))
    .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];

  const chosenRate = groundAdvantage || (shipment.rates || []).slice().sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];
  if (!chosenRate) throw new Error('No shipping rate available for this label');

  const transaction = await shippo.transactions.create({
    rate: chosenRate.objectId,
    labelFileType: 'PDF',
    async: false
  });

  if (transaction.status !== 'SUCCESS') {
    throw new Error(`Label purchase failed: ${transaction.messages ? JSON.stringify(transaction.messages) : 'unknown error'}`);
  }

  return { labelUrl: transaction.labelUrl, trackingNumber: transaction.trackingNumber };
}

async function emailInboundLabel(customerEmail, label) {
  await resend.emails.send({
    from: 'orders@send.gentlemanknives.co',
    to: customerEmail,
    subject: 'Your Gentleman Knives shipping label',
    html: `
      <p>Thanks for your order! Print the label below and ship your knives to us.</p>
      <p><a href="${label.labelUrl}">Download your shipping label</a></p>
      <p>Tracking number: ${label.trackingNumber}</p>
      <p>We'll email you the final total once we receive and measure your items.</p>
    `
  });
}

async function emailReturnLabel(customerEmail, label, finalAmount) {
  await resend.emails.send({
    from: 'orders@send.gentlemanknives.co',
    to: customerEmail,
    subject: 'Your knives are sharpened and on the way back!',
    html: `
      <p>Your knives have been sharpened and your final charge of $${finalAmount.toFixed(2)} has been processed.</p>
      <p>They're shipping back to you now.</p>
      <p>Tracking number: ${label.trackingNumber}</p>
      <p>Thanks for choosing Gentleman Knives!</p>
    `
  });
}

// Confirmation for a local drop-off or delivery booking. No shipping
// label involved — this just confirms the card is on file and, for
// delivery, that the delivery fee went through.
async function emailLocalOrderConfirmation(customerEmail, { fulfillment, deliveryFee, oneWayMinutes }) {
  const bodyByMethod = fulfillment === 'delivery'
    ? `<p>Your delivery fee of $${Number(deliveryFee).toFixed(2)} (about ${oneWayMinutes} min each way) has been charged.</p>
       <p>If you haven't already, pick a pickup time on the delivery scheduling page — we'll come to you.</p>`
    : `<p>Your card is saved on file. Drop your knives off any time we're home — check the drop-off calendar on the local sharpening page for open windows.</p>`;

  await resend.emails.send({
    from: 'orders@send.gentlemanknives.co',
    to: customerEmail,
    subject: 'Your Gentleman Knives local booking is confirmed',
    html: `
      <p>Thanks for booking local sharpening with us!</p>
      ${bodyByMethod}
      <p>We'll email you the final sharpening total and charge your card on file once we've measured your items.</p>
    `
  });
}

module.exports = { purchaseLabel, emailInboundLabel, emailReturnLabel, emailLocalOrderConfirmation, businessAddress };
