// routes/capture.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// =========================================================================
// API KEY AUTHENTICATION MIDDLEWARE
// =========================================================================
const authenticateAPI = (req, res, next) => {
  const apiKey = req.headers["x-api-key"] || req.headers["x-extension-key"];
  const secretKey = process.env.INTERNAL_API_KEY || process.env.EXTENSION_AUTH_KEY;

  if (!secretKey || apiKey !== secretKey) {
    console.warn("🚫 Unauthorized attempt on protected capture endpoint.");
    return res.status(401).json({ success: false, error: "Unauthorized: Invalid or missing API key." });
  }
  next();
};

// Apply auth to all routes in this router
router.use(authenticateAPI);

// =========================================================================
// 1. CAPTURE SINGLE PAYMENTINTENT
// =========================================================================
router.post("/capture/:paymentIntentId", async (req, res) => {
  const { paymentIntentId } = req.params;
  try {
    const intent = await stripe.paymentIntents.capture(paymentIntentId);
    console.log(`✅ Captured PaymentIntent: ${intent.id}`);
    return res.json({ success: true, intent });
  } catch (err) {
    console.error(`❌ Capture failed for ${paymentIntentId}:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 2. CANCEL UNCAPTURED PAYMENTINTENT ($0 FEE)
// =========================================================================
router.post("/cancel/:paymentIntentId", async (req, res) => {
  const { paymentIntentId } = req.params;
  try {
    const intent = await stripe.paymentIntents.cancel(paymentIntentId);
    console.log(`🚫 Cancelled uncaptured PaymentIntent: ${intent.id} ($0 fee)`);
    return res.json({ success: true, intent });
  } catch (err) {
    console.error(`❌ Cancel failed for ${paymentIntentId}:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 3. BATCH CAPTURE ALL MANUAL AUTHORIZATIONS
// =========================================================================
router.post("/capture-all", async (req, res) => {
  try {
    const list = await stripe.paymentIntents.list({ limit: 100 });
    
    // Strict filter: only capture manual holds pending capture
    const uncaptured = list.data.filter(
      (pi) => pi.status === "requires_capture" && pi.capture_method === "manual"
    );

    console.log(`🔄 Found ${uncaptured.length} manual intents requiring capture.`);

    const results = [];
    for (const pi of uncaptured) {
      try {
        const captured = await stripe.paymentIntents.capture(pi.id);
        results.push({ id: pi.id, status: "captured", amount: captured.amount });
      } catch (capErr) {
        results.push({ id: pi.id, status: "error", error: capErr.message });
      }
    }

    return res.json({ success: true, capturedCount: results.length, results });
  } catch (err) {
    console.error("❌ Batch capture error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
