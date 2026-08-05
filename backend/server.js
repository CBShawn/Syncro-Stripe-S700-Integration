require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const PORT = process.env.PORT || 3000;
const SYNCRO_SUBDOMAIN = process.env.SYNCRO_SUBDOMAIN;
const SYNCRO_API_KEY = process.env.SYNCRO_API_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// In-memory caches
const invoiceCustomerCache = new Map();
const invoicePaymentStatus = new Map();
const processedSyncroPayments = new Set();
const pendingSyncroPayments = new Map();

// =========================================================================
// 1. CORS & MIDDLEWARE
// =========================================================================

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-extension-auth",
      "x-extension-key",
      "x-requested-with",
    ],
    credentials: true,
  })
);

app.options("*", cors());

app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe/webhook") {
    next();
  } else {
    express.json({
      type: [
        "application/json",
        "text/plain",
        "application/x-www-form-urlencoded",
      ],
    })(req, res, next);
  }
});

// Request logger
app.use((req, res, next) => {
  console.log("===== INCOMING REQUEST =====");
  console.log(req.method, req.url);
  next();
});

// =========================================================================
// AUXILIARY ENRICHMENT: TICKET & INVOICE UPDATES
// =========================================================================

async function enrichSyncroInvoiceAndTicket(syncroInvoiceId, summaryText, sigUrl) {
  try {
    // 1. Fetch full Syncro Invoice details to locate associated Ticket ID
    const invRes = await axios.get(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${syncroInvoiceId}?api_key=${SYNCRO_API_KEY}`
    );
    const invoice = invRes.data?.invoice;
    if (!invoice) return;

    // 2. Append to Invoice Tech Notes
    const existingTechNotes = invoice.tech_notes || "";
    const updatedTechNotes = `${existingTechNotes}\n\n[TERMINAL PAYMENT LOGGED]:\n${summaryText}`.trim();

    await axios.put(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${syncroInvoiceId}?api_key=${SYNCRO_API_KEY}`,
      { invoice: { tech_notes: updatedTechNotes } }
    );
    console.log(`📝 Updated Tech Notes for Syncro Invoice #${syncroInvoiceId}`);

    // 3. Post to Ticket Communications feed (if linked to a Ticket)
    const ticketId = invoice.ticket_id;
    if (ticketId) {
      const commentBody = `💳 **Terminal Payment Received**\n\n${summaryText}${
        sigUrl ? `\n\n[View Digital Signature Image](${sigUrl})` : ""
      }`;

      await axios.post(
        `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/tickets/${ticketId}/comment?api_key=${SYNCRO_API_KEY}`,
        {
          subject: "Stripe Terminal Payment Recorded",
          body: commentBody,
          hidden: true, // Posts as a Private Tech Comment inside Syncro
          do_not_email: true,
        }
      );
      console.log(`💬 Posted private payment comment to Syncro Ticket #${ticketId}`);
    }
  } catch (err) {
    console.warn("⚠️ Failed auxiliary enrichment for Invoice/Ticket:", err.response?.data || err.message);
  }
}

// =========================================================================
// HELPER FUNCTIONS
// =========================================================================

