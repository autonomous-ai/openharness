SELECT substr(sold_on,1,7) AS month,
  sum(quantity*unit_price_cents-discount_cents-refund_cents) AS net_sales,
  count(*) AS completed_lines
FROM transactions
WHERE status='completed' AND (:region='' OR region=:region)
GROUP BY substr(sold_on,1,7) ORDER BY month;
