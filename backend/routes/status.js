// routes/status.js
const express = require("express");
const router = express.Router();

const {
  invoicePaymentStatus,
  processedSyncroPayments,
  pendingSyncroPayments,
  invoiceSignatureCache,
} = require("../services/cache");

// =========================================================================
// 1. EXTENSION POLLING ENDPOINT
// =========================================================================
router.get("/payment-status/:invoiceId", (req, res) => {
  const targetId = String(req.params.invoiceId || "").trim();
  const record = invoicePaymentStatus.get(targetId);

  console.log("🔎 PAYMENT STATUS CHECK:", {
    invoice: targetId,
    record,
    processed: Array.from(processedSyncroPayments || []),
  });

  if (!record) {
    return res.json({
      invoice_id: targetId,
      status: "pending",
    });
  }

  // Return status AND paymentId for Chrome extension
  return res.json({
    invoice_id: targetId,
    status: record.status || "paid",
    amount: record.amount,
    paymentId: record.paymentId || null,
    stripe_invoice_id: record.stripe_invoice_id || "",
    stage: record.stage || null,
    record: record,
  });
});

// =========================================================================
// 2. LIVE CACHE & DATABASE INSPECTOR
// =========================================================================
router.get("/api/admin/cache", (req, res) => {
  const apiKey = req.query.key || req.headers["x-extension-key"] || req.headers["x-admin-key"];
  const expectedKey = process.env.EXTENSION_AUTH_KEY || process.env.ADMIN_SECRET_KEY;

  // Protect route if an auth key is configured in Render
  if (expectedKey && apiKey !== expectedKey) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Provide your key via ?key=YOUR_KEY in the URL",
    });
  }

  return res.json({
    timestamp: new Date().toISOString(),
    total_processed: processedSyncroPayments.size || Array.from(processedSyncroPayments || []).length,
    processed_dedup_keys: Array.from(processedSyncroPayments || []),
    active_invoice_statuses: invoicePaymentStatus.entries
      ? Object.fromEntries(invoicePaymentStatus.entries())
      : invoicePaymentStatus,
    saved_signatures: invoiceSignatureCache.entries
      ? Object.fromEntries(invoiceSignatureCache.entries())
      : invoiceSignatureCache,
  });
});

module.exports = router;
