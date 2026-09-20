WITH category_totals AS (
  SELECT p.category,
    sum(CASE WHEN substr(t.sold_on,1,7)=substr(:baseline,1,7) THEN t.quantity*t.unit_price_cents-t.discount_cents-t.refund_cents ELSE 0 END) AS b,
    sum(CASE WHEN substr(t.sold_on,1,7)=substr(:comparison,1,7) THEN t.quantity*t.unit_price_cents-t.discount_cents-t.refund_cents ELSE 0 END) AS c
  FROM transactions t JOIN products p ON t.product_id=p.product_id
  WHERE t.status='completed' AND (:region='' OR t.region=:region)
    AND substr(t.sold_on,1,7) IN (substr(:baseline,1,7),substr(:comparison,1,7))
  GROUP BY p.category
)
SELECT category, b AS baseline_sales, c AS comparison_sales, c-b AS change
FROM category_totals ORDER BY change DESC, category;
