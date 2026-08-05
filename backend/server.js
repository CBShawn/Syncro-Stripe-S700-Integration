require("dotenv").config();

const express = require("express");
const cors = require("cors");

const config = require("./config");

const webhookRoute = require("./routes/webhook");
const statusRoutes = require("./routes/status");
const signatureRoutes = require("./routes/signature");
const terminalRoutes = require("./routes/terminal");

const app = express();

const PORT = config.PORT;



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
