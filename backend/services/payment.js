const axios = require("axios");

const {
  invoicePaymentStatus,
  processedSyncroPayments,
} = require("./cache");

const PORT = process.env.PORT || 3000;
const SYNCRO_SUBDOMAIN = process.env.SYNCRO_SUBDOMAIN;
const SYNCRO_API_KEY = process.env.SYNCRO_API_KEY;

async function clearTerminalReaderDisplay(readerId) {
  if (!readerId) return;
  try {
    await axios.post(
      `https://api.stripe.com/v1/terminal/readers/${readerId}/clear_reader_display`,
      "",
      {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    console.log(`🧹 Reader ${readerId} display cleared.`);
  } catch (err) {
    console.error("⚠️ Failed to clear reader display:", err.response?.data || err.message);
  }
}

async function recordSyncroPayment(syncroInvoiceId, syncroCustomerId, amountString, stripePaymentIntentId, stripeInvoiceId, signatureFileId = null) {
  const cleanInvoiceId = String(syncroInvoiceId || "").trim();
  if (!cleanInvoiceId) {
    console.error("❌ recordSyncroPayment called with missing syncroInvoiceId");
    return;
  }

  const syncroKey = `${cleanInvoiceId}_${amountString}`;
  
  if (processedSyncroPayments.has(syncroKey)) {
    console.log(`ℹ️ Syncro Invoice #${cleanInvoiceId} payment already processed. Skipping duplicate call.`);
    return;
  }

  processedSyncroPayments.add(syncroKey);

  try {
    const amountFloat = parseFloat(amountString) || 0;
    const totalCents = Math.round(amountFloat * 100);

    const baseUrl = process.env.RENDER_EXTERNAL_URL 
      || process.env.BASE_URL 
      || `http://localhost:${PORT}`;

    const sigTag = signatureFileId 
      ? ` | Sig: ${baseUrl}/api/signature/${signatureFileId}` 
      : "";

    const sigNote = signatureFileId 
      ? ` View signature: ${baseUrl}/api/signature/${signatureFileId}` 
      : "";

    const referenceString = `${stripeInvoiceId || stripePaymentIntentId || "Terminal_Payment"}${sigTag}`;

    const parsedCustomerId = parseInt(syncroCustomerId, 10);
    const parsedInvoiceId = parseInt(cleanInvoiceId, 10);

    const payload = {
      payment: {
        customer_id: isNaN(parsedCustomerId) ? 0 : parsedCustomerId,
        invoice_id: parsedInvoiceId,
        amount: amountFloat,
        amount_cents: totalCents,
        payment_method: "Stripe Terminal (Signed in Stripe)",
        ref_num: referenceString,
        notes: `Paid via Stripe Terminal (${stripePaymentIntentId || "N/A"}).${sigNote} Stripe Invoice: ${stripeInvoiceId || "N/A"}`,
        invoice_payments_attributes: [
          {
            invoice_id: parsedInvoiceId,
            amount: amountFloat,
            payment_amount: amountFloat,
          },
        ],
      },
    };

   await axios.post(
  `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/payments?api_key=${SYNCRO_API_KEY}`,
  payload,
  {
    headers: {
      "Content-Type": "application/json",
    },
  }
);
    
    // Update status cache cleanly & explicitly clear the stage flag
    invoicePaymentStatus.set(cleanInvoiceId, {
      status: "paid",
      stage: null, // Clear awaiting_signature stage lock
      amount: amountString,
      stripe_invoice_id: stripeInvoiceId || "",
    });

    console.log(
      `✅ Syncro Invoice #${cleanInvoiceId} marked PAID ($${amountString}). Link: Stripe ${stripeInvoiceId || "N/A"}`
    );
  } catch (err) {
    processedSyncroPayments.delete(syncroKey);
    console.error(
      "❌ Syncro Payment API error:",
      err.response?.data || err.message
    );
  }
}


module.exports = {
  recordSyncroPayment,
  clearTerminalReaderDisplay,
};
