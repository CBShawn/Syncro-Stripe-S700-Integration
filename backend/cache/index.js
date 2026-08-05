module.exports = {

  invoiceCustomerCache: new Map(),

  invoicePaymentStatus: new Map(),

  processedSyncroPayments: new Set(),

  pendingSyncroPayments: new Map(),

  activeReaderIntents: new Map()

};
