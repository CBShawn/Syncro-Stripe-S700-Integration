// services/cache.js
const invoiceCustomerCache = new Map();
const invoicePaymentStatus = new Map();
const processedSyncroPayments = new Set();
const pendingSyncroPayments = new Map();
const activeReaderIntents = new Map();
const invoiceSignatureCache = new Map(); // <-- Ensure this line is present

module.exports = {
  invoiceCustomerCache,
  invoicePaymentStatus,
  processedSyncroPayments,
  pendingSyncroPayments,
  activeReaderIntents,
  invoiceSignatureCache, // <-- Ensure this is exported
};
