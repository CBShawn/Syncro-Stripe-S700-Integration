// services/payment.js
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
  stripeInvoiceId = null
) {
  const cleanInvoiceId = String(syncroInvoiceId || "").trim();

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
    // 2. GET STRIPE PAYMENT DETAILS (CARD / ACH / TERMINAL)
    // ============================================================
    let stripePayment = null;
    let isCheckoutSession = String(stripePaymentIntentId).startsWith("cs_");

    if (isCheckoutSession) {
      try {
        const session = await stripe.checkout.sessions.retrieve(
          stripePaymentIntentId,
          { expand: ["payment_intent.payment_method", "payment_intent.latest_charge"] }
        );
        stripePayment = session.payment_intent;
      } catch (sessErr) {
        console.warn("Stripe Checkout Session lookup warning:", sessErr.message);
      }
    } else if (stripePaymentIntentId) {
      try {
        stripePayment = await stripe.paymentIntents.retrieve(
          stripePaymentIntentId,
          { expand: ["payment_method", "charges.data", "latest_charge"] }
        );
      } catch (stripeErr) {
        console.warn("Stripe PaymentIntent lookup warning:", stripeErr.message);
      }
    }

    const cardPresent = stripePayment?.payment_method?.card_present || {};
    const cardDetails = stripePayment?.payment_method?.card || {};
    const usBankAccount = stripePayment?.payment_method?.us_bank_account || {};

    const cardInfo = cardPresent.brand 
      ? cardPresent 
      : (cardDetails.brand ? cardDetails : usBankAccount);

    const paymentType = cardPresent.brand 
      ? "Stripe Terminal" 
      : (usBankAccount.bank_name ? "Stripe ACH" : "Stripe Online");

    const referenceString = `${stripeInvoiceId || stripePaymentIntentId || "Stripe_Payment"}`;
    const nowIso = new Date().toISOString();
    const todayDate = nowIso.split("T")[0];

    // ============================================================
    // 3. BUILD NOTES
    // ============================================================
    const notesstring = [
      `${paymentType} Payment`,
      `PaymentIntent: ${stripePayment?.id || stripePaymentIntentId || "N/A"}`,
      `Charge: ${stripePayment?.latest_charge?.id || stripePayment?.latest_charge || "N/A"}`,
      `Method: ${cardInfo.bank_name || cardInfo.description || cardInfo.brand || "Card"}`,
      `Account/Card: ${cardInfo.bank_name ? cardInfo.bank_name : (cardInfo.brand || "N/A")}`,
      `Last 4: ****${cardInfo.last4 || "N/A"}`,
      `Funding: ${cardInfo.funding || (cardInfo.bank_name ? "Bank Account" : "N/A")}`,
      `Currency: ${stripePayment?.currency || "usd"}`,
      `Amount: $${amountFloat.toFixed(2)}`,
    ].join(" | ");

    // ============================================================
    // 4. TRANSACTION RESPONSE
    // ============================================================
    const transactionresponse = [
      `Method: ${cardInfo.bank_name || cardInfo.brand || "Card"}`,
      `Last: ${cardInfo.last4 || "N/A"}`,
      `PI: ${stripePayment?.id || stripePaymentIntentId || "N/A"}`,
      `Charge: ${stripePayment?.latest_charge?.id || stripePayment?.latest_charge || "N/A"}`,
    ]
      .join(" | ")
      .substring(0, 255);

    // ============================================================
    // 5. CLEAN SYNCRO PAYMENT PAYLOAD
    // ============================================================
    const payload = {
      payment: {
        customer_id: parsedCustomerId,
        invoice_id: parsedInvoiceId,
        amount: amountFloat,
        amount_cents: totalCents,
        payment_method: "Stripe Terminal",
        ref_num: referenceString,
        applied_at: todayDate,
        signature_date: nowIso,
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

    const createdPaymentId = syncroResponse.data?.payment?.id;

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
    // UPDATE STATUS CACHE WITH PAYMENT ID
    // ============================================================
    invoicePaymentStatus.set(cleanInvoiceId, {
      status: "paid",
      stage: null,
      amount: amountString,
      paymentId: createdPaymentId || null,
      stripe_invoice_id: stripeInvoiceId || "",
    });

    console.log(`✅ Syncro Invoice #${cleanInvoiceId} marked PAID ($${amountString}) with Payment ID ${createdPaymentId}.`);

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
