// ================================================================
      // 3. ONLINE CHECKOUT SESSION (Card Auth vs ACH Handling)
      // ================================================================
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const metadata = session.metadata || {};

        const syncroInvoiceId = metadata.syncro_invoice_id ? String(metadata.syncro_invoice_id).trim() : null;
        const syncroCustomerId = metadata.syncro_customer_id ? String(metadata.syncro_customer_id).trim() : "0";

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
            
            // Explicitly detect payment method type
            paymentType = pm.type || charge?.payment_method_details?.type || (usBankAccount.bank_name ? "us_bank_account" : "card");
          } catch (e) {
            console.warn("⚠️ Could not fetch PaymentIntent details for note:", e.message);
          }
        }

        if (syncroInvoiceId) {
          const baseUrl = `https://${req.get("host") || "syncro-stripe-s700-integration.onrender.com"}`;
          const receiptUrl = `${baseUrl}/receipt/${syncroInvoiceId}`;

          const isAch = paymentType === "us_bank_account" || !!usBankAccount.bank_name;

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
            cleanSigFileId: null,
            signatureUrl: null,
            receiptUrl: receiptUrl,
          });

          // ⚡ Check TRUE ACH condition
          if (isAch && session.payment_status !== "paid") {
            console.log(`⏳ True ACH payment processing for Invoice #${syncroInvoiceId}.`);

            invoicePaymentStatus.set(syncroInvoiceId, {
              status: "pending_ach",
              stage: "ach_clearing",
              amount: amountString,
            });

            try {
              await syncro.updateInvoice(syncroInvoiceId, {
                note: `[ACH PENDING CLEARANCE - 3-5 BUSINESS DAYS]\n${detailedNote}`,
              });
            } catch (noteErr) {
              console.warn("⚠️ Could not post ACH pending note:", noteErr.message);
            }
          } else {
            // Credit Card (authorized with manual capture, or paid instantly)
            try {
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

              // Update the invoice note with the full card breakdown
              await syncro.updateInvoice(syncroInvoiceId, {
                note: detailedNote,
              });

              console.log(
                `✅ Recorded credit card payment ($${amountString}) & note for Syncro Invoice #${syncroInvoiceId}`
              );
            } catch (syncroErr) {
              console.error(
                `❌ Failed to record online payment for Syncro Invoice #${syncroInvoiceId}:`,
                syncroErr.message
              );
            }
          }
        }
      }
