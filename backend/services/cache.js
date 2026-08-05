const invoiceCustomerCache = new Map();
const invoicePaymentStatus = new Map();
const processedSyncroPayments = new Set();
const pendingSyncroPayments = new Map();
const activeReaderIntents = new Map();

module.exports = {
  invoiceCustomerCache,
  invoicePaymentStatus,
  processedSyncroPayments,
  pendingSyncroPayments,
  activeReaderIntents,
};
