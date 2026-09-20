WITH eligible AS (
  SELECT t.*, quantity * unit_price_cents - discount_cents - refund_cents AS net
  FROM transactions t JOIN products p ON t.product_id = p.product_id
  WHERE status = 'completed' AND (:region = '' OR region = :region)
    AND substr(sold_on, 1, 7) IN (substr(:baseline,1,7), substr(:comparison,1,7))
), totals AS (
  SELECT coalesce(sum(CASE WHEN substr(sold_on,1,7) = substr(:baseline,1,7) THEN net ELSE 0 END),0) AS b,
         coalesce(sum(CASE WHEN substr(sold_on,1,7) = substr(:comparison,1,7) THEN net ELSE 0 END),0) AS c,
         count(*) AS n FROM eligible
)
SELECT b AS baseline_sales, c AS comparison_sales, c-b AS change,
       (c-b)*1.0/nullif(abs(b),0) AS growth, n AS completed_lines FROM totals;
