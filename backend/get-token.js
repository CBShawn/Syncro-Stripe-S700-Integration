// get-token.js
const axios = require('axios');

const TENANT_ID = '5f5900bb-52f2-4650-91d3-b2981fc95d6f';
const CLIENT_ID = '6e91e35b-9034-46c3-80c1-cc29c3f66bad';

async function getRefreshToken() {
  try {
    const deviceCodeRes = await axios.post(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/devicecode`,
      new URLSearchParams({
        client_id: CLIENT_ID,
        scope: 'https://outlook.office.com/SMTP.Send offline_access',
      })
    );

    const { user_code, device_code, verification_uri, interval } = deviceCodeRes.data;

    console.log('\n======================================================');
    console.log(`1. Open: ${verification_uri}`);
    console.log(`2. Enter Code: ${user_code}`);
    console.log('======================================================\n');
    console.log('Waiting for authentication in browser...');

    const pollInterval = (interval || 5) * 1000;
    
    const checkToken = setInterval(async () => {
      try {
        const tokenRes = await axios.post(
          `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
          new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: CLIENT_ID,
            device_code: device_code,
          })
        );

        clearInterval(checkToken);
        console.log('\n🎉 SUCCESS! Your Refresh Token:\n');
        console.log(tokenRes.data.refresh_token);
        console.log('\nCopy the string above into Render as O365_REFRESH_TOKEN\n');
      } catch (err) {
        if (err.response?.data?.error === 'authorization_pending') {
          process.stdout.write('.');
        } else {
          clearInterval(checkToken);
          console.error('\n❌ Token Error:', err.response?.data || err.message);
        }
      }
    }, pollInterval);

  } catch (err) {
    console.error('❌ Device Code Error:', err.response?.data || err.message);
  }
}

getRefreshToken();
