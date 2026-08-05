require("dotenv").config();

const express = require("express");

const config = require("./config");

const webhookRoute = require("./routes/webhook");
const statusRoutes = require("./routes/status");
const signatureRoutes = require("./routes/signature");
const terminalRoutes = require("./routes/terminal");

const logger = require("./middleware/logger");
const corsMiddleware = require("./middleware/cors");
const bodyParser = require("./middleware/bodyParser");

const app = express();

const PORT = config.PORT;





// =========================================================================
// ROUTES
// =========================================================================

app.use("/api/stripe/webhook", webhookRoute);
app.use("/", statusRoutes);
app.use("/", signatureRoutes);
app.use("/api/terminal", terminalRoutes);
app.use(logger);
app.use(corsMiddleware);

app.options("*", corsMiddleware);

app.use(bodyParser);

app.get("/", (req, res) => {
  res.json({ status: "running", service: "Stripe Invoice & Terminal Middleware" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
