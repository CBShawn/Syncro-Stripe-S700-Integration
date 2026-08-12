// routes/paymentEmail.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const axios = require("axios");
const nodemailer = require("nodemailer");

router.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  timeout: 10000, // 10s Stripe API timeout
});

// Configure Office 365 Nodemailer Transporter using OAuth2 with explicit Tenant ID
const transporter = nodemailer.createTransport({
  host: "smtp.office365.com",
  port: 587,
  secure: false, // STARTTLS
  auth: {
    type: "OAuth2",
    user: process.env.O365_USER_EMAIL,
    clientId: process.env.O365_CLIENT_ID,
    clientSecret: process.env.O365_CLIENT_SECRET,
    refreshToken: process.env.O365_REFRESH_TOKEN,
    tenantId: process.env.O365_TENANT_ID || "5f5900bb-52f2-4650-91d3-b2981fc95d6f", // Critical: Forces local tenant authority
  },
  family: 4, // Force IPv4 to prevent Render ENETUNREACH issues
  tls: {
    rejectUnauthorized: false, // Avoid strict handshake hangs
  },
  connectionTimeout: 8000, // 8s connection timeout
  greetingTimeout: 8000,   // 8s greeting timeout
  socketTimeout: 12000,    // 12s socket timeout
});

router.post("/send-payment-email", async (req, res) => {
  console.log("➡️ [1/6] send-payment-email endpoint reached!");

  try {
    // 1. Auth check
    const extensionKey = req.headers["x-extension-key"];
    if (process.env.EXTENSION_AUTH_KEY && extensionKey !== process.env.EXTENSION_AUTH_KEY) {
      console.log("❌ Unauthorized extension key");
      return res.status(401).json({ success: false, error: "Unauthorized extension key." });
    }

    const { invoiceId, amount, customerId } = req.body || {};
    console.log(`➡️ [2/6] Payload received - Invoice ID: ${invoiceId}, Amount: ${amount}`);

    if (!invoiceId) {
      return res.status(400).json({ success: false, error: "Missing invoiceId." });
    }

    // 2. Syncro API Call (8s timeout)
    const syncroSubdomain = process.env.SYNCRO_SUBDOMAIN;
    const syncroApiKey = process.env.SYNCRO_API_KEY;

    console.log(`➡️ [3/6] Fetching Syncro Invoice #${invoiceId}...`);
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

    // Resolve Email
    let customerEmail = invoice.customer_email || invoice.customer?.email;
    if (!customerEmail && (customerId || invoice.customer_id)) {
      console.log("➡️ Email not in invoice, looking up customer record...");
      const targetCustomerId = customerId || invoice.customer_id;
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

    // 3. Stripe Checkout Session
    console.log(`➡️ [4/6] Creating Stripe Checkout Session ($${(amountInCents/100).toFixed(2)})...`);
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
              name: `Invoice #${invoice.number}`,
              description: `Payment for ${invoice.customer_business_then_name || "SyncroMSP Invoice"}`,
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
        syncro_customer_id: String(customerId || invoice.customer_id || ""),
      },
      success_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=success`,
      cancel_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=cancelled`,
    });

    console.log(`➡️ [5/6] Stripe Session created: ${session.id}`);

    // 4. Send Email via Office 365 OAuth2 (With Fallback)
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 6px;">
        <h2 style="color: #333;">Payment Request for Invoice #${invoice.number}</h2>
        <p>Dear Customer,</p>
        <p>A new payment link has been generated for your invoice.</p>
        <p><strong>Balance Due:</strong> $${(amountInCents / 100).toFixed(2)}</p>
        <p>You can securely complete your payment online using either a <strong>Credit Card</strong> or <strong>ACH Direct Bank Transfer</strong>:</p>
        <p style="margin-top: 25px; text-align: center;">
          <a href="${session.url}" style="background-color: #635bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; display: inline-block;">Pay Invoice Now</a>
        </p>
        <hr style="margin-top: 30px; border: 0; border-top: 1px solid #eee;" />
        <p style="font-size: 12px; color: #777;">If you have any questions, please reply directly to this email.</p>
      </div>
    `;

    console.log(`➡️ [6/6] Sending Email via Office 365 OAuth2 to ${customerEmail}...`);
    let emailSent = false;
    let emailError = null;

    try {
      await transporter.sendMail({
        from: process.env.O365_USER_EMAIL,
        to: customerEmail,
        subject: `Payment Requested: Invoice #${invoice.number}`,
        html: emailHtml,
      });
      console.log("✅ Email successfully sent via Office 365 OAuth2!");
      emailSent = true;
    } catch (mailErr) {
      console.error("⚠️ O365 Nodemailer failed to send email:", mailErr.message);
      emailError = mailErr.message;
    }

    console.log("✅ Responding to client.");
    return res.json({
      success: true,
      emailSent: emailSent,
      paymentUrl: session.url,
      message: emailSent
        ? `Payment link generated and emailed to ${customerEmail}`
        : `Payment link generated, but email failed: ${emailError}`,
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
