// routes/paymentEmail.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const axios = require("axios");
const nodemailer = require("nodemailer");
const config = require("../config");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Configure Email Transporter (SMTP)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

router.post("/send-payment-email", async (req, res) => {
  // Validate extension key if configured
  const extensionKey = req.headers["x-extension-key"];
  if (process.env.EXTENSION_AUTH_KEY && extensionKey !== process.env.EXTENSION_AUTH_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized extension key." });
  }

  const { invoiceId, amount, customerId } = req.body;

  if (!invoiceId) {
    return res.status(400).json({ success: false, error: "Missing invoiceId." });
  }

  try {
    // 1. Fetch Invoice Details from SyncroMSP
    const syncroSubdomain = process.env.SYNCRO_SUBDOMAIN;
    const syncroApiKey = process.env.SYNCRO_API_KEY;

    const syncroRes = await axios.get(
      `https://${syncroSubdomain}.syncromsp.com/api/v1/invoices/${invoiceId}`,
      { headers: { Authorization: `Bearer ${syncroApiKey}` } }
    );

    const invoice = syncroRes.data.invoice;

    if (invoice.paid || invoice.balance_due <= 0) {
      return res.status(400).json({ success: false, error: "Invoice is already paid or has no balance due." });
    }

    const customerEmail = invoice.customer_email || invoice.customer?.email;
    if (!customerEmail) {
      return res.status(400).json({ success: false, error: "No customer email found on this Syncro invoice." });
    }

    const amountInCents = Math.round((invoice.balance_due || amount) * 100);

    // 2. Create Stripe Checkout Session (ACH + Card)
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
        syncro_customer_id: String(customerId || invoice.customer_id),
      },
      success_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=success`,
      cancel_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=cancelled`,
    });

    // 3. Send Email with Checkout Link
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

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: customerEmail,
      subject: `Payment Requested: Invoice #${invoice.number}`,
      html: emailHtml,
    });

    return res.json({
      success: true,
      message: `Payment link generated and emailed to ${customerEmail}`,
    });
  } catch (err) {
    console.error("❌ Send Payment Email Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
