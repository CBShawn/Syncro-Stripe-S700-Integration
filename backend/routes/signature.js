const express = require("express");
const stripe = require("../services/stripe");
const axios = require("axios");

const router = express.Router();

router.get("/api/signature/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;

    const file = await stripe.files.retrieve(fileId);

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
    console.error("Error retrieving signature:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
