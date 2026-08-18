// services/payment.js
const axios = require("axios");

/**
 * Records a payment against an invoice in Syncro MSP.
 * 
 * @param {string|number} invoiceId - Syncro Invoice ID
 * @param {string|number} customerId - Syncro Customer ID
 * @param {string|number} amount - Amount in dollars (e.g. "150.00")
 * @param {string} paymentIntentId - Stripe PaymentIntent or Checkout Session ID
 * @param {string|null} signatureUrl - Optional signature URL
 * @param {string|null} fileId - Optional Stripe signature file ID
 */
async function recordSyncroPayment(
  invoiceId,
  customerId,
  amount,
  paymentIntentId,
  signatureUrl = null,
  fileId = null
) {
  const syncroSubdomain = process.env.SYNCRO_SUBDOMAIN;
  const syncroApiKey = process.env.SYNCRO_API_KEY;

  if (!syncroSubdomain || !syncroApiKey) {
    throw new Error("Missing SYNCRO_SUBDOMAIN or SYNCRO_API_KEY environment variables.");
  }

  const paymentPayload = {
    customer_id: Number(customerId),
    invoice_id: Number(invoiceId),
    amount: Number(amount),
    applied_at: new Date().toISOString(),
    notes: `Stripe Payment (ID: ${paymentIntentId})`,
  };

  const response = await axios.post(
    `https://${syncroSubdomain}.syncromsp.com/api/v1/payments?api_key=${syncroApiKey}`,
    paymentPayload,
    {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    }
  );

  return response.data;
}

/**
 * Clears the display on a Stripe Terminal reader.
 */
async function clearTerminalReaderDisplay(readerId) {
  if (!readerId) return;

  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    await stripe.terminal.readers.cancelAction(readerId);
    console.log(`🧹 Reader display reset for ${readerId}`);
  } catch (err) {
    console.log(`ℹ️ Reader display reset notice for ${readerId}: ${err.message}`);
  }
}

module.exports = {
  recordSyncroPayment,
  clearTerminalReaderDisplay,
};