async function recordSyncroPayment({
  syncroInvoiceId,
  syncroCustomerId,
  amountString,
  stripePaymentIntentId,
  stripeInvoiceId,
  signatureFileId = null,
  cardBrand = null,
  cardLast4 = null,
  feeSaverCents = 0,
}) {
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

    const baseUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.BASE_URL ||
      `http://localhost:${PORT}`;

    const sigUrl = signatureFileId
      ? `${baseUrl}/api/signature/${signatureFileId}`
      : null;

    const referenceString = `${
      stripeInvoiceId || stripePaymentIntentId || "Terminal_Payment"
    }${sigUrl ? ` | Sig: ${sigUrl}` : ""}`;

    const parsedCustomerId = parseInt(syncroCustomerId, 10);
    const parsedInvoiceId = parseInt(cleanInvoiceId, 10);

    // Build structured, detailed note payload
    const noteLines = [
      `💳 STRIPE TERMINAL PAYMENT RECORDED`,
      `----------------------------------------`,
      cardBrand || cardLast4
        ? `• Card Instrument: ${cardBrand ? cardBrand.toUpperCase() : "Card"} ending in ${cardLast4 || "XXXX"}`
        : null,
      `• Base Amount: $${amountFloat.toFixed(2)}`,
      feeSaverCents > 0
        ? `• Processing Surcharge: $${(feeSaverCents / 100).toFixed(2)}`
        : null,
      `• Stripe PaymentIntent: ${stripePaymentIntentId || "N/A"}`,
      `• Stripe Invoice: ${stripeInvoiceId || "N/A"}`,
      sigUrl ? `• Digital Signature: ${sigUrl}` : `• Digital Signature: Not Captured`,
      `• Timestamp: ${new Date().toLocaleString("en-US", { timeZoneName: "short" })}`,
    ]
      .filter(Boolean)
      .join("\n");

    // REVISED PAYLOAD SCHEMA WITH APPLY_PAYMENTS MAPPING
    const payload = {
      payment: {
        ...(parsedCustomerId > 0 && { customer_id: parsedCustomerId }),
        invoice_id: parsedInvoiceId,
        amount_cents: totalCents,
        payment_method: "Credit Card", 
        ref_num: referenceString,
        applied_at: new Date().toISOString(),
        ...(cardLast4 && { credit_card_number: cardLast4 }),
        ...(cardBrand && { card_type: cardBrand }),
        notes: noteLines,
        apply_payments: {
          [cleanInvoiceId]: amountFloat.toFixed(2),
        },
      },
    };

    await axios.post(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/payments?api_key=${SYNCRO_API_KEY}`,
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    console.log(
      `✅ Syncro Invoice #${cleanInvoiceId} marked PAID ($${amountString}). Link: Stripe ${stripeInvoiceId || "N/A"}`
    );

    // Update status cache cleanly & explicitly clear the stage flag
    invoicePaymentStatus.set(cleanInvoiceId, {
      status: "paid",
      stage: null,
      amount: amountString,
      stripe_invoice_id: stripeInvoiceId || "",
    });

    // Run auxiliary enrichment to update Ticket comments and Invoice Tech Notes
    enrichSyncroInvoiceAndTicket(cleanInvoiceId, noteLines, sigUrl);

  } catch (err) {
    processedSyncroPayments.delete(syncroKey);
    console.error(
      "❌ Syncro Payment API error:",
      err.response?.data || err.message
    );
  }
}

// =========================================================================
// ROUTES
// =========================================================================

app.get("/", (req, res) => {
  res.json({ status: "running", service: "Stripe Invoice & Terminal Middleware" });
});

app.get("/payment-status/:invoiceId", (req, res) => {
  const { invoiceId } = req.params;
  const targetId = String(invoiceId || "").trim();

  // 1. Check direct status map FIRST for completed payment
  const record = invoicePaymentStatus.get(targetId);
  if (record && record.status === "paid" && !record.stage) {
    return res.json({
      invoice_id: targetId,
      status: "paid",
      amount: record.amount,
      stripe_invoice_id: record.stripe_invoice_id || "",
    });
  }

  // 2. If explicitly in awaiting_signature stage
  if (record && record.status === "awaiting_signature") {
    return res.json({
      invoice_id: targetId,
      status: "paid",
      stage: "awaiting_signature",
    });
  }

  // 3. Pending signature map lookup fallback
  const isPendingSig = Array.from(pendingSyncroPayments.values()).some(
    (p) => String(p.syncroInvoiceId || "").trim() === targetId
  );

  if (isPendingSig) {
    return res.json({
      invoice_id: targetId,
      status: "paid",
      stage: "awaiting_signature",
    });
  }

  // 4. Processed key set fallback
  const isProcessed = Array.from(processedSyncroPayments).some((pKey) =>
    pKey.startsWith(`${targetId}_`)
  );

  if (isProcessed) {
    return res.json({ invoice_id: targetId, status: "paid" });
  }

  res.json({ invoice_id: targetId, status: "pending" });
});

