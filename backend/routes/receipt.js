// routes/receipt.js
const express = require("express");
const router = express.Router();
const axios = require("axios");

const { invoiceSignatureCache } = require("../services/cache");

router.get("/:invoiceId", async (req, res) => {
  const { invoiceId } = req.params;
  const syncroSubdomain = process.env.SYNCRO_SUBDOMAIN;
  const syncroApiKey = process.env.SYNCRO_API_KEY;

  const LOGO_URL =
    process.env.RECEIPT_LOGO_URL ||
    "https://codeblackit.com/wp-content/uploads/2018/05/RepairShopr-Logo.jpg";

  if (!syncroSubdomain || !syncroApiKey) {
    return res.status(500).send("Missing Syncro API credentials.");
  }

  try {
    // 1. Fetch live invoice data from Syncro
    const response = await axios.get(
      `https://${syncroSubdomain}.syncromsp.com/api/v1/invoices/${invoiceId}?api_key=${syncroApiKey}`,
      { timeout: 8000 }
    );

    const invoice = response.data?.invoice;
    if (!invoice) {
      return res.status(404).send("Invoice not found.");
    }

    // Customer & Account Data
    const customer = invoice.customer || {};
    const customerName =
      invoice.customer_business_then_name ||
      customer.business_name ||
      customer.fullname ||
      `${customer.firstname || ""} ${customer.lastname || ""}`.trim() ||
      "Valued Customer";

    const customerAddress = customer.address || "";
    const customerAddress2 = customer.address_2 || "";
    const customerCity = customer.city || "";
    const customerState = customer.state || "";
    const customerZip = customer.zip || "";
    const customerPhone = customer.phone || customer.mobile || "";

    // Financial Values
    const subtotal = `$${parseFloat(invoice.subtotal || 0).toFixed(2)}`;
    const tax = `$${parseFloat(invoice.tax || 0).toFixed(2)}`;
    const total = `$${parseFloat(invoice.total || 0).toFixed(2)}`;
    const balanceDue = `$${parseFloat(invoice.balance_due || 0).toFixed(2)}`;
    const paymentsAmount = `$${(parseFloat(invoice.total || 0) - parseFloat(invoice.balance_due || 0)).toFixed(2)}`;
    const dateFormatted =
      invoice.date ||
      new Date().toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "short",
        day: "numeric",
      });

    const isPaid = invoice.paid || parseFloat(invoice.balance_due || 0) === 0;
    const paidStamp = isPaid
      ? `<div style="border: 2px solid #000; font-weight: 900; padding: 2px 8px; font-size: 13px; text-transform: uppercase; margin-bottom: 6px; display: inline-block;">PAID IN FULL</div>`
      : "";

    // =========================================================================
    // 2. MULTI-TIER SIGNATURE RESOLUTION
    // =========================================================================
    let signatureUrl = invoiceSignatureCache.get(String(invoiceId)) || null;
    let signatureSourceLabel = "Customer Signature (Captured on S700)";

    // Priority 1: Check ref_num and notes on linked payments in the invoice payload
    if (!signatureUrl && Array.isArray(invoice.payments) && invoice.payments.length > 0) {
      for (const p of invoice.payments) {
        const checkText = `${p.ref_num || ""} ${p.notes || ""}`;
        const match = checkText.match(/https?:\/\/[^\s|]+\/api\/signature\/[^\s|]+/i);
        if (match) {
          signatureUrl = match[0];
          break;
        }

        // If file_ ID was saved without full url
        const fileMatch = checkText.match(/file_[a-zA-Z0-9_]+/);
        if (fileMatch) {
          const baseUrl = process.env.RENDER_EXTERNAL_URL || "https://syncro-stripe-s700-integration.onrender.com";
          signatureUrl = `${baseUrl.replace(/\/+$/, '')}/api/signature/${fileMatch[0]}`;
          break;
        }
      }
    }

    // Priority 2: Check if payment record has a direct API endpoint
    if (!signatureUrl && Array.isArray(invoice.payments) && invoice.payments.length > 0) {
      const paymentId = invoice.payments[0].id || invoice.payments[0].payment_id;
      if (paymentId) {
        try {
          const payRes = await axios.get(
            `https://${syncroSubdomain}.syncromsp.com/api/v1/payments/${paymentId}?api_key=${syncroApiKey}`,
            { timeout: 4000 }
          );
          const pData = payRes.data?.payment || {};
          const fullText = `${pData.ref_num || ""} ${pData.notes || ""}`;
          const match = fullText.match(/https?:\/\/[^\s|]+\/api\/signature\/[^\s|]+/i);
          if (match) {
            signatureUrl = match[0];
          } else {
            const fileMatch = fullText.match(/file_[a-zA-Z0-9_]+/);
            if (fileMatch) {
              const baseUrl = process.env.RENDER_EXTERNAL_URL || "https://syncro-stripe-s700-integration.onrender.com";
              signatureUrl = `${baseUrl.replace(/\/+$/, '')}/api/signature/${fileMatch[0]}`;
            }
          }
        } catch (payErr) {
          // ignore error
        }
      }
    }

    // Priority 3: Fallback to Topaz / Syncro native base64 signature
    if (!signatureUrl) {
      signatureUrl = invoice.signature_image || invoice.signature_url || invoice.signature_data || null;

      if (!signatureUrl && Array.isArray(invoice.payments) && invoice.payments.length > 0) {
        const signedPayment = invoice.payments.find(
          (p) => p.signature_image || p.signature_url || p.signature_data || p.signature || p.signature_data_url
        );
        if (signedPayment) {
          signatureUrl =
            signedPayment.signature_image ||
            signedPayment.signature_url ||
            signedPayment.signature_data ||
            signedPayment.signature ||
            signedPayment.signature_data_url;
        }
      }

      if (!signatureUrl && customer.signature) {
        signatureUrl = customer.signature;
      }

      if (signatureUrl) {
        signatureSourceLabel = "Customer Signature";
        if (!signatureUrl.startsWith("data:") && !signatureUrl.startsWith("http")) {
          signatureUrl = `data:image/bmp;base64,${signatureUrl}`;
        }
      }
    }

    // 3. Render Line Items
    const lineItems = invoice.line_items || [];
    const lineItemsHtml = lineItems
      .map(
        (item) => `
      <tr>
        <td class="first item"><strong>${item.name || "Item"}</strong></td>
        <td class="description">${item.description || ""}</td>
        <td class="unitcost">$${parseFloat(item.price || 0).toFixed(2)}</td>
        <td class="quantity">${item.quantity || 1}</td>
        <td class="last linetotal">$${parseFloat(item.total || 0).toFixed(2)}</td>
      </tr>
    `
      )
      .join("");

    // 4. Generate 80mm HTML
    const html = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-type" content="text/html; charset=utf-8"/>
  <title>Receipt - Invoice #${invoice.number || invoice.id}</title>
  <style type="text/css">
    @page {
      size: 80mm auto;
      margin: 0;
    }
    *, *:before, *:after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    html, body {
      width: 72mm;
      margin: 0 auto;
      padding: 4mm 1mm 10mm 1mm;
      font-family: Arial, "Arial Unicode", "Arial Unicode MS", Helvetica, sans-serif;
      font-size: 11px;
      line-height: 14px;
      word-wrap: break-word;
      color: #000;
      background: #fff;
    }

    .print-container { width: 100%; clear: both; }
    .center { text-align: center; }
    .right { text-align: right; }
    .left { text-align: left; }
    .bold { font-weight: bold; }

    .invheader { width: 100%; margin-bottom: 8px; }
    .invheader-upper { width: 100%; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px; text-align: center; }
    .invheader-logo img { max-height: 60px; max-width: 210px; height: auto; width: auto; display: block; margin: 0 auto 4px auto; background: #ffffff; filter: grayscale(100%) contrast(160%); }
    .invheader-address-account { font-size: 11px; line-height: 14px; margin-top: 4px; }
    .invheader-lower { width: 100%; margin-top: 4px; margin-bottom: 8px; }
    .invheader-address-client { font-size: 11px; line-height: 14px; margin-bottom: 6px; }

    .invheader-invoicedetails { width: 100%; margin-top: 6px; }
    .invheader-invoicedetails table { width: 100%; border-collapse: collapse; }
    .invheader-invoicedetails table th { width: 50%; font-weight: normal; text-align: left; font-size: 11px; padding: 2px 0; }
    .invheader-invoicedetails table td { text-align: right; font-size: 11px; padding: 2px 0; }
    .invheader-invoicedetails-balance th, .invheader-invoicedetails-balance td {
      background-color: #e5e5e5; border-top: solid 1px #000; border-bottom: solid 1px #000; font-weight: bold; padding: 4px 2px !important;
    }

    /* ITEMS TABLE */
    .invbody { width: 100%; clear: both; }
    .invbody-items { width: 100%; border-collapse: collapse; margin-top: 6px; margin-bottom: 8px; }
    .invbody-items th { background-color: #e3e3e3; border-top: solid 1px #000; border-bottom: solid 1px #000; font-size: 9.5px; text-transform: uppercase; padding: 3px 1px; text-align: left; }
    .invbody-items td { padding: 4px 1px; border-bottom: solid 1px #e5e5e5; font-size: 10px; vertical-align: top; }
    .invbody-items .unitcost, .invbody-items .quantity, .invbody-items .linetotal { text-align: right; }

    /* SUMMARY TABLE */
    .invbody-summary { width: 100%; margin-top: 6px; border-top: solid 2px #000; padding-top: 4px; }
    .invbody-summary table { width: 100%; border-collapse: collapse; }
    .invbody-summary th { font-weight: normal; text-align: left; font-size: 11px; padding: 2px 0; }
    .invbody-summary td { text-align: right; font-size: 11px; padding: 2px 0; }
    .invbody-summary-total th, .invbody-summary-total td {
      background-color: #e5e5e5; border-top: solid 1px #000; border-bottom: solid 1px #000; font-weight: bold; padding: 4px 2px !important; font-size: 12px;
    }

    .disclaimer-sec { margin-top: 10px; border-top: 1px dashed #000; padding-top: 6px; }
    .disclaimer-sec h2 { font-size: 11px; margin: 0 0 2px 0; text-transform: uppercase; }
    .disclaimer-sec p { font-size: 9px; line-height: 12px; margin: 0; }

    /* SIGNATURE BLOCK */
    .signature-container { margin-top: 12px; text-align: center; width: 100%; }
    .signature-img-tag { max-width: 220px; max-height: 70px; width: auto; height: auto; background-color: #ffffff !important; filter: grayscale(100%) contrast(200%); display: block; margin: 0 auto 4px auto; }
    .signature-line { border-top: 1px solid #000; margin-top: 2px; padding-top: 2px; font-size: 10px; text-align: center; font-weight: bold; }

    .barcode-container { text-align: center; padding: 10px 0; }
    .barcode-container img { max-width: 100%; height: 35px; }

    @media print { body { width: 72mm; margin: 0 auto; } }
  </style>
  <script>
    window.addEventListener('load', function() {
      setTimeout(function() {
        window.print();
      }, 350);
    });
  </script>
</head>
<body>
<div class="print-container">

  <div class="invheader">
    <div class="invheader-upper">
      <div class="invheader-logo">
        <img src="${LOGO_URL}" alt="CodeBlackIT Logo" onerror="this.style.display='none'" />
      </div>

      ${paidStamp}

      <div class="invheader-address-account">
        <strong>CodeBlackIT</strong><br />
        Winter Park, FL<br />
        codeblackit.com
      </div>
    </div>

    <div class="invheader-lower">
      <div class="invheader-address-client">
        <strong>Customer:</strong><br />
        ${customerName}<br />
        ${customerAddress ? `${customerAddress}<br />` : ""}
        ${customerAddress2 ? `${customerAddress2}<br />` : ""}
        ${customerCity ? `${customerCity}, ` : ""}${customerState} ${customerZip}
      </div>

      <div class="invheader-invoicedetails">
        <table cellspacing="0">
          <tbody>
            <tr><th>Invoice #</th><td>${invoice.number || invoice.id}</td></tr>
            <tr><th>Invoice Date</th><td>${dateFormatted}</td></tr>
            <tr class="invheader-invoicedetails-balance"><th>Balance Due</th><td>${balanceDue}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="invbody">
    <table cellspacing="0" class="invbody-items">
      <thead>
        <tr>
          <th class="first" style="width: 35%;">Item</th>
          <th style="width: 25%;">Desc</th>
          <th class="unitcost" style="width: 15%;">Cost</th>
          <th class="quantity" style="width: 10%;">Qty</th>
          <th class="last linetotal" style="width: 15%;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${lineItemsHtml}
      </tbody>
    </table>

    <div class="invbody-summary">
      <div class="invheader-invoicedetails">
        <table cellspacing="0">
          <tbody>
            <tr><th><strong>Subtotal</strong></th><td><strong>${subtotal}</strong></td></tr>
            ${parseFloat(invoice.tax || 0) > 0 ? `<tr><th>Tax</th><td>${tax}</td></tr>` : ""}
            <tr><th>Invoice Total</th><td>${total}</td></tr>
            <tr><th>Payments</th><td>${paymentsAmount}</td></tr>
            <tr class="invbody-summary-total"><th><strong>Balance Due</strong></th><td><strong>${balanceDue}</strong></td></tr>
          </tbody>
        </table>
      </div>

      <div class="disclaimer-sec">
        <h2>Disclaimer</h2>
        <p>Payment Acceptance & Authorization: I agree to pay the total amount indicated above for the parts, diagnostic, and repair services rendered. I acknowledge that all payments are final and non-refundable once the equipment is released. I agree not to initiate a chargeback or dispute for services rendered in accordance with this agreement.

Inspection & Acceptance: I have inspected the equipment and verify that all requested services and repairs have been completed satisfactorily. I confirm receipt of the equipment and any provided accessories in good working order.

Data & Liability: I acknowledge that data backup is my responsibility. The service provider is not liable for data loss, corruption, or recovery needs occurring before, during, or after service.

Limited Warranty: Replaced hardware components and associated labor include a 30-day limited warranty covering defects related directly to the performed repair. This warranty excludes software issues, malware/virus reinfections, accidental damage, liquid intrusion, or subsequent unauthorized tampering.</p>
      </div>

      <!-- Customer Signature Section -->
      <div class="signature-container">
        ${
          signatureUrl
            ? `
          <img class="signature-img-tag" src="${signatureUrl}" alt="Customer Signature" />
          <div class="signature-line">${signatureSourceLabel}</div>
        `
            : `
          <div style="height: 35px;"></div>
          <div class="signature-line">Customer Signature</div>
        `
        }
      </div>

    </div>
  </div>

  ${
    customerPhone
      ? `
    <div class="barcode-container">
      <img src="https://barcode.services.syncromsp.com/barcodes/${encodeURIComponent(
        customerPhone
      )}.png" alt="Barcode" />
    </div>
  `
      : ""
  }

</div>
</body>
</html>
    `;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    console.error("❌ Receipt generation failed:", err.message);
    res.status(500).send(`Failed to generate receipt: ${err.message}`);
  }
});

module.exports = router;
