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

// Helper to strip quotes, URL encoding (%22), and whitespace from file IDs
function sanitizeFileId(fileId) {
  if (!fileId) return "";
  return String(fileId)
    .replace(/%22/gi, "")
    .replace(/['"]+/g, "")
    .trim();
}

// ================================================================
// CLEAR TERMINAL READER
// ================================================================

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

// ================================================================
// RECORD SYNCRO PAYMENT
// ================================================================

async function recordSyncroPayment(
  syncroInvoiceId,
  syncroCustomerId,
  amountString,
  stripePaymentIntentId,
  stripeInvoiceId = null,
  signatureFileId = null
) {
  const cleanInvoiceId = String(syncroInvoiceId || "").trim();
  const cleanSigFileId = sanitizeFileId(signatureFileId);

  if (!cleanInvoiceId) {
    console.error("❌ recordSyncroPayment called with missing syncroInvoiceId");
    return;
  }

  const syncroKey = `${cleanInvoiceId}_${amountString}`;

  if (processedSyncroPayments.has(syncroKey)) {
    console.log(`ℹ️ Syncro Invoice #${cleanInvoiceId} payment already processed.`);
    return;
  }

  try {
    const amountFloat = parseFloat(amountString) || 0;
    const totalCents = Math.round(amountFloat * 100);
    let parsedCustomerId = parseInt(syncroCustomerId, 10);
    const parsedInvoiceId = parseInt(cleanInvoiceId, 10);

    // ============================================================
    // 1. AUTO-FETCH SYNCRO INVOICE & CUSTOMER ID IF MISSING OR 0
    // ============================================================
    let customerData = {};

    if (!parsedCustomerId || isNaN(parsedCustomerId) || parsedCustomerId === 0) {
      console.log(`ℹ️ Customer ID missing for Invoice #${cleanInvoiceId}. Querying Syncro API...`);
      try {
        const invoiceRes = await axios.get(
          `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${parsedInvoiceId}?api_key=${SYNCRO_API_KEY}`
        );
        const inv = invoiceRes.data?.invoice || {};
        parsedCustomerId = inv.customer_id || inv.customer?.id || 0;
        customerData = inv.customer || {};
      } catch (invErr) {
        console.error("⚠️ Failed to fetch invoice details from Syncro:", invErr.message);
      }
    }

    if (parsedCustomerId > 0 && !customerData.firstname) {
      try {
        const customerResponse = await axios.get(
          `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/customers/${parsedCustomerId}?api_key=${SYNCRO_API_KEY}`
        );
        customerData = customerResponse.data?.customer || {};
      } catch (customerErr) {
        console.warn("⚠️ Syncro customer lookup warning:", customerErr.message);
      }
    }

    // ============================================================
    // 2. GET STRIPE PAYMENT DETAILS (CARD / CARD_PRESENT)
    // ============================================================
    let stripePayment = null;
    try {
      stripePayment = await stripe.paymentIntents.retrieve(
        stripePaymentIntentId,
        { expand: ["payment_method", "charges.data"] }
      );
    } catch (stripeErr) {
      console.warn("Stripe lookup warning:", stripeErr.message);
    }

    const cardPresent = stripePayment?.payment_method?.card_present || {};
    const cardDetails = stripePayment?.payment_method?.card || {};
    const cardInfo = cardPresent.brand ? cardPresent : cardDetails;

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.BASE_URL ||
      `http://localhost:${PORT}`;

    const signatureUrl = cleanSigFileId
      ? `${baseUrl}/api/signature/${encodeURIComponent(cleanSigFileId)}`
      : "";

    const sigTag = cleanSigFileId ? ` | Sig: ${signatureUrl}` : "";
    const referenceString = `${stripeInvoiceId || stripePaymentIntentId || "Stripe_Payment"}${sigTag}`;

    // ============================================================
    // 3. BUILD NOTES
    // ============================================================
    const notesstring = [
      cleanSigFileId ? `Stripe Terminal Payment` : `Stripe Online Payment`,
      `PaymentIntent: ${stripePaymentIntentId || "N/A"}`,
      `Charge: ${stripePayment?.latest_charge || "N/A"}`,
      `Card: ${cardInfo.description || cardInfo.brand || "N/A"}`,
      `Card Type: ${cardInfo.brand || "N/A"}`,
      `Cardholder: ${cardInfo.cardholder_name || "N/A"}`,
      `Last 4: ****${cardInfo.last4 || "N/A"}`,
      `Funding: ${cardInfo.funding || "N/A"}`,
      `Issuer: ${cardInfo.issuer || "N/A"}`,
      `Country: ${cardInfo.country || "N/A"}`,
      `Expiration: ${
        cardInfo.exp_month
          ? String(cardInfo.exp_month).padStart(2, "0")
          : "N/A"
      }/${cardInfo.exp_year || "N/A"}`,
      `Currency: ${stripePayment?.currency || "usd"}`,
      `Amount: ${stripePayment?.amount ?? totalCents}`,
      `Amount Received: ${stripePayment?.amount_received ?? totalCents}`,
      `Signature File: ${cleanSigFileId || "N/A"}`,
      `Signature URL: ${signatureUrl || "N/A"}`,
    ].join(" | ");

    // ============================================================
    // 4. TRANSACTION RESPONSE
    // ============================================================
    const transactionresponse = [
      `Card: ${cardInfo.description || cardInfo.brand || "N/A"}`,
      `Type: ${cardInfo.brand || "N/A"}`,
      `Last: ${cardInfo.last4 || "N/A"}`,
      `Iss: ${cardInfo.issuer || "N/A"}`,
      `Ctry: ${cardInfo.country || "N/A"}`,
      `Exp: ${
        cardInfo.exp_month
          ? String(cardInfo.exp_month).padStart(2, "0")
          : "N/A"
      }/${cardInfo.exp_year || "N/A"}`,
      `PI: ${stripePaymentIntentId || "N/A"}`,
      `Charge: ${stripePayment?.latest_charge || "N/A"}`,
    ]
      .join(" | ")
      .substring(0, 255);

    // ============================================================
    // 5. CLEAN SYNCRO PAYMENT PAYLOAD (NO INVALID DUMMY STRINGS)
    // ============================================================
    const payload = {
      payment: {
        customer_id: parsedCustomerId,
        invoice_id: parsedInvoiceId,
        amount: amountFloat,
        amount_cents: totalCents,
        payment_method: cleanSigFileId
          ? "Stripe Terminal (Signed in Stripe)"
          : "Stripe Online",
        ref_num: referenceString,
        notes: notesstring,
        transaction_response: transactionresponse,
        address_state: customerData.state || "",
        address_street: customerData.address || "",
        address_city: customerData.city || "",
        address_zip: customerData.zip || "",
        first_name: customerData.firstname || "",
        last_name: customerData.lastname || "",
        invoice_payments_attributes: [
          {
            invoice_id: parsedInvoiceId,
            amount: amountFloat,
            payment_amount: amountFloat,
          },
        ],
      },
    };

    console.log("===== SYNCRO PAYMENT PAYLOAD =====");
    console.log(JSON.stringify(payload, null, 2));

    const syncroResponse = await axios.post(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/payments?api_key=${SYNCRO_API_KEY}`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    console.log("===== SYNCRO PAYMENT CREATED =====");
    console.log(JSON.stringify(syncroResponse.data, null, 2));

    processedSyncroPayments.add(syncroKey);

    // ============================================================
    // VERIFY INVOICE
    // ============================================================
    try {
      const verifyInvoice = await axios.get(
        `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${cleanInvoiceId}?api_key=${SYNCRO_API_KEY}`
      );

      console.log("===== SYNCRO INVOICE AFTER PAYMENT =====");
      console.log(JSON.stringify(verifyInvoice.data, null, 2));
    } catch (verifyErr) {
      console.error(
        "❌ Syncro invoice verification failed:",
        verifyErr.response?.data || verifyErr.message
      );
    }

    // ============================================================
    // UPDATE STATUS CACHE
    // ============================================================
    invoicePaymentStatus.set(cleanInvoiceId, {
      status: "paid",
      stage: null,
      amount: amountString,
      stripe_invoice_id: stripeInvoiceId || "",
    });

    console.log(`✅ Syncro Invoice #${cleanInvoiceId} marked PAID ($${amountString}).`);

  } catch (err) {
    processedSyncroPayments.delete(syncroKey);

    console.error(
      "❌ Syncro Payment API error:",
      err.response?.data || err.message
    );
  }
}

// ================================================================
// EXPORTS
// ================================================================

module.exports = {
  recordSyncroPayment,
  clearTerminalReaderDisplay,
};
