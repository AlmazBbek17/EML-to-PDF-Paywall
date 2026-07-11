// routes/eml2pdf.js
//
// Deliberately minimal version: one product (lifetime unlock via a static
// Dodo Payment Link), no Google OAuth, no custom checkout session
// creation. The extension sends the browser straight to the Payment Link
// URL; this server's only job is to (a) receive the webhook when someone
// pays and mark that email as lifetime, and (b) let the extension ask
// "is this email unlocked?" so it can restore access after payment.
//
// TRADEOFF, on purpose: /balance takes a plain email with no proof of
// ownership. Anyone who knows (or guesses) an email that has paid could
// type it in and get unlocked too. For a $5 one-time consumer tool this
// is an accepted tradeoff for simplicity -- there's no password/account
// system to abuse, and the worst case is someone free-rides on a stranger
// they'd have to already know paid. If that ever becomes a real problem,
// swap this for the Google-verified version instead (same DB, same
// grantPurchase logic -- just re-add id_token verification here).

const express = require('express');
const { Webhook } = require('standardwebhooks');
const { makeCreditsStore } = require('../lib/credits');
const { findByDodoProductId } = require('../lib/products');

let _wh = null;
function getWebhookVerifier() {
  if (_wh) return _wh;
  if (!process.env.DODO_PAYMENTS_WEBHOOK_SECRET) {
    throw new Error(
      'DODO_PAYMENTS_WEBHOOK_SECRET is not set. Add it in your hosting platform\'s ' +
      'environment variables and redeploy.'
    );
  }
  _wh = new Webhook(process.env.DODO_PAYMENTS_WEBHOOK_SECRET);
  return _wh;
}

module.exports = function eml2pdfRoutes(pool) {
  const credits = makeCreditsStore(pool);
  const router = express.Router();

  // ---- Check / restore lifetime status --------------------------------
  router.post('/balance', async (req, res) => {
    try {
      const email = (req.body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email required' });
      }
      const balance = await credits.getBalance(email);
      res.json({ email, ...balance });
    } catch (err) {
      console.error('[eml2pdf] /balance failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- Dodo webhook: grant lifetime on successful payment --------------
  // Needs the RAW body for signature verification -- mounted before any
  // global express.json() in server.js.
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
        return res.status(200).send('ignored');
      }

      try {
        const data = event.data || {};
        const email = (data.customer && data.customer.email) || (data.metadata && data.metadata.customer_email);
        const dodoProductId = data.product_id || (data.product_cart && data.product_cart[0] && data.product_cart[0].product_id);
        const dodoPaymentId = data.payment_id || data.id;

        if (!email || !dodoProductId || !dodoPaymentId) {
          console.error('[eml2pdf] webhook missing required fields:', data);
          return res.status(200).send('missing fields, ignored');
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
        res.status(500).send('processing error'); // 500 -> Dodo retries
      }
    }
  );

  return router;
};
