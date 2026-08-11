const axios = require("axios");

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sharp = require("sharp");

const {
  invoicePaymentStatus,
  processedSyncroPayments,
} = require("./cache");

const PORT = process.env.PORT || 3000;
const SYNCRO_SUBDOMAIN = process.env.SYNCRO_SUBDOMAIN;
const SYNCRO_API_KEY = process.env.SYNCRO_API_KEY;

async function attachSignatureToSyncroTicket(
  syncroInvoiceId,
  signatureFileId
) {
  if (!syncroInvoiceId || !signatureFileId) {
    console.log(
      "ℹ️ Cannot attach signature: missing invoice ID or signature file ID"
    );
    return null;
  }

  try {
    // -------------------------------------------------------------
    // Find the ticket associated with the Syncro invoice
    // -------------------------------------------------------------

    const ticketResponse = await axios.get(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${syncroInvoiceId}/ticket?api_key=${SYNCRO_API_KEY}`
    );

    const ticket =
      ticketResponse.data?.ticket ||
      ticketResponse.data;

    const ticketId = ticket?.id;

    if (!ticketId) {
      console.warn(
        `⚠️ Syncro Invoice #${syncroInvoiceId} has no linked ticket.`
      );

      return null;
    }

    console.log(
      `📎 Invoice #${syncroInvoiceId} is linked to Ticket #${ticketId}`
    );

    // -------------------------------------------------------------
    // URL that Syncro will fetch
    // -------------------------------------------------------------

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.BASE_URL ||
      `http://localhost:${PORT}`;

    const signatureUrl =
      `${baseUrl}/api/signature/${encodeURIComponent(signatureFileId)}`;

    console.log(
      `📎 Attaching Stripe signature to Syncro Ticket #${ticketId}`
    );

    console.log(
      `📎 Signature URL: ${signatureUrl}`
    );

    // -------------------------------------------------------------
    // Attach URL to Syncro ticket
    // -------------------------------------------------------------

    const attachResponse = await axios.post(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/tickets/${ticketId}/attach_file_url?api_key=${SYNCRO_API_KEY}`,
      {
        url: signatureUrl,
        file_url: signatureUrl,
        filename: `invoice-${syncroInvoiceId}-signature.svg`,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    console.log(
      "✅ Signature successfully attached to Syncro ticket"
    );

    console.log(
      JSON.stringify(attachResponse.data, null, 2)
    );

    return {
      ticketId,
      signatureUrl,
      response: attachResponse.data,
    };

  } catch (err) {
    console.error(
      "❌ Failed to attach signature to Syncro ticket:",
      err.response?.data || err.message
    );

    return null;
  }
}



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

async function recordSyncroPayment(
  syncroInvoiceId,
  syncroCustomerId,
  amountString,
  stripePaymentIntentId,
  stripeInvoiceId,
  signatureFileId = null
) {
  const cleanInvoiceId = String(syncroInvoiceId || "").trim();

  if (!cleanInvoiceId) {
    console.error(
      "❌ recordSyncroPayment called with missing syncroInvoiceId"
    );
    return;
  }

  const syncroKey = `${cleanInvoiceId}_${amountString}`;

  if (processedSyncroPayments.has(syncroKey)) {
    console.log(
      `ℹ️ Syncro Invoice #${cleanInvoiceId} payment already processed. Skipping duplicate call.`
    );
    return;
  }

  processedSyncroPayments.add(syncroKey);

  try {
    const amountFloat = parseFloat(amountString) || 0;
    const totalCents = Math.round(amountFloat * 100);

    const parsedCustomerId = parseInt(syncroCustomerId, 10);
    const parsedInvoiceId = parseInt(cleanInvoiceId, 10);

    // ---------------------------------------------------------------
    // Get Stripe PaymentIntent
    // ---------------------------------------------------------------

    let stripePayment = null;

    try {
      stripePayment = await stripe.paymentIntents.retrieve(
        stripePaymentIntentId,
        {
          expand: [
            "payment_method",
            "charges.data",
          ],
        }
      );

      console.log("===== STRIPE PAYMENT RESPONSE =====");
      console.log(JSON.stringify(stripePayment, null, 2));
    } catch (stripeErr) {
      console.error("Stripe lookup failed:", stripeErr.message);
    }

    // ---------------------------------------------------------------
    // Stripe card-present information
    // ---------------------------------------------------------------

    const cardPresent =
      stripePayment?.payment_method?.card_present || {};

    // ---------------------------------------------------------------
    // Signature URL
    // ---------------------------------------------------------------

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.BASE_URL ||
      `http://localhost:${PORT}`;

    const signatureUrl = signatureFileId
      ? `${baseUrl}/api/signature/${signatureFileId}`
      : "";

    const sigTag = signatureFileId
      ? ` | Sig: ${signatureUrl}`
      : "";

    const sigNote = signatureFileId
      ? ` View signature: ${signatureUrl}`
      : "";

    const referenceString =
      `${stripeInvoiceId || stripePaymentIntentId || "Terminal_Payment"}${sigTag}`;

    // ---------------------------------------------------------------
    // Get Syncro customer information
    // ---------------------------------------------------------------

    let customerData = {};

    try {
      const customerResponse = await axios.get(
        `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/customers/${parsedCustomerId}?api_key=${SYNCRO_API_KEY}`
      );

      customerData = customerResponse.data?.customer || {};
    } catch (customerErr) {
      console.error(
        "⚠️ Failed to fetch Syncro customer:",
        customerErr.response?.data || customerErr.message
      );
    }

// ---------------------------------------------------------------
// Download Stripe Terminal signature as SVG
// ---------------------------------------------------------------


// ---------------------------------------------------------------
// Get Stripe signature and convert SVG → PNG data URL
// ---------------------------------------------------------------

let syncroSignatureData = "";

if (signatureFileId) {
  try {
    const stripeFile = await stripe.files.retrieve(signatureFileId);

    console.log("===== STRIPE SIGNATURE FILE =====");
    console.log({
      id: stripeFile.id,
      filename: stripeFile.filename,
      type: stripeFile.type,
      size: stripeFile.size,
    });

    const signatureResponse = await axios.get(stripeFile.url, {
      auth: {
        username: process.env.STRIPE_SECRET_KEY,
        password: "",
      },
      responseType: "arraybuffer",
    });

    // Convert Stripe SVG → PNG
    const pngBuffer = await sharp(
      Buffer.from(signatureResponse.data)
    )
      .png()
      .toBuffer();

    // This is the value that goes to Syncro
    syncroSignatureData =
      `data:image/png;base64,${pngBuffer.toString("base64")}`;

    console.log(
      "✅ syncroSignatureData created:",
      syncroSignatureData.substring(0, 50) + "..."
    );

  } catch (signatureErr) {
    console.error(
      "❌ Failed to create Syncro signature:",
      signatureErr.response?.data || signatureErr.message
    );
  }
}

    
    // ---------------------------------------------------------------
    // Build Notes
    // 
    // ---------------------------------------------------------------

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
      `Stripe Invoice: ${stripeInvoiceId || "N/A"}`,
    ]
      .join(" | ");

    // ---------------------------------------------------------------
    // Build Transaction Response
    // Syncro field is varchar(255), so keep it under 255 characters
    // ---------------------------------------------------------------

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

    // ---------------------------------------------------------------
    // Build Syncro Payment Payload
    // ---------------------------------------------------------------

    const payload = {
      payment: {
        customer_id: isNaN(parsedCustomerId)
          ? 0
          : parsedCustomerId,

        invoice_id: parsedInvoiceId,

        amount: amountFloat,

        amount_cents: totalCents,

        payment_method: "Stripe Terminal (Signed in Stripe)",

        signature_name:
  `${customerData.firstname || ""} ${customerData.lastname || ""}`.trim(),

signature_data: syncroSignatureData,
base64_png: syncroSignatureData,

signature_date: signatureFileId
  ? new Date().toISOString()
  : null,

        ref_num: referenceString,

        notes: notesstring,

        message: "Test",

        ip_address: "Test",

        action: "Test",

        address_state: customerData.state || "",

        transaction_response: transactionresponse,

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

    // ---------------------------------------------------------------
    // Send Payment to Syncro
    // ---------------------------------------------------------------

    const syncroResponse = await axios.post(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/payments?api_key=${SYNCRO_API_KEY}`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

console.log("===== SIGNATURE CHECK =====");
console.log({
  sentSignature: !!syncroSignatureData,
  sentLength: syncroSignatureData?.length,
  returnedSignatureData: !!syncroResponse.data?.payment?.signature_data,
  returnedBase64Png: !!syncroResponse.data?.payment?.base64_png,
});
    
    // ---------------------------------------------------------------
    // Syncro Response
    // ---------------------------------------------------------------

    console.log("===== SYNCRO PAYMENT RESPONSE =====");
    console.log(JSON.stringify(syncroResponse.data, null, 2));

    console.log("===== PAYMENT OBJECT KEYS =====");
    console.log(
      Object.keys(syncroResponse.data?.payment || {})
    );

    // ---------------------------------------------------------------
    // Verify Syncro Invoice
    // ---------------------------------------------------------------

    try {
      const verifyInvoice = await axios.get(
        `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${cleanInvoiceId}?api_key=${SYNCRO_API_KEY}`
      );

      console.log("===== SYNCRO INVOICE AFTER PAYMENT =====");
      console.log("===== FULL SYNCRO INVOICE =====");
      console.log(JSON.stringify(verifyInvoice.data, null, 2));
      console.log(
        JSON.stringify(
          {
            id: verifyInvoice.data.invoice?.id,
            status: verifyInvoice.data.invoice?.status,
            balance_due:
              verifyInvoice.data.invoice?.balance_due,
            paid: verifyInvoice.data.invoice?.paid,
            payment_status:
              verifyInvoice.data.invoice?.payment_status,
          },
          null,
          2
        )
      );
    } catch (verifyErr) {
      console.error(
        "❌ Syncro invoice verification failed:",
        verifyErr.response?.data || verifyErr.message
      );
    }

    // ---------------------------------------------------------------
    // Update payment status
    // ---------------------------------------------------------------

    invoicePaymentStatus.set(cleanInvoiceId, {
      status: "paid",
      stage: null,
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
