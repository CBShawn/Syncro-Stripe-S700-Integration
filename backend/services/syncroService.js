const axios = require("axios");
const config = require("../config");

const base =
`https://${config.SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1`;


async function getInvoice(invoiceId){

  const result =
    await axios.get(
      `${base}/invoices/${invoiceId}?api_key=${config.SYNCRO_API_KEY}`
    );

  return result.data?.invoice || result.data;
}



async function createPayment(payload){

  const result =
    await axios.post(
      `${base}/payments?api_key=${config.SYNCRO_API_KEY}`,
      payload,
      {
        headers:{
          "Content-Type":"application/json"
        }
      }
    );

  return result.data;

}



async function getCustomer(customerId){

  const result =
    await axios.get(
      `${base}/customers/${customerId}?api_key=${config.SYNCRO_API_KEY}`
    );

  return result.data?.customer || result.data;

}


module.exports = {
  getInvoice,
  createPayment,
  getCustomer
};
