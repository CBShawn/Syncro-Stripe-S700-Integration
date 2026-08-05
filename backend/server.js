require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const config = require("./config");
const stripe = require("./services/stripe");
const syncro = require("./services/syncroService");
const webhookRoute = require("./routes/webhook");
const statusRoutes = require("./routes/status");
const signatureRoutes = require("./routes/signature");
const terminalRoutes = require("./routes/terminal");

const {
  invoiceCustomerCache,
  invoicePaymentStatus,
  processedSyncroPayments,
  pendingSyncroPayments,
  activeReaderIntents
} = require("./services/cache");

const app = express();

const PORT = config.PORT;

const STRIPE_WEBHOOK_SECRET =
  config.STRIPE_WEBHOOK_SECRET;


// =========================================================================
// 1. CORS & MIDDLEWARE
// =========================================================================

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-extension-auth",
      "x-extension-key",
      "x-requested-with",
    ],
    credentials: true,
  })
);

app.options("*", cors());

app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe/webhook") {
    next();
  } else {
    express.json({
      type: [
        "application/json",
        "text/plain",
        "application/x-www-form-urlencoded",
      ],
    })(req, res, next);
  }
});

// Request logger
app.use((req, res, next) => {
  console.log("===== INCOMING REQUEST =====");
  console.log(req.method, req.url);
  next();
});

// =========================================================================
// HELPER FUNCTIONS
// =========================================================================

async function setTerminalReaderDisplay(readerId, lineItems, totalCents, feeSaverCents = 0) {
  try {
    const items = (Array.isArray(lineItems) && lineItems.length > 0)
      ? lineItems.map((item) => ({
          description: item.description || "Service Item",
          amount: parseInt(item.amount, 10) || 0,
          quantity: 1,
        }))
      : [{
          description: "Syncro Invoice Service Charge",
          amount: totalCents - feeSaverCents,
          quantity: 1,
        }];

    if (feeSaverCents > 0) {
      items.push({
        description: "Processing Fee / Fee Saver",
        amount: feeSaverCents,
        quantity: 1,
      });
    }

    const payload = new URLSearchParams();
    payload.append("type", "cart");
    payload.append("cart[currency]", "usd");
    payload.append("cart[total]", String(totalCents));

    items.forEach((item, index) => {
      payload.append(`cart[line_items][${index}][description]`, item.description);
      payload.append(`cart[line_items][${index}][amount]`, String(item.amount));
      payload.append(`cart[line_items][${index}][quantity]`, String(item.quantity));
    });

    await axios.post(
      `https://api.stripe.com/v1/terminal/readers/${readerId}/set_reader_display`,
      payload.toString(),
      {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    console.log(`📱 Reader screen updated with ${items.length} line item(s) (Pre-Dip Ready).`);
  } catch (err) {
    console.error("⚠️ Failed to set reader display:", err.response?.data || err.message);
  }
}

// =========================================================================
// ROUTES
// =========================================================================

app.use("/api/stripe/webhook", webhookRoute);
app.use("/", statusRoutes);
app.use("/", signatureRoutes);
app.use("/api/terminal", terminalRoutes);

app.get("/", (req, res) => {
  res.json({ status: "running", service: "Stripe Invoice & Terminal Middleware" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
