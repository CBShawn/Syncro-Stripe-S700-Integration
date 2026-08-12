// middleware/bodyParser.js
const express = require("express");

module.exports = (req, res, next) => {
  // 1. Skip global body parsing for Stripe Webhook (handled by express.raw inside webhook route)
  if (req.originalUrl.includes("/api/stripe/webhook")) {
    return next();
  }

  // 2. Parse standard JSON requests
  express.json()(req, res, (err) => {
    if (err) {
      console.error("❌ JSON Body Parse Error:", err.message);
      return res.status(400).json({ success: false, error: "Invalid JSON payload" });
    }
    next();
  });
};
