// services/cron.js
const cron = require("node-cron");
const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function initCronJobs() {
  // Runs every day at 11:00 PM Eastern Time (America/New_York)
  cron.schedule(
    "0 23 * * *",
    async () => {
      console.log("⏰ [CRON] 11:00 PM Nightly sweep: Checking for manual-capture Stripe payments...");

      try {
        const list = await stripe.paymentIntents.list({
          limit: 100,
        });

        // Strict filter: only capture intents explicitly set to manual that are pending capture
        const uncaptured = list.data.filter(
          (pi) => pi.status === "requires_capture" && pi.capture_method === "manual"
        );

        if (uncaptured.length === 0) {
          console.log("⏰ [CRON] No manual-capture payments requiring capture found.");
          return;
        }

        console.log(`⏰ [CRON] Found ${uncaptured.length} manual-capture payment(s) to capture.`);

        for (const pi of uncaptured) {
          try {
            const captured = await stripe.paymentIntents.capture(pi.id);
            const amountFormatted = (captured.amount / 100).toFixed(2);
            console.log(`✅ [CRON] Successfully captured PaymentIntent ${pi.id} ($${amountFormatted})`);
          } catch (capErr) {
            console.error(`❌ [CRON] Failed to capture PaymentIntent ${pi.id}:`, capErr.message);
          }
        }

        console.log("⏰ [CRON] Nightly capture sweep complete.");
      } catch (err) {
        console.error("❌ [CRON] Error during nightly capture job:", err.message);
      }
    },
    {
      timezone: "America/New_York",
    }
  );

  console.log("⏱️ Nightly 11:00 PM auto-capture cron job initialized (America/New_York).");
}

module.exports = { initCronJobs };
