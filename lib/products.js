// lib/products.js
//
// Two paid products: a 24-hour unlimited pass and a lifetime unlock.
// dodoProductId is pulled straight from each Dodo Payment Link (live mode).
// The pdt_... segment IS the product_id -- that's what shows up in the
// webhook payload too, so matching against it is how we know a given
// payment was for which product.

const PRODUCTS = {
  day_pass: {
    dodoProductId: 'pdt_0NlQiqYVnGIGj6z8hfJru',
    credits: 0,
    lifetime: false,
    dayPassHours: 24,
  },
  lifetime: {
    dodoProductId: 'pdt_0NlQij1pzJxOnXknItjob',
    credits: 0,
    lifetime: true,
    dayPassHours: 0,
  },
};

function findByDodoProductId(dodoProductId) {
  const entry = Object.entries(PRODUCTS).find(([, p]) => p.dodoProductId === dodoProductId);
  if (!entry) return null;
  const [sku, product] = entry;
  return { sku, ...product };
}

module.exports = { PRODUCTS, findByDodoProductId };
