const axios = require("axios");
const {
  setTerminalReaderDisplay
} = require("../services/terminalService");

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

    console.log(`📱 Reader screen updated with ${items.length} line item(s)`);
  } catch (err) {
    console.error(
      "⚠️ Failed to set reader display:",
      err.response?.data || err.message
    );
  }
}

module.exports = {
  setTerminalReaderDisplay
};
