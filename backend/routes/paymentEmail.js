// routes/paymentEmail.js
const express = require("express");
const axios = require("axios");
const Stripe = require("stripe");

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const SYNCRO_SUBDOMAIN = process.env.SYNCRO_SUBDOMAIN;
const SYNCRO_API_KEY = process.env.SYNCRO_API_KEY;
const PORT = process.env.PORT || 3000;
const BASE_URL =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  `http://localhost:${PORT}`;

// ================================================================
// 1. CLIENT CLICK INTERCEPTOR (CAPTURES REAL CLIENT IP)
// ================================================================
router.get("/pay/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  try {
    const rawIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";
    const clientIp = rawIp.replace(/^.*:/, ""); // clean ipv6 localhost prefix if any

    console.log(`🌐 Customer clicked payment link for Session ${sessionId} from IP: ${clientIp}`);

    // Retrieve session to get the Stripe URL and update metadata with client IP
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    await stripe.checkout.sessions.update(sessionId, {
      metadata: {
        ...session.metadata,
        client_ip: clientIp,
      },
    });

    // Seamlessly redirect customer to Stripe hosted checkout
    return res.redirect(session.url);
  } catch (err) {
    console.error("⚠️ Failed to intercept customer IP on redirect:", err.message);
    // Fallback: redirect directly to Stripe session if update fails
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return res.redirect(session.url);
    } catch {
      return res.status(500).send("Unable to redirect to payment checkout.");
    }
  }
});

// ================================================================
// 2. SEND PAYMENT EMAIL
// ================================================================
router.post("/send-payment-email", async (req, res) => {
  try {
    const { invoiceId, amount, customerEmail } = req.body;
    const cleanInvoiceId = String(invoiceId || "").trim();
    const numAmount = parseFloat(amount);

    console.log(`➡️ [1/5] send-payment-email endpoint reached!`);
    console.log(`➡️ [2/5] Payload received - Invoice ID: ${cleanInvoiceId}, Amount: ${numAmount}`);

    if (!cleanInvoiceId || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: "Valid invoiceId and positive amount are required." });
    }

    // Fetch Syncro Invoice & Customer details
    console.log(`➡️ [3/5] Fetching Syncro Invoice #${cleanInvoiceId}...`);
    const invRes = await axios.get(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${cleanInvoiceId}?api_key=${SYNCRO_API_KEY}`
    );
    const invoice = invRes.data?.invoice;
    if (!invoice) {
      return res.status(404).json({ error: `Syncro Invoice #${cleanInvoiceId} not found.` });
    }

    const targetCustomerId = invoice.customer_id || invoice.customer?.id;
    const recipientEmail = customerEmail || invoice.customer?.email;

    if (!targetCustomerId) {
      return res.status(400).json({ error: "Customer ID could not be identified for this invoice." });
    }

    // Create Stripe Checkout Session
    console.log(`➡️ [4/5] Creating Stripe Checkout Session ($${numAmount.toFixed(2)})...`);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card", "us_bank_account"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Invoice #${invoice.number || cleanInvoiceId}`,
              description: `Payment for Invoice #${invoice.number || cleanInvoiceId}`,
            },
            unit_amount: Math.round(numAmount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: recipientEmail || undefined,
      metadata: {
        syncro_invoice_id: String(invoice.id),
        syncro_customer_id: String(targetCustomerId),
      },
      success_url: `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/invoices/${cleanInvoiceId}`,
      cancel_url: `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/invoices/${cleanInvoiceId}`,
    });

    console.log(`➡️ Stripe Session created: ${session.id}`);

    // Build the tracked payment URL
    const trackedPayUrl = `${BASE_URL}/api/pay/${session.id}`;

    // Dispatch via Syncro Invoice Mailer
    console.log(`➡️ [5/5] Dispatching via Syncro Invoice Mailer...`);
    const emailBody = `Please click the link below to securely pay your invoice online:\n\n${trackedPayUrl}\n\nThank you for your business!`;

    await axios.post(
      `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1/invoices/${cleanInvoiceId}/email?api_key=${SYNCRO_API_KEY}`,
      {
        email: recipientEmail,
        subject: `Payment Link for Invoice #${invoice.number || cleanInvoiceId}`,
        body: emailBody,
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    console.log(`✅ Email dispatched and logged directly into Invoice #${cleanInvoiceId} history!`);
    return res.json({ success: true, checkoutUrl: trackedPayUrl });
  } catch (err) {
    console.error("❌ Failed to process payment email:", err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data || err.message });
  }
});

module.exports = router;
