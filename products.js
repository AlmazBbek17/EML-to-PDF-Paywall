// lib/products.js
//
// Single source of truth mapping your Dodo product IDs to what they grant.
// Fill in the real product_id values after creating the products in the
// Dodo dashboard (Products page -> View Details -> product_id).
//
// Prices themselves are NOT hardcoded here on purpose -- routes.js fetches
// live prices from Dodo for display, so changing a price in the dashboard
// shows up in the extension without a new release. This file only needs
// to know what a purchase of each product grants once paid for.

const PRODUCTS = {
  pack20: {
    dodoProductId: 'REPLACE_WITH_DODO_PRODUCT_ID_PACK20', // $1.49 / 20 files
    credits: 20,
    lifetime: false,
  },
  pack120: {
    dodoProductId: 'REPLACE_WITH_DODO_PRODUCT_ID_PACK120', // $7.00 / 120 files
    credits: 120,
    lifetime: false,
  },
  lifetime: {
    dodoProductId: 'REPLACE_WITH_DODO_PRODUCT_ID_LIFETIME', // $50.00 / unlimited forever
    credits: 0,
    lifetime: true,
  },
};

function findBySku(sku) {
  const product = PRODUCTS[sku];
  if (!product) throw new Error(`Unknown product sku: ${sku}`);
  return product;
}

function findByDodoProductId(dodoProductId) {
  const entry = Object.entries(PRODUCTS).find(([, p]) => p.dodoProductId === dodoProductId);
  if (!entry) return null;
  const [sku, product] = entry;
  return { sku, ...product };
}

module.exports = { PRODUCTS, findBySku, findByDodoProductId };
