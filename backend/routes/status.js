const express = require("express");
const router = express.Router();

const {
  invoicePaymentStatus,
  processedSyncroPayments,
  pendingSyncroPayments
} = require("../services/cache");

router.get('/payment-status/:invoiceId', (req, res) => {
  const targetId = String(req.params.invoiceId || "").trim();

  const record = invoicePaymentStatus.get(targetId);

  console.log("🔎 PAYMENT STATUS CHECK:", {
    invoice: targetId,
    record,
    processed: Array.from(processedSyncroPayments)
  });

  if (record && record.status === "paid" && !record.stage) {
    return res.json({
      invoice_id: targetId,
      status: "paid",
      amount: record.amount,
      stripe_invoice_id: record.stripe_invoice_id || "",
    });
  }

  if (record && record.status === "awaiting_signature") {
    return res.json({
      invoice_id: targetId,
      status: "paid",
      stage: "awaiting_signature",
    });
  }

  res.json({
    invoice_id: targetId,
    status: "pending"
  });
});

module.exports = router;
