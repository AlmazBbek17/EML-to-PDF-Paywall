-- db/schema.sql
-- Run once against a fresh Postgres database (see db/migrate.js for a
-- one-command way to apply this).

CREATE TABLE IF NOT EXISTS eml2pdf_credits (
  email       TEXT PRIMARY KEY,
  credits     INTEGER NOT NULL DEFAULT 0,
  lifetime    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eml2pdf_purchases (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  dodo_payment_id TEXT UNIQUE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eml2pdf_purchases_email ON eml2pdf_purchases (email);
