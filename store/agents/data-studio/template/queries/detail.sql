SELECT t._record AS transactions_record, p._record AS products_record,
  t.line_id, t.sold_on, p.product, p.category, t.region, t.quantity,
  t.quantity*t.unit_price_cents-t.discount_cents-t.refund_cents AS net_sales
FROM transactions t JOIN products p ON t.product_id=p.product_id
WHERE t.status='completed' AND (:region='' OR t.region=:region)
  AND (:category='' OR p.category=:category)
  AND substr(t.sold_on,1,7) IN (substr(:baseline,1,7),substr(:comparison,1,7))
ORDER BY t.sold_on,t.line_id;
