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
console.error("❌ recordSyncroPayment called with missing syncroInvoiceId");
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

let stripePayment = null;

try {
  stripePayment = await stripe.paymentIntents.retrieve(
    stripePaymentIntentId,
    {
      expand: [
        "payment_method",
        "charges.data"
      ]
    }
  );

  console.log("===== STRIPE PAYMENT RESPONSE =====");
  console.log(JSON.stringify(stripePayment, null, 2));

} catch (stripeErr) {
  console.error("Stripe lookup failed:", stripeErr.message);
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

const sigTag = signatureFileId
  ? ` | Sig: ${baseUrl}/api/signature/${signatureFileId}`
  : "";

const sigNote = signatureFileId
  ? ` View signature: ${baseUrl}/api/signature/${signatureFileId}`
  : "";

const referenceString =
  `${stripeInvoiceId || stripePaymentIntentId || "Terminal_Payment"}${sigTag}`;

const parsedCustomerId = parseInt(syncroCustomerId, 10);
const parsedInvoiceId = parseInt(cleanInvoiceId, 10);

// ---------------------------------------------------------------
// Fetch Syncro customer information BEFORE creating payment
// so address fields can be populated.
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
// Build useful Stripe transaction information for Syncro notes.
//
// We intentionally do NOT send:
// - full card number
// - CVV
// - Stripe fingerprint
//
// Only non-sensitive card details such as brand/last4/issuer are
// included.
// ---------------------------------------------------------------

const stripeCardInfo = [];

if (cardBrand || cardDescription) {
  const cardName = cardDescription
    ? cardDescription
    : cardBrand
      ? cardBrand.toUpperCase()
      : "";

  if (cardName) {
    stripeCardInfo.push(`Card: ${cardName}`);
  }
}

if (cardLast4) {
  stripeCardInfo.push(`Last 4: ****${cardLast4}`);
}

if (cardFunding) {
  stripeCardInfo.push(
    `Funding: ${cardFunding.charAt(0).toUpperCase()}${cardFunding.slice(1)}`
  );
}

if (cardIssuer) {
  stripeCardInfo.push(`Issuer: ${cardIssuer}`);
}

if (cardCountry) {
  stripeCardInfo.push(`Country: ${cardCountry}`);
}

if (stripePayment?.latest_charge) {
  stripeCardInfo.push(`Stripe Charge: ${stripePayment.latest_charge}`);
}

stripeCardInfo.push(
  `Stripe PaymentIntent: ${stripePaymentIntentId || "N/A"}`
);

const stripeCardNote =
  stripeCardInfo.length > 0
    ? ` ${stripeCardInfo.join(" | ")}`
    : "";

// ---------------------------------------------------------------
// Syncro payment payload
// ---------------------------------------------------------------

const payload = {
  payment: {
    customer_id: isNaN(parsedCustomerId)
      ? 0
      : parsedCustomerId,

    invoice_id: parsedInvoiceId,

    amount: amountFloat,

    amount_cents: totalCents,

    // Syncro documented payment fields
    address_street: customerData.address || "",
    address_city: customerData.city || "",
    address_zip: customerData.zip || "",

    payment_method: "Stripe Terminal (Signed in Stripe)",

    ref_num: referenceString,

    // Stripe card expiration
    date_month: cardExpMonth,
    date_year: cardExpYear,

    notes:
      `Paid via Stripe Terminal (${stripePaymentIntentId || "N/A"}).` +
      stripeCardNote +
      `${sigNote}` +
      ` Stripe Invoice: ${stripeInvoiceId || "N/A"}`,

    // Keep the existing Syncro invoice application logic unchanged
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

console.log("===== SYNCRO PAYMENT RESPONSE =====");
console.log(JSON.stringify(syncroResponse.data, null, 2));

console.log("===== PAYMENT OBJECT KEYS =====");
console.log(
  Object.keys(syncroResponse.data?.payment || {})
);

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
        balance_due: verifyInvoice.data.invoice?.balance_due,
        paid: verifyInvoice.data.invoice?.paid,
        payment_status: verifyInvoice.data.invoice?.payment_status
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

// Update status cache cleanly & explicitly clear the stage flag
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
