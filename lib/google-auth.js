// lib/google-auth.js
//
// Verifies the Google id_token the extension gets back from
// chrome.identity.launchWebAuthFlow (see extension/paywall.js for the
// client side). We only ever trust the email AFTER verifying the token's
// signature against Google's public keys -- never trust an email the
// extension just tells us directly, since that could be spoofed by
// anyone poking at the extension's messages.
//
// npm install google-auth-library

const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * @param {string} idToken - the id_token returned by Google's OAuth flow
 * @returns {Promise<{ email: string, emailVerified: boolean }>}
 * @throws if the token is invalid, expired, or issued for a different client
 */
async function verifyGoogleIdToken(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new Error('Google token payload missing email');
  }
  return { email: payload.email.toLowerCase(), emailVerified: !!payload.email_verified };
}

module.exports = { verifyGoogleIdToken };
