WITH signed_lines AS (
 SELECT CASE WHEN substr(sold_on,1,7)=substr(:comparison,1,7) THEN 1 ELSE -1 END
   * (quantity*unit_price_cents-discount_cents-refund_cents) AS delta, product_id
 FROM transactions
 WHERE status='completed' AND (:region='' OR region=:region)
   AND substr(sold_on,1,7) IN (substr(:baseline,1,7),substr(:comparison,1,7))
), by_category AS (
 SELECT p.category,sum(s.delta) AS delta FROM signed_lines s JOIN products p ON p.product_id=s.product_id GROUP BY p.category
)
SELECT CASE WHEN coalesce((SELECT sum(delta) FROM signed_lines),0)
 =coalesce((SELECT sum(delta) FROM by_category),0) THEN 0 ELSE 1 END AS violations;
