const axios = require("axios");
const {
  SYNCRO_SUBDOMAIN,
  SYNCRO_API_KEY
} = require("../config");


const syncroBaseUrl =
  `https://${SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1`;


async function getInvoice(invoiceId) {

  const response = await axios.get(
    `${syncroBaseUrl}/invoices/${invoiceId}?api_key=${SYNCRO_API_KEY}`
  );

  return response.data?.invoice || response.data;

}


async function createPayment(paymentPayload) {

  const response = await axios.post(
    `${syncroBaseUrl}/payments?api_key=${SYNCRO_API_KEY}`,
    paymentPayload,
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  return response.data;

}


async function getCustomer(customerId) {

  const response = await axios.get(
    `${syncroBaseUrl}/customers/${customerId}?api_key=${SYNCRO_API_KEY}`
  );

  return response.data?.customer || response.data;

}


module.exports = {
  getInvoice,
  createPayment,
  getCustomer
};
