const config = require("./config");

const stripe = require("./services/stripe");

const syncro = require("./services/syncroService");

const {
  invoiceCustomerCache,
  invoicePaymentStatus,
  processedSyncroPayments,
  pendingSyncroPayments,
  activeReaderIntents
} = require("./cache");


const PORT = config.PORT;

const STRIPE_WEBHOOK_SECRET =
  config.STRIPE_WEBHOOK_SECRET;


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
// HELPER FUNCTIONS
// =========================================================================

async function setTerminalReaderDisplay(readerId, lineItems, totalCents, feeSaverCents = 0) {
  try {
    const items = (Array.isArray(lineItems) && lineItems.length > 0)
      ? lineItems.map((item) => ({
          description: item.description || "Service Item",
          amount: parseInt(item.amount, 10) || 0,
          quantity: 1,
        }))
      : [{
          description: "Syncro Invoice Service Charge",
          amount: totalCents - feeSaverCents,
          quantity: 1,
        }];

    if (feeSaverCents > 0) {
      items.push({
        description: "Processing Fee / Fee Saver",
        amount: feeSaverCents,
        quantity: 1,
      });
    }

    const payload = new URLSearchParams();
    payload.append("type", "cart");
    payload.append("cart[currency]", "usd");
    payload.append("cart[total]", String(totalCents));

    items.forEach((item, index) => {
      payload.append(`cart[line_items][${index}][description]`, item.description);
      payload.append(`cart[line_items][${index}][amount]`, String(item.amount));
      payload.append(`cart[line_items][${index}][quantity]`, String(item.quantity));
    });

    await axios.post(
      `https://api.stripe.com/v1/terminal/readers/${readerId}/set_reader_display`,
      payload.toString(),
      {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    console.log(`📱 Reader screen updated with ${items.length} line item(s) (Pre-Dip Ready).`);
  } catch (err) {
    console.error("⚠️ Failed to set reader display:", err.response?.data || err.message);
  }
}

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

   await syncro.createPayment(payload);

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

// =========================================================================
// ROUTES
// =========================================================================

app.get("/", (req, res) => {
  res.json({ status: "running", service: "Stripe Invoice & Terminal Middleware" });
});

app.get('/payment-status/:invoiceId', (req, res) => {
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
        password: ''
      },
      responseType: 'arraybuffer'
    });
    
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Disposition', 'inline; filename="signature.svg"');
    
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
      try { body = JSON.parse(body); } catch (e) {}
    }

    let syncroInvoiceId = body.invoice_id || body.invoiceId || body.invoice?.id || body.invoice?.invoice_id;
    let syncroCustomerId = body.customer_id || body.customerId || body.invoice?.customer_id || body.invoice?.customerId;
    let readerId = body.reader_id || body.readerId || body.terminal_id || process.env.DEFAULT_STRIPE_READER_ID;
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

    const hasExplicitAmount = (body.amountCents !== undefined && body.amountCents !== null) || rawAmount !== undefined;
    const needsLineItems = !lineItems || !Array.isArray(lineItems) || lineItems.length === 0;

    if (!hasExplicitAmount || !syncroCustomerId || !customerEmail || needsLineItems) {
      console.log(`ℹ️ Fetching Invoice #${syncroInvoiceId} directly from Syncro API to fill missing data...`);
      try {
       
        const invoiceData =
        await syncro.getInvoice(syncroInvoiceId);
        
        if (invoiceData) {
          if (!hasExplicitAmount) {
            rawAmount = invoiceData.balance_due !== undefined ? invoiceData.balance_due : invoiceData.total;
          }
          if (!syncroCustomerId) syncroCustomerId = invoiceData.customer_id || invoiceData.customer?.id;
          if (invoiceData.customer) {
            customerName = invoiceData.customer.fullname || invoiceData.customer.business_name || customerName;
            if (!customerEmail) customerEmail = invoiceData.customer.email;
          }
          if (needsLineItems && invoiceData.line_items) {
            lineItems = invoiceData.line_items.map(item => {
              const price = parseFloat(item.total || item.price || item.unit_price || 0);
              return {
                description: item.name || item.description || "Service Item",
                amount: Math.round(price * 100)
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

    console.log(`▶ Initiating Pre-Dip Cart Display for Invoice #${syncroInvoiceId} ($${(totalChargeCents / 100).toFixed(2)}) on Reader: ${readerId}`);

    const safeSyncroCustomerId = (syncroCustomerId && syncroCustomerId !== "undefined") 
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

    // Store PaymentIntent ID mapped to reader for pre-dip card trigger
    activeReaderIntents.set(String(readerId), paymentIntent.id);

    // 1. Set cart line items on S700 screen in Pre-Dip mode
    await setTerminalReaderDisplay(readerId, lineItems, totalChargeCents, feeSaverCents);

    // 2. Immediately launch process_payment_intent so the reader accepts card presentation while showing cart
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

    console.log(`✅ Cart display and pre-dip payment intent (${paymentIntent.id}) active on Reader ${readerId}`);

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
      // 1. CARD PRESENTED / READ DURING PRE-DIP
      if (event.type === "terminal.reader.action_succeeded") {
        const readerObj = event.data.object;
        const readerId = String(readerObj.id);
        const activeIntentId = activeReaderIntents.get(readerId);

        if (activeIntentId) {
          console.log(`💳 Card presented on Reader ${readerId}. Executing active PaymentIntent ${activeIntentId}...`);
          activeReaderIntents.delete(readerId);

          const processPayload = new URLSearchParams();
          processPayload.append("payment_intent", activeIntentId);

          try {
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
          } catch (procErr) {
            console.warn("ℹ️ Payment intent already processing or completed:", procErr.response?.data || procErr.message);
          }
        }
      }

      // 2. PAYMENT SUCCEEDED
      if (event.type === "payment_intent.succeeded") {
        const pi = event.data.object;
        const metadata = pi.metadata || {};
        const readerId = metadata.stripe_reader_id;
        const syncroInvoiceId = metadata.syncro_invoice_id ? String(metadata.syncro_invoice_id).trim() : null;
        const syncroCustomerId = metadata.syncro_customer_id ? String(metadata.syncro_customer_id).trim() : null;
        const amountString = (pi.amount / 100).toFixed(2);
        const feeSaverCents = parseInt(metadata.fee_saver_amount || "0", 10);

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

          const lineItemsSum = (Array.isArray(lineItems) && lineItems.length > 0)
            ? lineItems.reduce((sum, item) => sum + (parseInt(item.amount, 10) || 0), 0)
            : 0;

          if (lineItemsSum === targetAmount && lineItemsSum > 0) {
            itemsToAttach = [...lineItems];
          } else {
            itemsToAttach = [{
              description: `Syncro Invoice #${syncroInvoiceId} Service Charge`,
              amount: targetAmount,
            }];
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
            readerId,
          });

          // Timeout fallback
          setTimeout(async () => {
            const pending = pendingSyncroPayments.get(String(stripeInvoiceId));
            if (pending) {
              pendingSyncroPayments.delete(String(stripeInvoiceId));
              console.log(`⏱️ Signature wait timed out for Stripe Invoice ${stripeInvoiceId}. Recording payment without signature link.`);
              await recordSyncroPayment(
                pending.syncroInvoiceId,
                pending.syncroCustomerId,
                pending.amountString,
                pending.paymentIntentId,
                pending.stripeInvoiceId
              );
              await clearTerminalReaderDisplay(pending.readerId);
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

      // 3. SIGNATURE COLLECTED
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

            await recordSyncroPayment(
              pending.syncroInvoiceId,
              pending.syncroCustomerId,
              pending.amountString,
              pending.paymentIntentId,
              pending.stripeInvoiceId,
              fileId
            );

            await clearTerminalReaderDisplay(pending.readerId || readerObj.id);
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
