// routes/webhook.js
const express = require("express");
const axios = require("axios");
const Stripe = require("stripe");

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const syncro = require("../services/syncroService");

const {
  invoicePaymentStatus,
  pendingSyncroPayments,
  invoiceCustomerCache,
  invoiceSignatureCache,
} = require("../services/cache");

const {
  recordSyncroPayment,
  clearTerminalReaderDisplay,
} = require("../services/payment");

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

async function fetchStripeSignatureBase64(fileId, retries = 3) {
  if (!fileId) return null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      const res = await axios.get(`https://api.stripe.com/v1/files/${fileId}/contents`, {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        },
        responseType: "arraybuffer",
        timeout: 6000,
      });
      const contentType = res.headers["content-type"] || "image/svg+xml";
      const base64 = Buffer.from(res.data, "binary").toString("base64");
      return `data:${contentType};base64,${base64}`;
    } catch (err) {
      if (attempt === retries) {
        console.warn(`⚠️ Could not fetch Stripe file contents for ${fileId}:`, err.message);
        return null;
      }
    }
  }
  return null;
}

function buildSyncroInvoiceNote({
  isTerminal = false,
  resolvedClientIp = null,
  stripePaymentIntentId = null,
  chargeId = null,
  cardInfo = {},
  usBankAccount = {},
  currency = "usd",
  amountCents = 0,
  amountReceivedCents = 0,
  cleanSigFileId = null,
  signatureUrl = null,
  receiptUrl = null,
}) {
  return [
    isTerminal ? "Stripe Terminal Payment" : "Stripe Online Payment",
    resolvedClientIp ? `Client IP: ${resolvedClientIp}` : null,
    `PaymentIntent: ${stripePaymentIntentId || "N/A"}`,
    `Charge: ${chargeId || "N/A"}`,
    usBankAccount.bank_name
      ? `ACH Bank: ${usBankAccount.bank_name}`
      : `Card: ${cardInfo.description || cardInfo.brand || "N/A"}`,
    `Card Type: ${cardInfo.brand || "N/A"}`,
    `Cardholder: ${cardInfo.cardholder_name || "N/A"}`,
    `Last 4: ****${usBankAccount.last4 || cardInfo.last4 || "N/A"}`,
    `Funding: ${cardInfo.funding || "N/A"}`,
    `Issuer: ${cardInfo.issuer || "N/A"}`,
    `Country: ${cardInfo.country || "N/A"}`,
    `Expiration: ${cardInfo.exp_month ? String(cardInfo.exp_month).padStart(2, "0") : "N/A"}/${cardInfo.exp_year || "N/A"}`,
    `Currency: ${(currency || "usd").toUpperCase()}`,
    `Amount: $${(amountCents / 100).toFixed(2)}`,
    `Amount Received: $${(amountReceivedCents / 100).toFixed(2)}`,
    cleanSigFileId ? `Signature File: ${cleanSigFileId}` : null,
    signatureUrl ? `Signature URL: ${signatureUrl}` : null,
    receiptUrl ? `Receipt: ${receiptUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function createStripeInvoiceBackup(syncroInvoiceId, syncroCustomerId, paymentIntentId, stripeCustomerId) {
  try {
    console.log(`📄 Creating Stripe Invoice backup for Syncro Invoice #${syncroInvoiceId}...`);

    const syncroInvoice = await syncro.getInvoice(syncroInvoiceId);
    const subtotal = parseFloat(syncroInvoice.subtotal || 0);
    const total = parseFloat(syncroInvoice.total || 0);
    const taxAmount = total - subtotal;
    let taxRate = subtotal > 0 ? (taxAmount / subtotal) * 100 : 0;
    taxRate = Math.round(taxRate * 10000) / 10000;

    let taxRateId = null;
    if (taxAmount > 0.01 && taxRate > 0) {
      // Check existing rates first to prevent duplicate accumulation
      const existingRates = await stripe.taxRates.list({ active: true, limit: 10 });
      const matched = existingRates.data.find((r) => Math.abs(r.percentage - taxRate) < 0.001);

      if (matched) {
        taxRateId = matched.id;
      } else {
        const stripeTaxRate = await stripe.taxRates.create({
          display_name: "Sales Tax",
          percentage: taxRate,
          inclusive: false,
          description: `Sales Tax (${taxRate.toFixed(2)}%)`,
        });
        taxRateId = stripeTaxRate.id;
      }
    }

    const stripeInvoice = await stripe.invoices.create({
      customer: stripeCustomerId,
      collection_method: "send_invoice",
      days_until_due: 0,
      default_tax_rates: taxRateId ? [taxRateId] : [],
      metadata: {
        syncro_invoice_id: String(syncroInvoiceId),
        syncro_customer_id: String(syncroCustomerId),
        stripe_payment_intent: paymentIntentId,
      },
    });

    if (syncroInvoice?.line_items?.length > 0) {
      for (const item of syncroInvoice.line_items) {
        const itemName = item.name || item.item || "Service";
        const itemQty = parseFloat(item.quantity || 1);
        const itemPrice = parseFloat(item.price || item.rate || 0);

        if (Number.isInteger(itemQty)) {
          await stripe.invoiceItems.create({
            customer: stripeCustomerId,
            invoice: stripeInvoice.id,
            description: itemName,
            quantity: itemQty,
            unit_amount: Math.round(itemPrice * 100),
            currency: "usd",
            tax_rates: taxRateId ? [taxRateId] : [],
          });
        } else {
          const totalAmount = itemQty * itemPrice;
          await stripe.invoiceItems.create({
            customer: stripeCustomerId,
            invoice: stripeInvoice.id,
            description: `${itemName} (${itemQty} × $${itemPrice.toFixed(2)})`,
            amount: Math.round(totalAmount * 100),
            currency: "usd",
            tax_rates: taxRateId ? [taxRateId] : [],
          });
        }
      }
    } else {
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        invoice: stripeInvoice.id,
        amount: Math.round(parseFloat(syncroInvoice.total || 0) * 100),
        currency: "usd",
        description: `Syncro Invoice #${syncroInvoiceId}`,
      });
    }

    await stripe.invoices.finalizeInvoice(stripeInvoice.id, { auto_advance: false });
    await stripe.invoices.pay(stripeInvoice.id, { paid_out_of_band: true });

    return stripeInvoice;
  } catch (invoiceErr) {
    console.error(`⚠️ Failed to create Stripe Invoice backup for Syncro Invoice #${syncroInvoiceId}:`, invoiceErr.message);
    return null;
  }
}

