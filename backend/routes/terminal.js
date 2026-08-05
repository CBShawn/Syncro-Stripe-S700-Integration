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

