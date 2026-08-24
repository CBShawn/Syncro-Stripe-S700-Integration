const axios = require("axios");
const config = require("../config");

const base = `https://${config.SYNCRO_SUBDOMAIN}.syncromsp.com/api/v1`;

async function getInvoice(invoiceId) {
  const result = await axios.get(
    `${base}/invoices/${invoiceId}?api_key=${config.SYNCRO_API_KEY}`
  );
  return result.data?.invoice || result.data;
}

async function updateInvoice(invoiceId, payload) {
  const result = await axios.put(
    `${base}/invoices/${invoiceId}?api_key=${config.SYNCRO_API_KEY}`,
    payload,
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
  return result.data?.invoice || result.data;
}

async function createPayment(payload) {
  const result = await axios.post(
    `${base}/payments?api_key=${config.SYNCRO_API_KEY}`,
    payload,
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
  return result.data;
}

async function getCustomer(customerId) {
  const result = await axios.get(
    `${base}/customers/${customerId}?api_key=${config.SYNCRO_API_KEY}`
  );
  return result.data?.customer || result.data;
}

/**
 * Ensures "Shop Supplies" is added ONLY if:
 * 1. The invoice contains at least one Labor line item.
 * 2. "Shop Supplies" is not already on the invoice.
 */
async function ensureShopSupplies(invoiceId, existingLineItems = []) {
  // 1. Check if the invoice has any Labor items
  const hasLabor = existingLineItems.some((item) => {
    const name = (item.name || "").toLowerCase();
    const desc = (item.description || "").toLowerCase();
    const category = (item.category || item.product_category || "").toLowerCase();

    return (
      category.includes("labor") ||
      category.includes("service") ||
      name.includes("labor") ||
      name.includes("service") ||
      name.includes("diagnostic") ||
      name.includes("repair") ||
      desc.includes("labor")
    );
  });

  if (!hasLabor) {
    console.log(`ℹ️ Invoice #${invoiceId} has no labor/service line items. Skipping Shop Supplies.`);
    return false;
  }

  // 2. Check if Shop Supplies is already present
  const hasSupplies = existingLineItems.some(
    (item) => (item.name || item.description || "").toLowerCase().includes("shop supplies")
  );

  if (hasSupplies) {
    console.log(`ℹ️ Invoice #${invoiceId} already contains Shop Supplies. Skipping.`);
    return false;
  }

  try {
    // 3. Fetch "Shop Supplies" product from Syncro Inventory
    console.log(`🔍 Fetching "Shop Supplies" price from Syncro Inventory...`);
    const productRes = await axios.get(
      `${base}/products?query=Shop Supplies&api_key=${config.SYNCRO_API_KEY}`,
      { timeout: 8000 }
    );

    const products = productRes.data?.products || [];
    const supplyProduct = products.find(
      (p) => (p.name || "").trim().toLowerCase() === "shop supplies"
    ) || products[0];

    if (!supplyProduct) {
      console.warn("⚠️ 'Shop Supplies' product not found in Syncro Inventory. Skipping injection.");
      return false;
    }

    const unitPrice = parseFloat(supplyProduct.price_retail ?? supplyProduct.price_cost ?? 0);

    // 4. Inject the line item into the invoice
    console.log(`➕ Adding Shop Supplies ($${unitPrice.toFixed(2)}) to Invoice #${invoiceId}...`);
    await axios.post(
      `${base}/invoices/${invoiceId}/line_items?api_key=${config.SYNCRO_API_KEY}`,
      {
        product_id: supplyProduct.id,
        name: supplyProduct.name,
        description: supplyProduct.description || "Shop materials and consumables",
        price: unitPrice,
        quantity: 1,
        taxable: supplyProduct.taxable !== undefined ? supplyProduct.taxable : true,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 8000,
      }
    );

    console.log(`✅ Shop Supplies added to Invoice #${invoiceId}!`);
    return true;
  } catch (err) {
    console.error("❌ Failed to inject Shop Supplies into invoice:", err.response?.data || err.message);
    return false;
  }
}

module.exports = {
  getInvoice,
  updateInvoice,
  createPayment,
  getCustomer,
  ensureShopSupplies,
};
