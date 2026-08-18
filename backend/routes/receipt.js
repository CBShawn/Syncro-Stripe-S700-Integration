// routes/receipt.js
const express = require("express");
const router = express.Router();
const axios = require("axios");

router.get("/:invoiceId", async (req, res) => {
  const { invoiceId } = req.params;
  const syncroSubdomain = process.env.SYNCRO_SUBDOMAIN;
  const syncroApiKey = process.env.SYNCRO_API_KEY;

  try {
    const response = await axios.get(
      `https://${syncroSubdomain}.syncromsp.com/api/v1/invoices/${invoiceId}?api_key=${syncroApiKey}`
    );
    const invoice = response.data?.invoice || {};

    const customerName =
      invoice.customer_business_then_name ||
      invoice.customer?.business_name ||
      invoice.customer?.fullname ||
      "Valued Customer";

    const lineItems = invoice.line_items || [];
    const dateFormatted = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Receipt - Invoice #${invoice.number || invoice.id}</title>
  <style>
    @page {
      size: 80mm auto;
      margin: 0;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body {
      width: 72mm;
      margin: 0 auto;
      padding: 6mm 1mm 12mm 1mm;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, monospace;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.35;
      color: #000;
      background: #fff;
    }
    .center { text-align: center; }
    .right { text-align: right; }
    .left { text-align: left; }
    .bold { font-weight: 900; }
    
    .brand-title {
      font-size: 20px;
      font-weight: 900;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .brand-sub {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 2px;
    }

    .divider-dash {
      border-top: 1.5px dashed #000;
      margin: 6px 0;
      width: 100%;
    }
    .divider-solid {
      border-top: 2px solid #000;
      margin: 6px 0;
      width: 100%;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }
    .meta-table td {
      padding: 2px 0;
      font-size: 12px;
      vertical-align: top;
    }

    .items-table th {
      border-bottom: 1.5px solid #000;
      padding: 4px 0;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .items-table td {
      padding: 4px 0;
      vertical-align: top;
      font-size: 12px;
    }

    .totals-table {
      margin-top: 4px;
      font-size: 13px;
    }
    .totals-table td {
      padding: 2px 0;
    }
    .grand-total {
      font-size: 16px;
      font-weight: 900;
      border-top: 2px solid #000;
      border-bottom: 2px solid #000;
      padding: 5px 0 !important;
    }

    .footer {
      font-size: 10px;
      font-weight: 600;
      margin-top: 8px;
      line-height: 1.25;
    }

    @media print {
      body { width: 72mm; margin: 0 auto; }
    }
  </style>
</head>
<body onload="window.print()">

  <div class="center brand-title">CodeBlackIT</div>
  <div class="center brand-sub">Computer Services & IT Support</div>
  <div class="center brand-sub">Winter Park, FL</div>

  <div class="divider-dash"></div>

  <table class="meta-table">
    <tr>
      <td class="bold left">Invoice #: ${invoice.number || invoice.id}</td>
      <td class="right">${dateFormatted}</td>
    </tr>
    <tr>
      <td colspan="2" class="left"><strong>Customer:</strong> ${customerName}</td>
    </tr>
  </table>

  <div class="divider-solid"></div>

  <table class="items-table">
    <thead>
      <tr>
        <th class="left" style="width: 55%;">Item</th>
        <th class="center" style="width: 15%;">Qty</th>
        <th class="right" style="width: 30%;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${lineItems.map(item => `
        <tr>
          <td class="left bold">${item.name || item.item || "Service"}</td>
          <td class="center bold">${item.quantity || 1}</td>
          <td class="right bold">$${parseFloat(item.total || 0).toFixed(2)}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>

  <div class="divider-dash"></div>

  <table class="totals-table">
    <tr>
      <td class="left">Subtotal:</td>
      <td class="right">$${parseFloat(invoice.subtotal || 0).toFixed(2)}</td>
    </tr>
    ${parseFloat(invoice.tax || 0) > 0 ? `
      <tr>
        <td class="left">Tax:</td>
        <td class="right">$${parseFloat(invoice.tax).toFixed(2)}</td>
      </tr>
    ` : ""}
    <tr class="grand-total">
      <td class="left">TOTAL DUE:</td>
      <td class="right">$${parseFloat(invoice.total || 0).toFixed(2)}</td>
    </tr>
    ${invoice.paid || parseFloat(invoice.balance_due) === 0 ? `
      <tr>
        <td class="left bold" style="padding-top: 4px;">Status:</td>
        <td class="right bold" style="padding-top: 4px;">PAID IN FULL</td>
      </tr>
    ` : `
      <tr class="bold">
        <td class="left" style="padding-top: 4px;">Balance Due:</td>
        <td class="right" style="padding-top: 4px;">$${parseFloat(invoice.balance_due || 0).toFixed(2)}</td>
      </tr>
    `}
  </table>

  <div class="divider-dash"></div>

  <div class="center bold" style="font-size: 12px;">THANK YOU FOR YOUR BUSINESS!</div>
  <div class="center footer">
    Hardware warranty & service policy apply.<br>
    codeblackit.com
  </div>

</body>
</html>
    `;

    res.setHeader("Content-Type", "text/html");
    res.send(html);

  } catch (err) {
    console.error("❌ Receipt error:", err.message);
    res.status(500).send("Error generating receipt.");
  }
});

module.exports = router;
