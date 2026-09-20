SELECT CASE WHEN substr(:baseline,9,2)='01' AND substr(:comparison,9,2)='01'
  AND :baseline<>:comparison THEN 0 ELSE 1 END AS violations;
