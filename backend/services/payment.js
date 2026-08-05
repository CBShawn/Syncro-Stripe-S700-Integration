const axios = require("axios");

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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
    await stripe.terminal.readers.cancelAction(readerId);

    console.log(`🧹 Reader ${readerId} action cancelled/reset.`);
  } catch (err) {
    console.error(
      "⚠️ Failed to reset reader:",
      err.response?.data || err.message
    );
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

const syncroResponse = await axios.post(
  `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/payments?api_key=${SYNCRO_API_KEY}`,
  payload,
  {
    headers: {
      "Content-Type": "application/json",
    },
  }
);

console.log("===== SYNCRO RESPONSE =====");
console.log(JSON.stringify(syncroResponse.data, null, 2));

    try {
  const verifyInvoice = await axios.get(
    `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${cleanInvoiceId}?api_key=${SYNCRO_API_KEY}`
  );

  console.log("===== SYNCRO INVOICE AFTER PAYMENT =====");
  console.log(JSON.stringify({
    id: verifyInvoice.data.invoice?.id,
    status: verifyInvoice.data.invoice?.status,
    balance_due: verifyInvoice.data.invoice?.balance_due,
    paid: verifyInvoice.data.invoice?.paid,
    payment_status: verifyInvoice.data.invoice?.payment_status
  }, null, 2));

} catch (verifyErr) {
  console.error(
    "❌ Syncro invoice verification failed:",
    verifyErr.response?.data || verifyErr.message
  );
}
    
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
