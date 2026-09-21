SELECT count(*) AS violations FROM transactions
WHERE quantity<0 OR unit_price_cents<0 OR discount_cents<0 OR refund_cents<0
  OR discount_cents+refund_cents>quantity*unit_price_cents
  OR status NOT IN ('completed','cancelled');
