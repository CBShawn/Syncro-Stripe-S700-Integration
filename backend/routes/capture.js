// routes/capture.js
const express = require("express");
const router = express.Router();
const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 1. Capture a single PaymentIntent
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

// 2. Cancel an uncaptured PaymentIntent ($0 fee)
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

// 3. Batch Capture all pending authorizations (e.g. End of Day)
router.post("/capture-all", async (req, res) => {
  try {
    const list = await stripe.paymentIntents.list({ limit: 100 });
    const uncaptured = list.data.filter((pi) => pi.status === "requires_capture");

    console.log(`🔄 Found ${uncaptured.length} intents requiring capture.`);

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
