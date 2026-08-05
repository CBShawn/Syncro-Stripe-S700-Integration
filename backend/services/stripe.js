const Stripe = require("stripe");

module.exports = Stripe(
  process.env.STRIPE_SECRET_KEY
);
