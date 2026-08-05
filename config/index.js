require("dotenv").config();

module.exports = {

    PORT:
        process.env.PORT || 3000,

    STRIPE_SECRET_KEY:
        process.env.STRIPE_SECRET_KEY,

    STRIPE_WEBHOOK_SECRET:
        process.env.STRIPE_WEBHOOK_SECRET,

    SYNCRO_SUBDOMAIN:
        process.env.SYNCRO_SUBDOMAIN,

    SYNCRO_API_KEY:
        process.env.SYNCRO_API_KEY,

    DEFAULT_STRIPE_READER_ID:
        process.env.DEFAULT_STRIPE_READER_ID,

    BASE_URL:
        process.env.RENDER_EXTERNAL_URL ||
        process.env.BASE_URL

};