app.get("/api/signature/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;

    const file = await stripe.files.retrieve(fileId);

    const response = await axios.get(file.url, {
      auth: {
        username: process.env.STRIPE_SECRET_KEY,
        password: "",
      },
      responseType: "arraybuffer",
    });

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Content-Disposition", 'inline; filename="signature.svg"');

    res.send(response.data);
  } catch (err) {
    console.error("Error retrieving signature:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/terminal/pay-and-sign", async (req, res) => {
  try {
    console.log("📥 RAW INCOMING BODY:", JSON.stringify(req.body, null, 2));

    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {}
    }

    let syncroInvoiceId =
      body.invoice_id || body.invoiceId || body.invoice?.id || body.invoice?.invoice_id;
    let syncroCustomerId =
      body.customer_id ||
      body.customerId ||
      body.invoice?.customer_id ||
      body.invoice?.customerId;
    let readerId =
      body.reader_id ||
      body.readerId ||
      body.terminal_id ||
      process.env.DEFAULT_STRIPE_READER_ID;
    let rawAmount = body.amount ?? body.total ?? body.balance_due ?? body.invoice?.total;

    let lineItems = body.lineItems || body.line_items || [];
    let feeSaverAmount = body.feeSaverAmount || body.fee_saver_amount || 0;

    let customerName = "Syncro Customer #" + (syncroCustomerId || "Guest");
    let customerEmail = body.customer_email || body.email || body.customerEmail || undefined;

    if (!syncroInvoiceId) {
      return res.status(400).json({ error: "Missing required field: invoice_id / invoiceId" });
    }

    syncroInvoiceId = String(syncroInvoiceId).trim();

    if (!syncroCustomerId && invoiceCustomerCache.has(syncroInvoiceId)) {
      syncroCustomerId = invoiceCustomerCache.get(syncroInvoiceId);
    }

    const hasExplicitAmount =
      (body.amountCents !== undefined && body.amountCents !== null) || rawAmount !== undefined;

    if (!hasExplicitAmount || !syncroCustomerId || !customerEmail) {
      console.log(`ℹ️ Fetching Invoice #${syncroInvoiceId} directly from Syncro API to fill missing data...`);
      try {
        const syncroRes = await axios.get(
          `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${syncroInvoiceId}?api_key=${SYNCRO_API_KEY}`
        );
        const invoiceData = syncroRes.data?.invoice;
        if (invoiceData) {
          if (!hasExplicitAmount) {
            rawAmount =
              invoiceData.balance_due !== undefined ? invoiceData.balance_due : invoiceData.total;
          }
          if (!syncroCustomerId) syncroCustomerId = invoiceData.customer_id || invoiceData.customer?.id;
          if (invoiceData.customer) {
            customerName =
              invoiceData.customer.fullname || invoiceData.customer.business_name || customerName;
            if (!customerEmail) customerEmail = invoiceData.customer.email;
          }
          if ((!lineItems || lineItems.length === 0) && invoiceData.line_items) {
            lineItems = invoiceData.line_items.map((item) => {
              const price = parseFloat(item.total || item.price || item.unit_price || 0);
              return {
                description: item.name || item.description || "Service Item",
                amount: Math.round(price * 100),
              };
            });
          }
        }
      } catch (syncroErr) {
        console.error("❌ Failed to fetch invoice details from Syncro API:", syncroErr.response?.data || syncroErr.message);
      }
    }

    if (syncroInvoiceId && syncroCustomerId && syncroCustomerId !== "undefined") {
      invoiceCustomerCache.set(syncroInvoiceId, String(syncroCustomerId).trim());
    }

    let amountCents = 0;
    if (body.amountCents !== undefined && body.amountCents !== null) {
      amountCents = parseInt(body.amountCents, 10);
    } else if (rawAmount !== undefined && rawAmount !== null) {
      if (typeof rawAmount === "string") rawAmount = rawAmount.replace(/[^0-9.]/g, "");
      const parsedFloat = parseFloat(rawAmount);
      if (!isNaN(parsedFloat) && parsedFloat > 0) {
        amountCents = Math.round(parsedFloat * 100);
      }
    }

    if (!readerId || !amountCents || amountCents <= 0) {
      return res.status(400).json({ error: "Invalid reader_id or non-zero amount." });
    }

    const feeSaverCents = parseInt(feeSaverAmount, 10) || 0;
    const totalChargeCents = amountCents + feeSaverCents;

    console.log(`▶ Initiating Terminal Payment for Invoice #${syncroInvoiceId} ($${(totalChargeCents / 100).toFixed(2)}) on Reader: ${readerId}`);

    const safeSyncroCustomerId =
      syncroCustomerId && syncroCustomerId !== "undefined"
        ? String(syncroCustomerId).trim()
        : "guest";

    const resolvedEmail = customerEmail || `noreply+syncro${safeSyncroCustomerId}@codeblackit.com`;

    let stripeCustomer = null;

    try {
      if (safeSyncroCustomerId !== "guest") {
        const existingCustomers = await stripe.customers.search({
          query: `metadata['syncro_customer_id']:'${safeSyncroCustomerId}'`,
        });

        if (existingCustomers.data && existingCustomers.data.length > 0) {
          stripeCustomer = existingCustomers.data[0];
        }
      }
    } catch (searchErr) {
      console.warn("⚠️ Customer search skipped or unindexed:", searchErr.message);
    }

    if (!stripeCustomer) {
      stripeCustomer = await stripe.customers.create({
        name: customerName || `Syncro Customer #${safeSyncroCustomerId}`,
        email: resolvedEmail,
        description: `Syncro Customer ID #${safeSyncroCustomerId}`,
        metadata: { syncro_customer_id: safeSyncroCustomerId },
      });
    } else if (resolvedEmail && stripeCustomer.email !== resolvedEmail) {
      stripeCustomer = await stripe.customers.update(stripeCustomer.id, {
        email: resolvedEmail,
      });
    }

    if (!stripeCustomer || !stripeCustomer.id) {
      throw new Error("Failed to resolve or create Stripe customer object.");
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalChargeCents,
      currency: "usd",
      customer: stripeCustomer.id,
      payment_method_types: ["card_present"],
      description: `Payment for Syncro Invoice #${syncroInvoiceId}`,
      metadata: {
        syncro_invoice_id: String(syncroInvoiceId),
        syncro_customer_id: safeSyncroCustomerId,
        stripe_reader_id: String(readerId),
        line_items_json: JSON.stringify(lineItems),
        fee_saver_amount: String(feeSaverCents),
      },
    });

    const processPayload = new URLSearchParams();
    processPayload.append("payment_intent", paymentIntent.id);

    await axios.post(
      `https://api.stripe.com/v1/terminal/readers/${readerId}/process_payment_intent`,
      processPayload.toString(),
      {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log(`✅ Sent PaymentIntent (${paymentIntent.id}) to Terminal Reader ${readerId}`);

    return res.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      syncroInvoiceId: syncroInvoiceId,
      status: "payment_initiated",
    });
  } catch (err) {
    console.error("❌ Error on /pay-and-sign:", err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// =========================================================================
// WEBHOOK HANDLER
// =========================================================================

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      if (STRIPE_WEBHOOK_SECRET) {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      } else {
        event = JSON.parse(req.body.toString());
      }
    } catch (err) {
      console.error(`❌ Webhook Signature Verification Failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`✅ Webhook Received: ${event.type}`);

    try {
      // 1. PAYMENT SUCCEEDED
      if (event.type === "payment_intent.succeeded") {
        const pi = event.data.object;
        const metadata = pi.metadata || {};
        const readerId = metadata.stripe_reader_id;
        const syncroInvoiceId = metadata.syncro_invoice_id
          ? String(metadata.syncro_invoice_id).trim()
          : null;
        const syncroCustomerId = metadata.syncro_customer_id
          ? String(metadata.syncro_customer_id).trim()
          : null;
        const amountString = (pi.amount / 100).toFixed(2);
        const feeSaverCents = parseInt(metadata.fee_saver_amount || "0", 10);

        // Extract Card Instrument Specs
        let cardBrand = null;
        let cardLast4 = null;

        try {
          const charge = pi.latest_charge
            ? typeof pi.latest_charge === "string"
              ? await stripe.charges.retrieve(pi.latest_charge)
              : pi.latest_charge
            : pi.charges?.data?.[0];

          const cardDetails =
            charge?.payment_method_details?.card_present ||
            charge?.payment_method_details?.card;

          if (cardDetails) {
            cardBrand = cardDetails.brand;
            cardLast4 = cardDetails.last4;
          }
        } catch (chargeErr) {
          console.warn("⚠️ Could not retrieve charge details for card info:", chargeErr.message);
        }

        if (syncroInvoiceId) {
          invoicePaymentStatus.set(syncroInvoiceId, {
            status: "awaiting_signature",
            amount: amountString,
          });
        }

        let lineItems = [];
        try {
          if (metadata.line_items_json) {
            lineItems = JSON.parse(metadata.line_items_json);
          }
        } catch (parseErr) {
          console.warn("⚠️ Failed to parse line_items_json from PaymentIntent metadata:", parseErr.message);
        }

        let stripeInvoiceId = null;

        try {
          const invoice = await stripe.invoices.create({
            customer: pi.customer,
            collection_method: "charge_automatically",
            auto_advance: false,
            description: `Syncro Invoice #${syncroInvoiceId}`,
            custom_fields: [{ name: "Syncro Invoice", value: `#${syncroInvoiceId}` }],
            footer: `Paid via Stripe Terminal Reader (${readerId}). Digital signature recorded upon completion.`,
            metadata: {
              syncro_invoice_id: String(syncroInvoiceId),
              terminal_payment_intent_id: pi.id,
            },
          });

          let itemsToAttach = [];
          const targetAmount = pi.amount - feeSaverCents;

          const lineItemsSum =
            Array.isArray(lineItems) && lineItems.length > 0
              ? lineItems.reduce((sum, item) => sum + (parseInt(item.amount, 10) || 0), 0)
              : 0;

          if (lineItemsSum === targetAmount && lineItemsSum > 0) {
            itemsToAttach = [...lineItems];
          } else {
            itemsToAttach = [
              {
                description: `Syncro Invoice #${syncroInvoiceId} Service Charge`,
                amount: targetAmount,
              },
            ];
          }

          if (feeSaverCents > 0) {
            itemsToAttach.push({
              description: "Processing Fee / Fee Saver",
              amount: feeSaverCents,
            });
          }

          for (const item of itemsToAttach) {
            await stripe.invoiceItems.create({
              customer: pi.customer,
              invoice: invoice.id,
              amount: parseInt(item.amount, 10),
              currency: "usd",
              description: item.description,
            });
          }

          const paidInvoice = await stripe.invoices.pay(invoice.id, {
            paid_out_of_band: true,
          });

          stripeInvoiceId = paidInvoice.id;
          console.log(`✅ Finalized & Paid Invoice ${stripeInvoiceId} out-of-band.`);
        } catch (invErr) {
          console.error("❌ Failed creating/paying Stripe invoice:", invErr.message);
        }

        if (syncroInvoiceId && syncroCustomerId && stripeInvoiceId) {
          pendingSyncroPayments.set(String(stripeInvoiceId), {
            syncroInvoiceId,
            syncroCustomerId,
            amountString,
            paymentIntentId: pi.id,
            stripeInvoiceId,
            cardBrand,
            cardLast4,
            feeSaverCents,
          });

          // Timeout fallback
          setTimeout(async () => {
            const pending = pendingSyncroPayments.get(String(stripeInvoiceId));
            if (pending) {
              pendingSyncroPayments.delete(String(stripeInvoiceId));
              console.log(`⏱️ Signature wait timed out for Stripe Invoice ${stripeInvoiceId}. Recording payment without signature link.`);
              
              await recordSyncroPayment({
                syncroInvoiceId: pending.syncroInvoiceId,
                syncroCustomerId: pending.syncroCustomerId,
                amountString: pending.amountString,
                stripePaymentIntentId: pending.paymentIntentId,
                stripeInvoiceId: pending.stripeInvoiceId,
                cardBrand: pending.cardBrand,
                cardLast4: pending.cardLast4,
                feeSaverCents: pending.feeSaverCents,
              });

              invoiceCustomerCache.delete(String(pending.syncroInvoiceId));
            }
          }, 25000);
        }

        if (readerId) {
          try {
            const signaturePayload = new URLSearchParams();
            signaturePayload.append("inputs[0][type]", "signature");
            signaturePayload.append("inputs[0][required]", "true");
            signaturePayload.append("inputs[0][custom_text][title]", "Equipment Return & Work Acceptance");
            signaturePayload.append("inputs[0][custom_text][description]", `I accept the completed work and charges. Syncro Invoice #${syncroInvoiceId || ""}.`);
            signaturePayload.append("inputs[0][custom_text][submit_button]", "Accept & Sign");
            signaturePayload.append("metadata[stripe_invoice_id]", stripeInvoiceId || "");

            await axios.post(
              `https://api.stripe.com/v1/terminal/readers/${readerId}/collect_inputs`,
              signaturePayload.toString(),
              {
                headers: {
                  Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
                  "Content-Type": "application/x-www-form-urlencoded",
                },
              }
            );
          } catch (sigErr) {
            console.error("❌ Failed to trigger signature collection:", sigErr.response?.data || sigErr.message);
          }
        }
      }

      // 2. SIGNATURE COLLECTED
      if (event.type === "terminal.reader.action_succeeded") {
        const readerObj = event.data.object;
        const action = readerObj.action || {};
        const metadata = action.collect_inputs?.metadata || readerObj.metadata || {};
        const stripeInvoiceId = metadata.stripe_invoice_id;

        let fileId = null;
        const collectInputs = action.collect_inputs?.inputs || action.process_input?.inputs || [];
        for (const input of collectInputs) {
          if (input.type === "signature") {
            fileId = input.signature?.value || input.value || input.signature;
            if (fileId) break;
          }
        }

        if (!fileId && readerObj.action?.collect_inputs) {
          fileId = readerObj.action.collect_inputs.value;
        }

        if (stripeInvoiceId) {
          if (fileId) {
            try {
              await stripe.invoices.update(stripeInvoiceId, {
                metadata: {
                  stripe_signature_file_id: String(fileId),
                  signed_at: new Date().toISOString(),
                },
              });
              console.log(`✅ Saved Signature File ID (${fileId}) to Invoice metadata for ${stripeInvoiceId}`);
            } catch (updateErr) {
              console.error("⚠️ Failed to update Stripe invoice metadata with signature ID:", updateErr.message);
            }
          }

          const pending = pendingSyncroPayments.get(String(stripeInvoiceId));
          if (pending) {
            pendingSyncroPayments.delete(String(stripeInvoiceId));

            await recordSyncroPayment({
              syncroInvoiceId: pending.syncroInvoiceId,
              syncroCustomerId: pending.syncroCustomerId,
              amountString: pending.amountString,
              stripePaymentIntentId: pending.paymentIntentId,
              stripeInvoiceId: pending.stripeInvoiceId,
              signatureFileId: fileId,
              cardBrand: pending.cardBrand,
              cardLast4: pending.cardLast4,
              feeSaverCents: pending.feeSaverCents,
            });

            invoiceCustomerCache.delete(String(pending.syncroInvoiceId));
          }
        }
      }
    } catch (handlerErr) {
      console.error("❌ Uncaught Exception inside Webhook Handler:", handlerErr);
    }

    res.json({ received: true });
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});