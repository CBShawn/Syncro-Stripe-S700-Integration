# Syncro-Stripe-S700-Integration

This will allow a Stripe reader to interface with SyncroMSP for easy acceptance of chip and tap cards in person.

The app and extension assume you will be running the app on Render, as I did. The extension will require your Render URL and a
secret code you will create for security.

Of course, look at the .env for required secret terminal and API keys.

The app works perfectly on my systems, so if you have trouble, let me know.

Update 8/19/26: The app now has an email function for emailing the actual Stripe link (Multiple Processors) vs Syncro (Credit Card Only). It adds the email into the Syncro invoice email area and shows when sent and when opened. You need to edit the PDF email template and remove the default Syncro CC variable and add the variable {{custom_invoice_message}} which I use for the link.

I also added a 80MM print function, that takes the signature from the S700 and adds it t the bottom of the generated invoice receipt.

There is no way to save the S700 signature into the Syncro signature fields that I have found. So I save the S700 at the location that is listed in ref_num in the payment information. That is saved at Stripe.

If you need help, let me know.
