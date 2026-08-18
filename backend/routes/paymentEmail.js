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
  timeout: 10000,
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

    // 2. Syncro API Call
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

    // 3. Stripe Checkout Session (Cards + ACH Direct Debit)
    console.log(`➡️ [4/7] Creating Stripe Checkout Session ($${(amountInCents / 100).toFixed(2)})...`);
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

    console.log(`➡️ [5/7] Stripe Session created: ${session.id}`);

    // Fetch and buffer the official Syncro PDF printout
    let attachments = [];
    try {
      console.log(`➡️ Fetching PDF printout for Invoice #${invoice.id}...`);
      const pdfRes = await axios.get(
        `https://${syncroSubdomain}.syncromsp.com/api/v1/invoices/${invoice.id}/print?api_key=${syncroApiKey}`,
        { responseType: "arraybuffer", timeout: 8000 }
      );

      if (pdfRes.data) {
        const base64Pdf = Buffer.from(pdfRes.data).toString("base64");
        attachments.push({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: `Invoice_${invoice.number || invoice.id}.pdf`,
          contentType: "application/pdf",
          contentBytes: base64Pdf,
        });
        console.log(`📎 Attached Invoice_${invoice.number || invoice.id}.pdf (${base64Pdf.length} bytes base64)`);
      }
    } catch (pdfErr) {
      console.warn("⚠️ Could not fetch Syncro PDF attachment, proceeding without it:", pdfErr.message);
    }

    // 4. Build Email HTML Body
    const emailSubject = `Invoice #${invoice.number || invoice.id} from CodeBlackIT`;
    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1a202c;">
        <h2 style="margin-top: 0; color: #2d3748;">Invoice #${invoice.number || invoice.id}</h2>
        <p>Hello,</p>
        <p>Your invoice from <strong>CodeBlackIT</strong> is ready for review and payment.</p>
        
        <div style="background-color: #f7fafc; border: 1px solid #edf2f7; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="color: #718096; font-size: 14px;">Invoice Number:</td>
              <td style="text-align: right; font-weight: bold;">#${invoice.number || invoice.id}</td>
            </tr>
            <tr>
              <td style="color: #718096; font-size: 14px; padding-top: 8px;">Balance Due:</td>
              <td style="text-align: right; font-weight: bold; color: #2b6cb0; font-size: 18px; padding-top: 8px;">$${(amountInCents / 100).toFixed(2)}</td>
            </tr>
          </table>
        </div>

        <p>You can securely pay online using a <strong>Credit Card</strong> or <strong>Direct Bank Transfer (ACH)</strong>:</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${session.url}" style="background-color: #00796b; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; display: inline-block;">Pay Invoice Now</a>
        </div>

        <p style="font-size: 13px; color: #718096;">A copy of your invoice PDF is attached to this email for your records.</p>
        <hr style="margin-top: 30px; border: 0; border-top: 1px solid #e2e8f0;" />
        <p style="font-size: 12px; color: #a0aec0; text-align: center; margin-bottom: 0;">CodeBlackIT | Computer & IT Services</p>
      </div>
    `;

    // 5. Build BCC List (Sender Mailbox + Syncro Inbound)
    const senderEmail = process.env.O365_USER_EMAIL;
    const syncroInboundEmail = process.env.SYNCRO_INBOUND_EMAIL;

    const bccList = [];
    if (senderEmail) {
      bccList.push({ emailAddress: { address: senderEmail } });
    }
    if (syncroInboundEmail) {
      bccList.push({ emailAddress: { address: syncroInboundEmail } });
    }

    console.log(`➡️ [6/7] Sending Email via Graph API to ${customerEmail} (BCC Count: ${bccList.length})...`);
    let emailSent = false;
    let emailError = null;

    try {
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
          bccRecipients: bccList,
          attachments: attachments,
        },
        saveToSentItems: true,
      };

      await graphClient
        .api(`/users/${senderEmail}/sendMail`)
        .post(mailPayload);

      console.log("✅ Email successfully sent via Microsoft Graph API!");
      emailSent = true;

      // 6. Log Communication in Syncro Ticket (if linked)
      console.log(`➡️ [7/7] Checking Syncro communication logging...`);
      if (invoice.ticket_id) {
        try {
          const emailLogBody = `✉️ Payment request email sent to ${customerEmail} for Invoice #${invoice.number} ($${(amountInCents / 100).toFixed(2)}).\nStripe Checkout: ${session.url}`;

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
          console.log(`✉️ Email log attached to Ticket #${invoice.ticket_id}!`);
        } catch (commErr) {
          console.warn("⚠️ Failed to attach comment to Syncro ticket:", commErr.response?.data || commErr.message);
        }
      }
    } catch (graphErr) {
      console.error("⚠️ Microsoft Graph API failed to send email:", graphErr.message);
      emailError = graphErr.message;
    }

    return res.json({
      success: true,
      emailSent: emailSent,
      paymentUrl: session.url,
      message: emailSent
        ? `Payment link generated, PDF attached, and email sent to ${customerEmail}.`
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
