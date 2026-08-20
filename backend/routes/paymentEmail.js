// routes/paymentEmail.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const axios = require("axios");
const syncro = require("../services/syncroService");

router.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  timeout: 10000,
});

router.post("/send-payment-email", async (req, res) => {
  console.log("➡️ [1/5] send-payment-email endpoint reached!");

  try {
    // 1. Authenticate Extension Request
    const extensionKey = req.headers["x-extension-key"];
    if (process.env.EXTENSION_AUTH_KEY && extensionKey !== process.env.EXTENSION_AUTH_KEY) {
      console.log("❌ Unauthorized extension key");
      return res.status(401).json({ success: false, error: "Unauthorized extension key." });
    }

    const { invoiceId, amount, customerId } = req.body || {};
    console.log(`➡️ [2/5] Payload received - Invoice ID: ${invoiceId}, Amount: ${amount}`);

    if (!invoiceId) {
      return res.status(400).json({ success: false, error: "Missing invoiceId." });
    }

    // 2. Fetch Syncro Invoice & Check Shop Supplies
    const syncroSubdomain = process.env.SYNCRO_SUBDOMAIN;
    const syncroApiKey = process.env.SYNCRO_API_KEY;

    console.log(`➡️ [3/5] Fetching Syncro Invoice #${invoiceId}...`);
    let invoice = await syncro.getInvoice(invoiceId);

    if (!invoice) {
      console.log("❌ Syncro Invoice not found");
      return res.status(404).json({ success: false, error: "Syncro invoice not found." });
    }

    // ⚡ Check for labor and auto-inject Shop Supplies from inventory if needed
    const wasAdded = await syncro.ensureShopSupplies(invoiceId, invoice.line_items || []);
    if (wasAdded) {
      invoice = await syncro.getInvoice(invoiceId);
    }

    if (invoice.paid || (invoice.balance_due !== undefined && invoice.balance_due <= 0)) {
      console.log("⚠️ Invoice already paid or 0 balance");
      return res.status(400).json({ success: false, error: "Invoice is already paid or has no balance due." });
    }

    // Resolve Customer Email & ID
    let customerEmail = invoice.customer_email || invoice.customer?.email;
    let targetCustomerId = customerId || invoice.customer_id || invoice.customer?.id;

    if (!customerEmail && targetCustomerId) {
      try {
        const custRes = await syncro.getCustomer(targetCustomerId);
        customerEmail = custRes?.email || custRes?.customer?.email;
      } catch (cErr) {
        console.warn("⚠️ Customer lookup fallback failed:", cErr.message);
      }
    }

    if (!customerEmail) {
      console.log("❌ No customer email found");
      return res.status(400).json({ success: false, error: "No email found for customer." });
    }

    const callerIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";

    const currentBalance = invoice.balance_due !== undefined ? invoice.balance_due : invoice.total;
    const amountInCents = Math.round((currentBalance || amount) * 100);

    // 3. Create Stripe Checkout Session with manual capture
    console.log(`➡️ [4/5] Creating Stripe Checkout Session ($${(amountInCents / 100).toFixed(2)})...`);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      payment_intent_data: {
        capture_method: "manual",
      },
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Invoice #${invoice.number || invoice.id}`,
              description: `Payment for ${invoice.customer_business_then_name || "CodeBlackIT Services"}`,
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: customerEmail,
      metadata: {
        syncro_invoice_id: String(invoice.id),
        syncro_customer_id: String(targetCustomerId || ""),
        client_ip: callerIp,
      },
      success_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=success`,
      cancel_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=cancelled`,
    });

    console.log(`➡️ Stripe Session created: ${session.id}`);

    // 4. Pass the raw Stripe URL directly
    const customInvoiceMessage = session.url;

    // 5. Send & Log via Syncro's Native Invoice Mailer API
    console.log(`➡️ [5/5] Dispatching via Syncro Invoice Mailer...`);
    await axios.post(
      `https://${syncroSubdomain}.syncromsp.com/api/v1/invoices/${invoice.id}/email?api_key=${syncroApiKey}`,
      {
        email: customerEmail,
        subject: `Invoice #${invoice.number || invoice.id} from CodeBlackIT`,
        custom_invoice_message: customInvoiceMessage,
        message: customInvoiceMessage,
        comment: customInvoiceMessage,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      }
    );

    console.log(`✅ Email dispatched and logged directly into Invoice #${invoice.id} history!`);

    return res.json({
      success: true,
      emailSent: true,
      paymentUrl: session.url,
      message: `Invoice #${invoice.number || invoice.id} emailed via Syncro and logged to invoice history.`,
    });

  } catch (err) {
    console.error("❌ ERROR in send-payment-email:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: err.response?.data?.message || err.message || "Internal server error",
    });
  }
});

module.exports = router;
