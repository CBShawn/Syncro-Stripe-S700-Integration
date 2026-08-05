const Stripe = require("stripe");

const config = require("../config");

module.exports = new Stripe(
    config.STRIPE_SECRET_KEY
);
