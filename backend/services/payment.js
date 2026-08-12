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
// ATTACH STRIPE SIGNATURE TO SYNCRO INVOICE
// ================================================================

async function attachSignatureToSyncroInvoice(
  syncroInvoiceId,
  signatureFileId,
  signatureName
) {
  if (!syncroInvoiceId || !signatureFileId) {
    console.log(
      "ℹ️ Cannot attach signature: missing invoice ID or signature file ID"
    );
    return null;
  }

  try {
    // ------------------------------------------------------------
    // Public URL to Stripe signature
    // ------------------------------------------------------------

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.BASE_URL ||
      `http://localhost:${PORT}`;

    const signatureUrl =
      `${baseUrl}/api/signature/${encodeURIComponent(signatureFileId)}`;

    console.log(
      `📎 Signature URL: ${signatureUrl}`
    );

    // ------------------------------------------------------------
    // Get signature PNG
    // ------------------------------------------------------------

    const signatureResponse =
      await axios.get(
        signatureUrl,
        {
          responseType: "arraybuffer",
        }
      );

    const signatureBase64 =
      Buffer.from(
        signatureResponse.data
      ).toString("base64");

    const signatureData =
      `data:image/png;base64,${signatureBase64}`;

    // ------------------------------------------------------------
    // Build Syncro signature form
    // ------------------------------------------------------------

    const formData =
      new URLSearchParams();

    formData.append(
      "invoice[signature_name]",
      signatureName || ""
    );

    formData.append(
      "invoice[signature_data]",
      signatureData
    );

    formData.append(
      "invoice[base64_png]",
      signatureData
    );

    // Attach signature to Syncro via API
    const response = await axios.post(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${syncroInvoiceId}/signature?api_key=${SYNCRO_API_KEY}`,
      formData,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log(`✅ Signature successfully attached to Syncro Invoice #${syncroInvoiceId}`);
    return response.data;

  } catch (err) {
    console.error(
      "❌ Failed to attach signature to Syncro Invoice:",
      err.response?.data || err.message
    );
    return null;
  }
}

// ================================================================
// CLEAR TERMINAL READER
// ================================================================

async function clearTerminalReaderDisplay(readerId) {
  if (!readerId) return;

  try {
    await stripe.terminal.readers.cancelAction(readerId);

    console.log(
      `🧹 Reader ${readerId} action cancelled/reset.`
    );

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
  stripeInvoiceId,
  signatureFileId = null
) {
  const cleanInvoiceId =
    String(syncroInvoiceId || "").trim();

  if (!cleanInvoiceId) {
    console.error(
      "❌ recordSyncroPayment called with missing syncroInvoiceId"
    );

    return;
  }

  const syncroKey =
    `${cleanInvoiceId}_${amountString}`;

  if (processedSyncroPayments.has(syncroKey)) {
    console.log(
      `ℹ️ Syncro Invoice #${cleanInvoiceId} payment already processed.`
    );

    return;
  }

  processedSyncroPayments.add(syncroKey);

  try {
    const amountFloat =
      parseFloat(amountString) || 0;

    const totalCents =
      Math.round(amountFloat * 100);

    const parsedCustomerId =
      parseInt(syncroCustomerId, 10);

    const parsedInvoiceId =
      parseInt(cleanInvoiceId, 10);

    // ============================================================
    // GET STRIPE PAYMENT
    // ============================================================

    let stripePayment = null;

    try {
      stripePayment =
        await stripe.paymentIntents.retrieve(
          stripePaymentIntentId,
          {
            expand: [
              "payment_method",
              "charges.data",
            ],
          }
        );

      console.log(
        "===== STRIPE PAYMENT RESPONSE ====="
      );

      console.log(
        JSON.stringify(
          stripePayment,
          null,
          2
        )
      );

    } catch (stripeErr) {
      console.error(
        "Stripe lookup failed:",
        stripeErr.message
      );
    }

    // ============================================================
    // CARD PRESENT
    // ============================================================

    const cardPresent =
      stripePayment?.payment_method?.card_present || {};

    // ============================================================
    // SIGNATURE URL
    // ============================================================

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.BASE_URL ||
      `http://localhost:${PORT}`;

    const signatureUrl = signatureFileId
      ? `${baseUrl}/api/signature/${encodeURIComponent(signatureFileId)}`
      : "";

    const sigTag = signatureFileId
      ? ` | Sig: ${signatureUrl}`
      : "";

    const referenceString =
      `${stripeInvoiceId || stripePaymentIntentId || "Terminal_Payment"}${sigTag}`;

    // ============================================================
    // GET SYNCRO CUSTOMER
    // ============================================================

    let customerData = {};

    try {
      const customerResponse =
        await axios.get(
          `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/customers/${parsedCustomerId}?api_key=${SYNCRO_API_KEY}`
        );

      customerData =
        customerResponse.data?.customer || {};

    } catch (customerErr) {
      console.error(
        "⚠️ Failed to fetch Syncro customer:",
        customerErr.response?.data ||
        customerErr.message
      );
    }

    // ============================================================
    // BUILD NOTES
    // ============================================================

    const notesstring = [
      `Stripe Terminal Payment`,
      `PaymentIntent: ${stripePaymentIntentId || "N/A"}`,
      `Charge: ${stripePayment?.latest_charge || "N/A"}`,
      `Card: ${cardPresent.description || cardPresent.brand || "N/A"}`,
      `Card Type: ${cardPresent.brand || "N/A"}`,
      `Cardholder: ${cardPresent.cardholder_name || "N/A"}`,
      `Last 4: ****${cardPresent.last4 || "N/A"}`,
      `Funding: ${cardPresent.funding || "N/A"}`,
      `Issuer: ${cardPresent.issuer || "N/A"}`,
      `Country: ${cardPresent.country || "N/A"}`,
      `Expiration: ${
        cardPresent.exp_month
          ? String(cardPresent.exp_month).padStart(2, "0")
          : "N/A"
      }/${cardPresent.exp_year || "N/A"}`,
      `Currency: ${stripePayment?.currency || "N/A"}`,
      `Amount: ${stripePayment?.amount ?? totalCents}`,
      `Amount Received: ${
        stripePayment?.amount_received ?? totalCents
      }`,
      `Signature File: ${signatureFileId || "N/A"}`,
      `Signature URL: ${signatureUrl || "N/A"}`,
    ].join(" | ");

    // ============================================================
    // TRANSACTION RESPONSE
    // ============================================================

    const transactionresponse = [
      `Card: ${cardPresent.description || cardPresent.brand || "N/A"}`,
      `Type: ${cardPresent.brand || "N/A"}`,
      `Last: ${cardPresent.last4 || "N/A"}`,
      `Iss: ${cardPresent.issuer || "N/A"}`,
      `Ctry: ${cardPresent.country || "N/A"}`,
      `Exp: ${
        cardPresent.exp_month
          ? String(cardPresent.exp_month).padStart(2, "0")
          : "N/A"
      }/${cardPresent.exp_year || "N/A"}`,
      `PI: ${stripePaymentIntentId || "N/A"}`,
      `Charge: ${stripePayment?.latest_charge || "N/A"}`,
    ]
      .join(" | ")
      .substring(0, 255);

    // ============================================================
    // SYNCRO PAYMENT PAYLOAD
    // ============================================================

    const payload = {
      payment: {
        customer_id:
          isNaN(parsedCustomerId)
            ? 0
            : parsedCustomerId,

        invoice_id: parsedInvoiceId,

        amount: amountFloat,

        amount_cents: totalCents,

        payment_method:
          "Stripe Terminal (Signed in Stripe)",

        signature_name:
          `${customerData.firstname || ""} ${customerData.lastname || ""}`.trim(),

        signature_date: signatureFileId
          ? new Date().toISOString()
          : null,

        ref_num: referenceString,

        notes: notesstring,

        message: "Test",

        ip_address: "Test",

        action: "Test",

        address_state:
          customerData.state || "",

        transaction_response:
          transactionresponse,

        address_street:
          customerData.address || "",

        address_city:
          customerData.city || "",

        address_zip:
          customerData.zip || "",

        first_name:
          customerData.firstname || "",

        last_name:
          customerData.lastname || "",

        invoice_payments_attributes: [
          {
            invoice_id: parsedInvoiceId,
            amount: amountFloat,
            payment_amount: amountFloat,
          },
        ],
      },
    };

    // ============================================================
    // CREATE SYNCRO PAYMENT
    // ============================================================

    console.log(
      "===== SYNCRO PAYMENT PAYLOAD ====="
    );

    console.log(
      JSON.stringify(payload, null, 2)
    );

    const syncroResponse =
      await axios.post(
        `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/payments?api_key=${SYNCRO_API_KEY}`,
        payload,
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

    console.log(
      "===== SYNCRO PAYMENT CREATED ====="
    );

    console.log(
      JSON.stringify(
        syncroResponse.data,
        null,
        2
      )
    );

    // ============================================================
    // ATTACH SIGNATURE
    // ============================================================

    if (signatureFileId) {
      console.log(
        `📎 Attempting to attach signature ${signatureFileId}`
      );

      await attachSignatureToSyncroInvoice(
        cleanInvoiceId,
        signatureFileId,
        `${customerData.firstname || ""} ${customerData.lastname || ""}`.trim()
      );
    }

    // ============================================================
    // VERIFY INVOICE
    // ============================================================

    try {
      const verifyInvoice =
        await axios.get(
          `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${cleanInvoiceId}?api_key=${SYNCRO_API_KEY}`
        );

      console.log(
        "===== SYNCRO INVOICE AFTER PAYMENT ====="
      );

      console.log(
        JSON.stringify(
          verifyInvoice.data,
          null,
          2
        )
      );

    } catch (verifyErr) {
      console.error(
        "❌ Syncro invoice verification failed:",
        verifyErr.response?.data ||
        verifyErr.message
      );
    }

    // ============================================================
    // UPDATE STATUS
    // ============================================================

    invoicePaymentStatus.set(
      cleanInvoiceId,
      {
        status: "paid",
        stage: null,
        amount: amountString,
        stripe_invoice_id:
          stripeInvoiceId || "",
      }
    );

    console.log(
      `✅ Syncro Invoice #${cleanInvoiceId} marked PAID ($${amountString}).`
    );

  } catch (err) {
    processedSyncroPayments.delete(
      syncroKey
    );

    console.error(
      "❌ Syncro Payment API error:",
      err.response?.data ||
      err.message
    );
  }
}

// ================================================================
// EXPORTS
// ================================================================

module.exports = {
  recordSyncroPayment,
  clearTerminalReaderDisplay,
  attachSignatureToSyncroInvoice,
};
