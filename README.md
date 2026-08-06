# Syncro-Stripe-S700-Integration

This will allow a Stripe reader to interface with SyncroMSP for easy acceptance of chip and tap cards in person.

The app and extension assume you will be running the app on Render, as I did. The extension will require your Render URL and a
secret code you will create for security.

Of course, look at the .env for required secret terminal and API keys.

The app works perfectly on my systems, so if you have trouble, let me know.

EDIT: latest version is basically just a separation of the various functions to keep the main app.js small.
I was close to 1000 lines and it was getting out of control.  I did add a small stop in the flow to give five seconds
to see line items being billed before the tap or payment. I want to add a continue, but the S700 does not support buttons
natively. Also on the road map is another button to email a link to clients that would allow ACH functionality through
Stripe.
