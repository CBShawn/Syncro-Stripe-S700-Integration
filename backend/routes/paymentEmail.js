// routes/paymentEmail.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const axios = require("axios");

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

    // 2. Fetch Syncro Invoice
    const syncroSubdomain = process.env.SYNCRO_SUBDOMAIN;
    const syncroApiKey = process.env.SYNCRO_API_KEY;

    console.log(`➡️ [3/5] Fetching Syncro Invoice #${invoiceId}...`);
    const syncroRes = await axios.get(
      `https://${syncroSubdomain}.syncromsp.com/api/v1/invoices/${invoiceId}?api_key=${syncroApiKey}`,
      { timeout: 8000 }
    );

    const invoice = syncroRes.data?.invoice;
    if (!invoice) {
      console.log("❌ Syncro Invoice not found");
      return res.status(404).json({ success: false, error: "Syncro invoice not found." });
    }

    if (invoice.paid || invoice.balance_due <= 0) {
      console.log("⚠️ Invoice already paid or 0 balance");
      return res.status(400).json({ success: false, error: "Invoice is already paid or has no balance due." });
    }

    // Resolve Customer Email & ID
    let customerEmail = invoice.customer_email || invoice.customer?.email;
    let targetCustomerId = customerId || invoice.customer_id || invoice.customer?.id;

    if (!customerEmail && targetCustomerId) {
      try {
        const custRes = await axios.get(
          `https://${syncroSubdomain}.syncromsp.com/api/v1/customers/${targetCustomerId}?api_key=${syncroApiKey}`,
          { timeout: 8000 }
        );
        customerEmail = custRes.data?.customer?.email;
      } catch (cErr) {
        console.warn("⚠️ Customer lookup fallback failed:", cErr.message);
      }
    }

    if (!customerEmail) {
      console.log("❌ No customer email found");
      return res.status(400).json({ success: false, error: "No email found for customer." });
    }

    const amountInCents = Math.round((invoice.balance_due || amount) * 100);

    // 3. Create Stripe Checkout Session (Cards + ACH Direct Debit)
    console.log(`➡️ [4/5] Creating Stripe Checkout Session ($${(amountInCents / 100).toFixed(2)})...`);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card", "us_bank_account"],
      payment_method_options: {
        us_bank_account: {
          financial_connections: { permissions: ["payment_method"] },
        },
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
      },
      success_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=success`,
      cancel_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=cancelled`,
    });

    console.log(`➡️ Stripe Session created: ${session.id}`);

    // 4. Update Invoice Notes with Direct Stripe URL
    console.log(`➡️ Updating Invoice #${invoice.id} notes with Stripe ACH URL...`);
    await axios.put(
      `https://${syncroSubdomain}.syncromsp.com/api/v1/invoices/${invoice.id}?api_key=${syncroApiKey}`,
      {
        notes: session.url,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 8000,
      }
    );

    // 5. Send & Log via Syncro Native Mailer with Injected HTML Body
    console.log(`➡️ [5/5] Dispatching email via Syncro mailer for logging & PDF attachment...`);
    const customerFirstName = invoice.customer?.firstname || invoice.customer_business_then_name || "there";
    const emailBody = `
<p>Hi ${customerFirstName},</p>
<p>Your invoice #${invoice.number || invoice.id} for <strong>$${(amountInCents / 100).toFixed(2)}</strong> is ready for review.</p>
<p>A PDF copy is attached to this email for your records.</p>
<div style="margin: 20px 0;">
  <a href="${session.url}" style="background-color: #00796b; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; display: inline-block;">Pay Online (Card or Direct ACH)</a>
</div>
<p style="font-size: 13px; color: #555;">Or use this link directly: <a href="${session.url}">${session.url}</a></p>
<p>Thank you for your business!<br><strong>CodeBlackIT</strong></p>
    `.trim();

    await axios.post(
      `https://${syncroSubdomain}.syncromsp.com/api/v1/invoices/${invoice.id}/email?api_key=${syncroApiKey}`,
      {
        email: customerEmail,
        subject: `Invoice #${invoice.number || invoice.id} from CodeBlackIT`,
        body: emailBody,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      }
    );

    console.log("✅ Email dispatched and logged into Syncro customer history!");

    return res.json({
      success: true,
      emailSent: true,
      paymentUrl: session.url,
      message: `Invoice updated with Stripe link, dispatched, and logged in Syncro for ${customerEmail}.`,
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