router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error(`❌ Webhook Signature Verification Failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`✅ Webhook Received: ${event.type}`);

  try {
    // 1. Terminal Reader Input Collected (Signature captured on reader)
    if (event.type === "terminal.reader.action_succeeded") {
      const readerObj = event.data.object;
      const action = readerObj.action || {};

      if (action.type === "collect_inputs") {
        const metadata = action.collect_inputs?.metadata || readerObj.metadata || {};
        const paymentIntentId = metadata.payment_intent_id;
        let fileId = null;

        const collectInputs = action.collect_inputs?.inputs || action.process_input?.inputs || [];
        for (const input of collectInputs) {
          if (input.type === "signature") {
            fileId = input.signature?.value || input.value || input.signature;
            if (fileId) break;
          }
        }

        if (paymentIntentId) {
          let base64Sig = null;
          if (fileId) {
            try {
              await stripe.paymentIntents.update(paymentIntentId, {
                metadata: {
                  stripe_signature_file_id: String(fileId),
                  signed_at: new Date().toISOString(),
                },
              });
              base64Sig = await fetchStripeSignatureBase64(fileId);
            } catch (updateErr) {
              console.error("⚠️ Failed to update PaymentIntent with signature file ID:", updateErr.message);
            }
          }

          const pending = pendingSyncroPayments.get(String(paymentIntentId));
          if (pending) {
            pendingSyncroPayments.delete(String(paymentIntentId));

            const hostBase = process.env.RENDER_EXTERNAL_URL || `https://${req.get("host") || "syncro-stripe-s700-integration.onrender.com"}`;
            const baseUrl = hostBase.replace(/\/+$/, "");
            const signatureEndpointUrl = fileId ? `${baseUrl}/api/signature/${fileId}` : null;

            if (base64Sig) {
              invoiceSignatureCache.set(String(pending.syncroInvoiceId), base64Sig);
            } else if (signatureEndpointUrl) {
              invoiceSignatureCache.set(String(pending.syncroInvoiceId), signatureEndpointUrl);
            }

            const syncroPaymentRes = await recordSyncroPayment(
              pending.syncroInvoiceId,
              pending.syncroCustomerId,
              pending.amountString,
              pending.paymentIntentId,
              null,
              fileId,
              "Stripe Terminal",
              null
            );

            const syncroPaymentId = syncroPaymentRes?.payment?.id || null;

            invoicePaymentStatus.set(String(pending.syncroInvoiceId), {
              status: "paid",
              amount: pending.amountString,
              paymentId: syncroPaymentId,
            });

            try {
              const fullPi = await stripe.paymentIntents.retrieve(paymentIntentId, {
                expand: ["latest_charge", "payment_method"],
              });

              const charge = typeof fullPi.latest_charge === "object" ? fullPi.latest_charge : null;
              const pm = typeof fullPi.payment_method === "object" ? fullPi.payment_method : {};
              const card = pm.card_present || pm.card || charge?.payment_method_details?.card_present || charge?.payment_method_details?.card || {};

              const detailedNote = buildSyncroInvoiceNote({
                isTerminal: true,
                resolvedClientIp: charge?.client_ip || null,
                stripePaymentIntentId: paymentIntentId,
                chargeId: charge?.id || fullPi.latest_charge,
                cardInfo: {
                  brand: card.brand,
                  description: card.description || card.brand,
                  cardholder_name: card.cardholder_name || card.holder_name,
                  last4: card.last4,
                  funding: card.funding,
                  issuer: card.issuer || card.network,
                  country: card.country,
                  exp_month: card.exp_month,
                  exp_year: card.exp_year,
                },
                currency: fullPi.currency,
                amountCents: fullPi.amount,
                amountReceivedCents: fullPi.amount_received || fullPi.amount,
                cleanSigFileId: fileId,
                signatureUrl: fileId ? `${baseUrl}/signature/${pending.syncroInvoiceId}` : null,
                receiptUrl: `${baseUrl}/receipt/${pending.syncroInvoiceId}`,
              });

              await syncro.updateInvoice(pending.syncroInvoiceId, { note: detailedNote });
            } catch (noteErr) {
              console.warn(`⚠️ Could not update note on Invoice #${pending.syncroInvoiceId}:`, noteErr.message);
            }

            await clearTerminalReaderDisplay(pending.readerId || readerObj.id);
            invoiceCustomerCache.delete(String(pending.syncroInvoiceId));
          }
        }
      }
    }

    // 2. Terminal Card Authorized -> Prompt Reader Signature Screen
    if (event.type === "payment_intent.amount_capturable_updated" || event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      const metadata = pi.metadata || {};
      const readerId = metadata.stripe_reader_id;

      if (readerId) {
        const syncroInvoiceId = metadata.syncro_invoice_id ? String(metadata.syncro_invoice_id).trim() : null;
        const syncroCustomerId = metadata.syncro_customer_id ? String(metadata.syncro_customer_id).trim() : null;
        const amountString = (pi.amount / 100).toFixed(2);

        const isNewAuthorization = event.type === "payment_intent.amount_capturable_updated";
        const isAlreadyCaptured = pi.status === "succeeded" && pi.amount_capturable === 0;

        if (syncroInvoiceId && syncroCustomerId && isNewAuthorization && !isAlreadyCaptured) {
          pendingSyncroPayments.set(String(pi.id), {
            syncroInvoiceId,
            syncroCustomerId,
            amountString,
            paymentIntentId: pi.id,
            readerId,
          });

          // Prompt via official Stripe SDK
          try {
            await stripe.terminal.readers.collectInputs(readerId, {
              inputs: [
                {
                  type: "signature",
                  required: true,
                  custom_text: {
                    title: "Work Acceptance & Card Authorization",
                    description: `Sign to authorize payment for Invoice #${syncroInvoiceId}.`,
                    submit_button: "Accept & Sign",
                  },
                },
              ],
              metadata: {
                payment_intent_id: pi.id,
              },
            });
            console.log(`✍️ S700 Reader ${readerId} prompt active.`);
          } catch (sigErr) {
            console.error("❌ Failed to trigger S700 signature prompt:", sigErr.message);
          }
        }
      }
    }

    // 3. Online Stripe Checkout
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const metadata = session.metadata || {};
      const syncroInvoiceId = metadata.syncro_invoice_id ? String(metadata.syncro_invoice_id).trim() : null;
      const syncroCustomerId = metadata.syncro_customer_id ? String(metadata.syncro_customer_id).trim() : "0";

      if (syncroInvoiceId) {
        const amountString = (session.amount_total / 100).toFixed(2);
        const paymentIntentId = session.payment_intent ? String(session.payment_intent) : session.id;
        let clientIp = metadata.client_ip || session.customer_details?.ip_address || "";
        let fullPi = null;
        let charge = null;
        let card = {};
        let usBankAccount = {};
        let paymentType = "card";

        if (session.payment_intent && typeof session.payment_intent === "string") {
          try {
            fullPi = await stripe.paymentIntents.retrieve(session.payment_intent, {
              expand: ["latest_charge", "payment_method"],
            });
            if (fullPi.latest_charge && typeof fullPi.latest_charge === "object") {
              charge = fullPi.latest_charge;
              clientIp = charge.client_ip || clientIp;
            }
            const pm = typeof fullPi.payment_method === "object" ? fullPi.payment_method : {};
            card = pm.card || charge?.payment_method_details?.card || {};
            usBankAccount = pm.us_bank_account || charge?.payment_method_details?.us_bank_account || {};
            paymentType = pm.type || charge?.payment_method_details?.type || (usBankAccount.bank_name ? "us_bank_account" : "card");
          } catch (e) {
            console.warn("⚠️ Could not fetch PaymentIntent details for note:", e.message);
          }
        }

        const hostBase = process.env.RENDER_EXTERNAL_URL || `https://${req.get("host") || "syncro-stripe-s700-integration.onrender.com"}`;
        const baseUrl = hostBase.replace(/\/+$/, "");
        const isAch = paymentType === "us_bank_account" || Boolean(usBankAccount.bank_name);

        const detailedNote = buildSyncroInvoiceNote({
          isTerminal: false,
          resolvedClientIp: clientIp,
          stripePaymentIntentId: paymentIntentId,
          chargeId: charge?.id || fullPi?.latest_charge || "N/A",
          cardInfo: {
            brand: card.brand,
            description: card.description || card.brand,
            cardholder_name: card.cardholder_name || card.name || session.customer_details?.name,
            last4: card.last4,
            funding: card.funding,
            issuer: card.issuer || card.network,
            country: card.country,
            exp_month: card.exp_month,
            exp_year: card.exp_year,
          },
          usBankAccount: {
            bank_name: usBankAccount.bank_name,
            last4: usBankAccount.last4,
          },
          currency: session.currency || "usd",
          amountCents: session.amount_total,
          amountReceivedCents: fullPi?.amount_received || (isAch ? 0 : session.amount_total),
          receiptUrl: `${baseUrl}/receipt/${syncroInvoiceId}`,
        });

        if (isAch && session.payment_status !== "paid") {
          invoicePaymentStatus.set(syncroInvoiceId, {
            status: "pending_ach",
            stage: "ach_clearing",
            amount: amountString,
          });

          await syncro.updateInvoice(syncroInvoiceId, {
            note: `[ACH PENDING CLEARANCE - 3-5 BUSINESS DAYS]\n${detailedNote}`,
          });
        } else {
          const payRes = await recordSyncroPayment(
            syncroInvoiceId,
            syncroCustomerId,
            amountString,
            paymentIntentId,
            null,
            null,
            "Stripe Web",
            clientIp
          );

          invoicePaymentStatus.set(syncroInvoiceId, {
            status: "paid",
            amount: amountString,
            paymentId: payRes?.payment?.id || null,
            clientIp: clientIp || null,
          });

          invoiceCustomerCache.delete(syncroInvoiceId);
          await syncro.updateInvoice(syncroInvoiceId, { note: detailedNote });
        }
      }
    }

    // 4. Capture Confirmed -> Backup Invoice Creation
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      const metadata = pi.metadata || {};
      const syncroInvoiceId = metadata.syncro_invoice_id;
      const syncroCustomerId = metadata.syncro_customer_id;
      const isPendingTerminal = pendingSyncroPayments.has(String(pi.id));

      if (syncroInvoiceId && syncroCustomerId && pi.customer && !isPendingTerminal) {
        await createStripeInvoiceBackup(syncroInvoiceId, syncroCustomerId, pi.id, pi.customer);
      }
    }
  } catch (handlerErr) {
    console.error("❌ Uncaught Exception inside Webhook Handler:", handlerErr);
  }

  res.json({ received: true });
});

module.exports = router;
