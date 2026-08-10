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

    // ---------------------------------------------------------------
    // Retrieve the Stripe PaymentIntent and expanded payment method
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
      console.error(
        "Stripe lookup failed:",
        stripeErr.message
      );
    }

    // ---------------------------------------------------------------
    // Extract Stripe card-present information
    // ---------------------------------------------------------------

    const cardPresent =
      stripePayment?.payment_method?.card_present || {};

    const cardBrand = cardPresent.brand || "";
    const cardDescription = cardPresent.description || "";
    const cardLast4 = cardPresent.last4 || "";
    const cardFunding = cardPresent.funding || "";
    const cardIssuer = cardPresent.issuer || "";
    const cardCountry = cardPresent.country || "";
    const cardholderName = cardPresent.cardholder_name || "";

    const cardExpMonth = cardPresent.exp_month
      ? String(cardPresent.exp_month).padStart(2, "0")
      : "";

    const cardExpYear = cardPresent.exp_year
      ? String(cardPresent.exp_year)
      : "";

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

    const sigTag = signatureUrl
      ? ` | Sig: ${signatureUrl}`
      : "";

    const sigNote = signatureUrl
      ? ` View signature: ${signatureUrl}`
      : "";

    // ---------------------------------------------------------------
    // Use PaymentIntent as the primary Stripe reference.
    // Stripe Invoice is optional because we no longer depend on
    // creating a Stripe Invoice for every terminal payment.
    // ---------------------------------------------------------------

    const referenceString =
      `${stripePaymentIntentId || stripeInvoiceId || "Terminal_Payment"}${sigTag}`;

    const parsedCustomerId = parseInt(syncroCustomerId, 10);
    const parsedInvoiceId = parseInt(cleanInvoiceId, 10);

    // ---------------------------------------------------------------
    // Fetch Syncro customer information so we can populate the
    // documented address/name fields on the payment.
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
    // Split Stripe cardholder name when available.
    // ---------------------------------------------------------------

    let firstName = "";
    let lastName = "";

    if (cardholderName) {
      const nameParts = cardholderName.trim().split(/\s+/);

      if (nameParts.length === 1) {
        firstName = nameParts[0];
      } else {
        firstName = nameParts.shift();
        lastName = nameParts.join(" ");
      }
    }

    // Fall back to the Syncro customer's name if Stripe did not
    // provide a cardholder name.
    if (!firstName) {
      firstName = customerData.firstname || "";
    }

    if (!lastName) {
      lastName = customerData.lastname || "";
    }

    // ---------------------------------------------------------------
    // Build a useful transaction response for Syncro.
    //
    // Deliberately excluded:
    // - full card number
    // - CVV
    // - Stripe fingerprint
    //
    // Last 4 is safe and useful for identifying the card.
    // ---------------------------------------------------------------

    const transactionResponse = {
      success: stripePayment?.status === "succeeded",
      action: "payment",
      message: "Stripe Terminal payment succeeded",
      payment_intent_id: stripePaymentIntentId || "",
      charge_id: stripePayment?.latest_charge || "",
      card_type: cardBrand || "",
      card_description: cardDescription || "",
      card_last4: cardLast4 || "",
      card_funding: cardFunding || "",
      card_issuer: cardIssuer || "",
      card_country: cardCountry || "",
      cardholder_name: cardholderName || "",
      currency: stripePayment?.currency || "usd",
      amount: stripePayment?.amount || totalCents,
      amount_received: stripePayment?.amount_received || totalCents,
      signature_file_id: signatureFileId || "",
      signature_url: signatureUrl || "",
    };

    // ---------------------------------------------------------------
    // Build Syncro payment payload
    // ---------------------------------------------------------------

    const payload = {
      payment: {
        customer_id: isNaN(parsedCustomerId)
          ? 0
          : parsedCustomerId,

        invoice_id: parsedInvoiceId,

        amount_cents: totalCents,

        address_street: customerData.address || "",

        address_city: customerData.city || "",

        address_zip: customerData.zip || "",

        payment_method: cardBrand
          ? `Stripe Terminal - ${cardBrand.toUpperCase()}`
          : "Stripe Terminal (Signed in Stripe)",

        ref_num: referenceString,

        signature_name: cardholderName || "",

        signature_data: signatureUrl || "",

        signature_date: signatureFileId
          ? new Date().toISOString()
          : null,

        // IMPORTANT:
        // Only send the last 4 digits here. Never send full card
        // number or CVV.
        credit_card_number: cardLast4
          ? `****${cardLast4}`
          : "",

        date_month: cardExpMonth,

        date_year: cardExpYear,

        cvv: "",

        lastname: lastName,

        firstname: firstName,

        transaction_response: JSON.stringify(
          transactionResponse
        ),

        notes:
          `Paid via Stripe Terminal (${stripePaymentIntentId || "N/A"}).` +
          `${cardDescription ? ` Card: ${cardDescription}.` : ""}` +
          `${cardLast4 ? ` Last 4: ****${cardLast4}.` : ""}` +
          `${cardFunding ? ` Funding: ${cardFunding}.` : ""}` +
          `${cardIssuer ? ` Issuer: ${cardIssuer}.` : ""}` +
          `${cardCountry ? ` Country: ${cardCountry}.` : ""}` +
          `${sigNote}` +
          ` Stripe Invoice: ${stripeInvoiceId || "N/A"}`,

        // Keep the existing Syncro invoice application logic.
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
    console.log(
      JSON.stringify(payload, null, 2)
    );

    // ---------------------------------------------------------------
    // Create Syncro payment
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

    console.log("===== SYNCRO PAYMENT RESPONSE =====");
    console.log(
      JSON.stringify(syncroResponse.data, null, 2)
    );

    console.log("===== PAYMENT OBJECT KEYS =====");
    console.log(
      Object.keys(syncroResponse.data?.payment || {})
    );

    // ---------------------------------------------------------------
    // Verify Syncro invoice after payment
    // ---------------------------------------------------------------

    try {
      const verifyInvoice = await axios.get(
        `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${cleanInvoiceId}?api_key=${SYNCRO_API_KEY}`
      );

      console.log("===== SYNCRO INVOICE AFTER PAYMENT =====");

      console.log(
        JSON.stringify(
          {
            id: verifyInvoice.data.invoice?.id,
            status: verifyInvoice.data.invoice?.status,
            balance_due:
              verifyInvoice.data.invoice?.balance_due,
            paid:
              verifyInvoice.data.invoice?.paid,
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
    // Update status cache cleanly and clear the signature stage lock
    // ---------------------------------------------------------------

    invoicePaymentStatus.set(cleanInvoiceId, {
      status: "paid",
      stage: null,
      amount: amountString,
      stripe_invoice_id: stripeInvoiceId || "",
    });

    console.log(
      `✅ Syncro Invoice #${cleanInvoiceId} marked PAID ($${amountString}). Link: Stripe ${stripePaymentIntentId || "N/A"}`
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
