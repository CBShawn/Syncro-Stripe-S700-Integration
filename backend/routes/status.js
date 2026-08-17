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
    processed: Array.from(processedSyncroPayments || [])
  });

  if (!record) {
    return res.json({
      invoice_id: targetId,
      status: "pending"
    });
  }

  // Return status AND paymentId
  return res.json({
    invoice_id: targetId,
    status: record.status || "paid",
    amount: record.amount,
    paymentId: record.paymentId || null,
    stripe_invoice_id: record.stripe_invoice_id || "",
    stage: record.stage || null,
    record: record
  });
});

module.exports = router;
