WITH route_counts AS (
 SELECT r.route,count(*) AS n FROM shipments s JOIN routes r ON s.route_id=r.route_id
 WHERE s.delivered_on<=:as_of AND (:region='' OR r.region=:region) GROUP BY r.route
)
SELECT CASE WHEN coalesce((SELECT sum(n) FROM route_counts),0)=(
 SELECT count(*) FROM shipments s WHERE s.delivered_on<=:as_of AND (:region='' OR s.route_id IN (SELECT route_id FROM routes WHERE region=:region))
) THEN 0 ELSE 1 END AS violations;
