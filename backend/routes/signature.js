const express = require("express");
const axios = require("axios");

const router = express.Router();
const stripe = require("../services/stripe");

router.get("/api/signature/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!fileId) {
      return res.status(400).send("Missing signature file ID");
    }

    const file = await stripe.files.retrieve(fileId);

    if (!file?.url) {
      return res.status(404).send("Stripe signature file not found");
    }

    const response = await axios.get(file.url, {
      auth: {
        username: process.env.STRIPE_SECRET_KEY,
        password: "",
      },
      responseType: "arraybuffer",
    });

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="signature.svg"'
    );

    res.send(response.data);

  } catch (err) {
    console.error(
      "❌ Error retrieving Stripe signature:",
      err.response?.data || err.message
    );

    res.status(500).json({
      error: "Unable to retrieve signature",
    });
  }
});

module.exports = router;
