// routes/paymentEmail.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const axios = require("axios");
const { ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");
require("isomorphic-fetch");

router.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  timeout: 10000, // 10s Stripe API timeout
});

// Configure Azure Application Authentication
const credential = new ClientSecretCredential(
  process.env.O365_TENANT_ID,
  process.env.O365_CLIENT_ID,
  process.env.O365_CLIENT_SECRET
);

// Initialize Microsoft Graph Client
const graphClient = Client.initWithMiddleware({
  authProvider: {
    getAccessToken: async () => {
      const token = await credential.getToken("https://graph.microsoft.com/.default");
      return token.token;
    },
  },
});

router.post("/send-payment-email", async (req, res) => {
  console.log("➡️ [1/7] send-payment-email endpoint reached!");

  try {
    // 1. Auth check
    const extensionKey = req.headers["x-extension-key"];
    if (process.env.EXTENSION_AUTH_KEY && extensionKey !== process.env.EXTENSION_AUTH_KEY) {
      console.log("❌ Unauthorized extension key");
      return res.status(401).json({ success: false, error: "Unauthorized extension key." });
    }

    const { invoiceId, amount, customerId } = req.body || {};
    console.log(`➡️ [2/7] Payload received - Invoice ID: ${invoiceId}, Amount: ${amount}`);

    if (!invoiceId) {
      return res.status(400).json({ success: false, error: "Missing invoiceId." });
    }

    // 2. Syncro API Call (8s timeout)
    const syncroSubdomain = process.env.SYNCRO_SUBDOMAIN;
    const syncroApiKey = process.env.SYNCRO_API_KEY;

    console.log(`➡️ [3/7] Fetching Syncro Invoice #${invoiceId}...`);
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

    // Resolve Email & Customer ID
    let customerEmail = invoice.customer_email || invoice.customer?.email;
    let targetCustomerId = customerId || invoice.customer_id || invoice.customer?.id;

    if (!customerEmail && targetCustomerId) {
      console.log("➡️ Email not in invoice, looking up customer record...");
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
    console.log(`➡️ [4/7] Creating Stripe Checkout Session ($${(amountInCents/100).toFixed(2)})...`);
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
        syncro_customer_id: String(targetCustomerId || ""),
      },
      success_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=success`,
      cancel_url: `https://${syncroSubdomain}.syncromsp.com/invoices/${invoice.id}?payment=cancelled`,
    });

    console.log(`➡️ [5/7] Stripe Session created: ${session.id}`);

    // 4. Build Email Content
    const emailSubject = `Payment Requested: Invoice #${invoice.number}`;
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

    console.log(`➡️ [6/7] Sending Email via Graph API to ${customerEmail}...`);
    let emailSent = false;
    let emailError = null;

    try {
      const senderEmail = process.env.O365_USER_EMAIL;

      const mailPayload = {
        message: {
          subject: emailSubject,
          body: {
            contentType: "HTML",
            content: emailHtml,
          },
          toRecipients: [
            {
              emailAddress: {
                address: customerEmail,
              },
            },
          ],
        },
        saveToSentItems: true,
      };

      await graphClient
        .api(`/users/${senderEmail}/sendMail`)
        .post(mailPayload);

      console.log("✅ Email successfully sent via Microsoft Graph API!");
      emailSent = true;

      // 5. Attach Log Record via Syncro's valid Comments / Ticket endpoint
      console.log(`➡️ [7/7] Logging email communication in Syncro...`);
      try {
        const emailLogBody = `✉️ Payment request email sent to ${customerEmail} for Invoice #${invoice.number} ($${(amountInCents / 100).toFixed(2)}).\nStripe Link: ${session.url}`;

        if (invoice.ticket_id) {
          // A. If tied to a ticket, log directly to Ticket Communications Log
          await axios.post(
            `https://${syncroSubdomain}.syncromsp.com/api/v1/tickets/${invoice.ticket_id}/comment?api_key=${syncroApiKey}`,
            {
              subject: emailSubject,
              body: emailLogBody,
              do_not_email: "1",
              hidden: "0",
            },
            { headers: { "Content-Type": "application/json" }, timeout: 8000 }
          );
          console.log(`✉️ Email log attached to Ticket #${invoice.ticket_id} communications!`);
        } else {
          // B. Otherwise, post as an Invoice Comment
          await axios.post(
            `https://${syncroSubdomain}.syncromsp.com/api/v1/invoices/${invoice.id}/comments?api_key=${syncroApiKey}`,
            {
              comment: {
                subject: emailSubject,
                body: emailLogBody,
              },
            },
            { headers: { "Content-Type": "application/json" }, timeout: 8000 }
          );
          console.log(`✉️ Email log attached to Invoice #${invoice.id} comments!`);
        }
      } catch (commErr) {
        console.warn("⚠️ Syncro log attachment notice:", commErr.response?.data || commErr.message);
      }

    } catch (graphErr) {
      console.error("⚠️ Microsoft Graph API failed to send email:", graphErr.message);
      emailError = graphErr.message;
    }

    console.log("✅ Responding to client.");
    return res.json({
      success: true,
      emailSent: emailSent,
      paymentUrl: session.url,
      message: emailSent
        ? `Payment link generated, sent to ${customerEmail}, and logged in Syncro.`
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
