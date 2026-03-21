CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS orders (
  order_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'CANCELLED')),
  total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id UUID NOT NULL,
  consumer_group TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, consumer_group)
);

CREATE TABLE IF NOT EXISTS order_status_view (
  order_id UUID PRIMARY KEY,
  current_status TEXT NOT NULL,
  last_event_id UUID NOT NULL,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_created ON outbox_events (aggregate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_published_at ON outbox_events (published_at);
CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at ON processed_events (processed_at);
