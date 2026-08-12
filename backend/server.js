// Core
require("dotenv").config();
const express = require("express");

// Config
const config = require("./config");

// Middleware
const logger = require("./middleware/logger");
const corsMiddleware = require("./middleware/cors");
const bodyParser = require("./middleware/bodyParser");

// Routes
const webhookRoute = require("./routes/webhook");
const statusRoutes = require("./routes/status");
const signatureRoutes = require("./routes/signature");
const terminalRoutes = require("./routes/terminal");
const paymentEmailRoute = require("./routes/paymentEmail"); // New Route

const app = express();
const PORT = config.PORT;

// =========================================================================
// MIDDLEWARE
// =========================================================================

app.use(corsMiddleware);
app.options("*", corsMiddleware);
app.use(bodyParser);
app.use(logger);

// =========================================================================
// ROUTES
// =========================================================================

app.use("/api/stripe/webhook", webhookRoute);
app.use("/", statusRoutes);
app.use("/", signatureRoutes);
app.use("/api/terminal", terminalRoutes);
app.use("/api", paymentEmailRoute); // Registers /api/send-payment-email

app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "Stripe Invoice & Terminal Middleware",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
