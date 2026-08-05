const axios = require("axios");

const {
  invoicePaymentStatus,
  processedSyncroPayments,
} = require("./cache");

const PORT = process.env.PORT || 3000;
const SYNCRO_SUBDOMAIN = process.env.SYNCRO_SUBDOMAIN;
const SYNCRO_API_KEY = process.env.SYNCRO_API_KEY;

module.exports = {
  recordSyncroPayment,
  clearTerminalReaderDisplay,
};
