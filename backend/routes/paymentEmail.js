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

    // 2. Fetch Syncro Invoice
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

    // 3. Create Stripe Checkout Session (Cards + ACH)
    console.log(`➡️ [4/6] Creating Stripe Checkout Session ($${(amountInCents / 100).toFixed(2)})...`);
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

    // 4. Download Syncro Invoice PDF
    let attachments = [];
    if (invoice.pdf_url) {
      try {
        console.log(`➡️ Downloading Syncro Invoice PDF: ${invoice.pdf_url}`);
        const pdfRes = await axios.get(invoice.pdf_url, {
          responseType: "arraybuffer",
          timeout: 10000,
        });

        if (pdfRes.data && pdfRes.data.length > 0) {
          const base64Pdf = Buffer.from(pdfRes.data).toString("base64");
          attachments.push({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: `Invoice_${invoice.number || invoice.id}.pdf`,
            contentType: "application/pdf",
            contentBytes: base64Pdf,
          });
          console.log(`📎 Attached Invoice_${invoice.number || invoice.id}.pdf`);
        }
      } catch (pdfErr) {
        console.warn("⚠️ PDF download failed, continuing without attachment:", pdfErr.message);
      }
    }

    // 5. Send Branded Email with Stripe ACH Button via Microsoft Graph
    const customerFirstName = invoice.customer?.firstname || invoice.customer_business_then_name || "there";
    const emailSubject = `Invoice #${invoice.number || invoice.id} from CodeBlackIT`;
    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1a202c;">
        <h2 style="margin-top: 0; color: #2d3748;">Invoice #${invoice.number || invoice.id}</h2>
        <p>Hi ${customerFirstName},</p>
        <p>Your invoice from <strong>CodeBlackIT</strong> is ready for review and payment.</p>
        
        <div style="background-color: #f7fafc; border: 1px solid #edf2f7; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="color: #718096; font-size: 14px;">Invoice Number:</td>
              <td style="text-align: right; font-weight: bold;">#${invoice.number || invoice.id}</td>
            </tr>
            <tr>
              <td style="color: #718096; font-size: 14px; padding-top: 8px;">Balance Due:</td>
              <td style="text-align: right; font-weight: bold; color: #00796b; font-size: 20px; padding-top: 8px;">$${(amountInCents / 100).toFixed(2)}</td>
            </tr>
          </table>
        </div>

        <p>You can pay online using a <strong>Credit / Debit Card</strong> or <strong>Direct Bank Transfer (ACH)</strong>:</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${session.url}" style="background-color: #00796b; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; display: inline-block;">Pay Invoice (Card or ACH)</a>
        </div>

        <p style="font-size: 13px; color: #718096;">A copy of your invoice PDF is attached for your records.</p>
        <hr style="margin-top: 30px; border: 0; border-top: 1px solid #e2e8f0;" />
        <p style="font-size: 12px; color: #a0aec0; text-align: center; margin-bottom: 0;">CodeBlackIT | Computer & IT Services</p>
      </div>
    `;

    const senderEmail = process.env.O365_USER_EMAIL;
    const syncroInboundEmail = process.env.SYNCRO_INBOUND_EMAIL;

    const bccList = [];
    if (senderEmail) bccList.push({ emailAddress: { address: senderEmail } });
    if (syncroInboundEmail) bccList.push({ emailAddress: { address: syncroInboundEmail } });

    console.log(`➡️ [5/6] Dispatching email via Microsoft Graph to ${customerEmail}...`);
    await graphClient
      .api(`/users/${senderEmail}/sendMail`)
      .post({
        message: {
          subject: emailSubject,
          body: {
            contentType: "HTML",
            content: emailHtml,
          },
          toRecipients: [{ emailAddress: { address: customerEmail } }],
          bccRecipients: bccList,
          attachments: attachments,
        },
        saveToSentItems: true,
      });

    console.log("✅ Email sent via Graph API with Stripe Card & ACH link!");

    // 6. Log Communication Directly in Syncro
    console.log(`➡️ [6/6] Writing communication log to Syncro...`);
    const logBody = `✉️ Sent Invoice #${invoice.number || invoice.id} payment email to ${customerEmail} ($${(amountInCents / 100).toFixed(2)}).\nStripe Payment Link (Card & ACH): ${session.url}`;

    // A. Log to Ticket Communications (if ticket linked)
    if (invoice.ticket_id) {
      try {
        await axios.post(
          `https://${syncroSubdomain}.syncromsp.com/api/v1/tickets/${invoice.ticket_id}/comment?api_key=${syncroApiKey}`,
          {
            subject: emailSubject,
            body: logBody,
            do_not_email: "1",
            hidden: "0",
          },
          { headers: { "Content-Type": "application/json" }, timeout: 8000 }
        );
        console.log(`✅ Logged to Syncro Ticket #${invoice.ticket_id}`);
      } catch (tErr) {
        console.warn("⚠️ Could not attach comment to Ticket:", tErr.message);
      }
    }

    // B. Log Note to Customer Account
    if (targetCustomerId) {
      try {
        await axios.post(
          `https://${syncroSubdomain}.syncromsp.com/api/v1/customers/${targetCustomerId}/notes?api_key=${syncroApiKey}`,
          {
            body: logBody,
          },
          { headers: { "Content-Type": "application/json" }, timeout: 8000 }
        );
        console.log(`✅ Logged note under Syncro Customer #${targetCustomerId}`);
      } catch (nErr) {
        console.warn("⚠️ Could not write customer note:", nErr.message);
      }
    }

    return res.json({
      success: true,
      emailSent: true,
      paymentUrl: session.url,
      message: `Invoice email with Stripe ACH link sent to ${customerEmail} and logged in Syncro.`,
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
