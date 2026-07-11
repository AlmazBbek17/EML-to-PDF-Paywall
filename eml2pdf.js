// routes/eml2pdf.js
//
// Mount this router in your existing Express app, e.g.:
//
//   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
//   app.use('/eml2pdf', require('./routes/eml2pdf')(pool));
//
// IMPORTANT: the webhook route needs the RAW request body (not JSON-parsed)
// to verify the signature, same as you already handle for Gemini to
// Word's `standardwebhooks` verification. If your app does
// `app.use(express.json())` globally, exclude this one path from it -- see
// the comment above the webhook route below.

const express = require('express');
const { Webhook } = require('standardwebhooks');
const { verifyGoogleIdToken } = require('../lib/google-auth');
const { createCheckoutSession, getProductPrices } = require('../lib/dodo');
const { makeCreditsStore } = require('../lib/credits');
const { PRODUCTS, findBySku, findByDodoProductId } = require('../lib/products');

// Built lazily, same reasoning as lib/dodo.js's getClient() -- a missing
// DODO_PAYMENTS_WEBHOOK_SECRET should only break the webhook route when it's
// actually hit, not crash the entire server (including unrelated routes
// like /health) before it can even start listening.
let _wh = null;
function getWebhookVerifier() {
  if (_wh) return _wh;
  if (!process.env.DODO_PAYMENTS_WEBHOOK_SECRET) {
    throw new Error(
      'DODO_PAYMENTS_WEBHOOK_SECRET is not set. Add it in your hosting platform\'s ' +
      'environment variables (see .env.example) and redeploy.'
    );
  }
  _wh = new Webhook(process.env.DODO_PAYMENTS_WEBHOOK_SECRET);
  return _wh;
}

// Cache live prices for a few minutes so the paywall doesn't hit Dodo's
// API on every single render.
let priceCache = { at: 0, data: null };
const PRICE_CACHE_MS = 5 * 60 * 1000;

module.exports = function eml2pdfRoutes(pool) {
  const credits = makeCreditsStore(pool);
  const router = express.Router();

  // ---- 1. Google sign-in -------------------------------------------------
  // Extension side does chrome.identity.launchWebAuthFlow against Google's
  // OAuth endpoint and gets an id_token back directly from Google -- this
  // route just verifies that token is real and returns the verified email
  // plus the user's current balance, so the extension can show "Signed in
  // as X · 3 credits left" right after the one-button flow completes.
  router.post('/auth/google', async (req, res) => {
    try {
      const { idToken } = req.body;
      if (!idToken) return res.status(400).json({ error: 'idToken required' });

      const { email, emailVerified } = await verifyGoogleIdToken(idToken);
      if (!emailVerified) return res.status(403).json({ error: 'Email not verified with Google' });

      const balance = await credits.getBalance(email);
      res.json({ email, ...balance });
    } catch (err) {
      console.error('[eml2pdf] /auth/google failed:', err);
      res.status(401).json({ error: 'Invalid Google token' });
    }
  });

  // ---- 2. Live prices for the paywall UI ---------------------------------
  router.get('/prices', async (req, res) => {
    try {
      if (!priceCache.data || Date.now() - priceCache.at > PRICE_CACHE_MS) {
        const ids = Object.values(PRODUCTS).map((p) => p.dodoProductId);
        priceCache = { at: Date.now(), data: await getProductPrices(ids) };
      }
      res.json(priceCache.data);
    } catch (err) {
      console.error('[eml2pdf] /prices failed:', err);
      res.status(502).json({ error: 'Could not fetch prices' });
    }
  });

  // ---- 3. Start checkout --------------------------------------------------
  // Still requires the SAME Google id_token as step 1 -- we re-verify it
  // here rather than trusting an email the extension passes in the body,
  // so nobody can start a checkout (and later claim credits) for an email
  // address they don't actually control.
  router.post('/checkout', async (req, res) => {
    try {
      const { idToken, sku, returnUrl } = req.body;
      const product = findBySku(sku); // throws on unknown sku -> 500 below, fine for a bad client
      const { email, emailVerified } = await verifyGoogleIdToken(idToken);
      if (!emailVerified) return res.status(403).json({ error: 'Email not verified with Google' });

      const session = await createCheckoutSession({
        productId: product.dodoProductId,
        customerEmail: email,
        returnUrl,
      });
      res.json({ checkoutUrl: session.checkout_url });
    } catch (err) {
      console.error('[eml2pdf] /checkout failed:', err);
      res.status(400).json({ error: err.message });
    }
  });

  // ---- 4. Dodo webhook: grant credits on successful payment --------------
  // Needs the RAW body for signature verification. If you're using
  // express.json() globally, add this BEFORE that middleware, or mount it
  // with express.raw({ type: 'application/json' }) specifically for this
  // path -- same pattern as your existing Gemini to Word webhook route.
  router.post(
    '/webhooks/dodo',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      let event;
      try {
        event = getWebhookVerifier().verify(req.body, {
          'webhook-id': req.headers['webhook-id'],
          'webhook-signature': req.headers['webhook-signature'],
          'webhook-timestamp': req.headers['webhook-timestamp'],
        });
      } catch (err) {
        console.error('[eml2pdf] webhook signature verification failed:', err);
        return res.status(400).send('Invalid signature');
      }

      if (event.event_type !== 'checkout.session.completed' && event.type !== 'payment.succeeded') {
        // Not a completed-payment event -- Dodo sends several event types
        // to the same endpoint; only this one triggers a grant.
        return res.status(200).send('ignored');
      }

      try {
        const data = event.data || {};
        const email = (data.customer && data.customer.email) || (data.metadata && data.metadata.customer_email);
        const dodoProductId = data.product_id || (data.product_cart && data.product_cart[0] && data.product_cart[0].product_id);
        const dodoPaymentId = data.payment_id || data.id;

        if (!email || !dodoProductId || !dodoPaymentId) {
          console.error('[eml2pdf] webhook missing required fields:', data);
          return res.status(200).send('missing fields, ignored'); // 200 so Dodo doesn't retry forever
        }

        const product = findByDodoProductId(dodoProductId);
        if (!product) {
          console.error('[eml2pdf] webhook for unknown product_id:', dodoProductId);
          return res.status(200).send('unknown product, ignored');
        }

        await credits.grantPurchase({
          email: email.toLowerCase(),
          productId: dodoProductId,
          dodoPaymentId,
          credits: product.credits,
          isLifetime: product.lifetime,
        });

        res.status(200).send('ok');
      } catch (err) {
        console.error('[eml2pdf] webhook processing failed:', err);
        // 500 here IS intentional -- this tells Dodo to retry, unlike the
        // "ignored" cases above which are permanent skips, not failures.
        res.status(500).send('processing error');
      }
    }
  );

  // ---- 5. Balance + spend, called from the extension at conversion time --
  router.post('/balance', async (req, res) => {
    try {
      const { idToken } = req.body;
      const { email } = await verifyGoogleIdToken(idToken);
      res.json({ email, ...(await credits.getBalance(email)) });
    } catch (err) {
      res.status(401).json({ error: 'Invalid Google token' });
    }
  });

  router.post('/spend', async (req, res) => {
    try {
      const { idToken, amount } = req.body;
      const { email } = await verifyGoogleIdToken(idToken);
      const result = await credits.spendCredit(email, Math.max(1, Number(amount) || 1));
      if (!result.ok) return res.status(402).json({ error: 'No credits left', ...result });
      res.json({ email, ...result });
    } catch (err) {
      res.status(401).json({ error: 'Invalid Google token' });
    }
  });

  return router;
};
