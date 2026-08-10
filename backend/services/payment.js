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
// Stripe card-present information
// ---------------------------------------------------------------

const cardPresent =
  stripePayment?.payment_method?.card_present || {};

const cardBrand = cardPresent.brand || "";
const cardDescription = cardPresent.description || "";
const cardLast4 = cardPresent.last4 || "";
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

const sigTag = signatureFileId
  ? ` | Sig: ${signatureUrl}`
  : "";

const referenceString =
  `${stripePaymentIntentId || "Terminal_Payment"}${sigTag}`;

// ---------------------------------------------------------------
// Parse customer/invoice IDs
// ---------------------------------------------------------------

const parsedCustomerId = parseInt(syncroCustomerId, 10);
const parsedInvoiceId = parseInt(cleanInvoiceId, 10);

// ---------------------------------------------------------------
// Fetch Syncro customer information
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
// Build transaction response for Syncro
// ---------------------------------------------------------------

const transactionResponse = {
  success: true,
  action: "payment",
  message: "Stripe Terminal payment succeeded",
  payment_intent_id: stripePaymentIntentId || null,
  charge_id: stripePayment?.latest_charge || null,
  card_type: cardBrand || null,
  card_description: cardDescription || null,
  card_last4: cardLast4 || null,
  card_funding: cardPresent.funding || null,
  card_issuer: cardPresent.issuer || null,
  card_country: cardPresent.country || null,
  cardholder_name: cardholderName || null,
  currency: stripePayment?.currency || "usd",
  amount: stripePayment?.amount || totalCents,
  amount_received: stripePayment?.amount_received || totalCents,
  signature_file_id: signatureFileId || null,
  signature_url: signatureUrl || null,
};

// ---------------------------------------------------------------
// Determine first/last name for Syncro
// ---------------------------------------------------------------

let firstName = customerData.firstname || "";
let lastName = customerData.lastname || "";

// If Stripe supplied a cardholder name and Syncro customer
// information is unavailable, use the cardholder name.
if (!firstName && !lastName && cardholderName) {
  const nameParts = cardholderName.trim().split(/\s+/);

  if (nameParts.length === 1) {
    firstName = nameParts[0];
  } else {
    firstName = nameParts[0];
    lastName = nameParts.slice(1).join(" ");
  }
}

// ---------------------------------------------------------------
// Syncro payment payload
//
// These fields correspond directly to Syncro's documented
// POST /payments fields.
// ---------------------------------------------------------------

const payload = {
  payment: {
    customer_id: isNaN(parsedCustomerId)
      ? 0
      : parsedCustomerId,

    invoice_id: parsedInvoiceId,

    amount: amountFloat,

    amount_cents: totalCents,

    // Customer address
    address_street: customerData.address || "",
    address_city: customerData.city || "",
    address_zip: customerData.zip || "",

    // Payment method shown in Syncro
    payment_method: cardBrand
      ? `Stripe Terminal - ${cardBrand.toUpperCase()}`
      : "Stripe Terminal (Signed in Stripe)",

    // Reference number including signature link
    ref_num: referenceString,

    // Signature information
    signature_name: cardholderName || "",
    signature_data: signatureUrl || "",
    signature_date: signatureFileId
      ? new Date().toISOString()
      : null,

    // Masked card number - never send the full PAN
    credit_card_number: cardLast4
      ? `****${cardLast4}`
      : "",

    // Card expiration
    date_month: cardExpMonth,
    date_year: cardExpYear,

    // Customer name
    lastname: lastName,
    firstname: firstName,

    // Stripe transaction information
    transaction_response: JSON.stringify(transactionResponse),

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
```

} catch (err) {
processedSyncroPayments.delete(syncroKey);

```
console.error(
  "❌ Syncro Payment API error:",
  err.response?.data || err.message
);
```

}
}

module.exports = {
recordSyncroPayment,
clearTerminalReaderDisplay,
};
