WITH joined AS (
 SELECT s.* FROM shipments s JOIN routes r ON s.route_id=r.route_id WHERE :region='' OR r.region=:region
)
SELECT count(*) AS shipments,
 count(CASE WHEN delivered_on<=:as_of THEN 1 END) AS delivered,
 count(CASE WHEN delivered_on IS NULL OR delivered_on>:as_of THEN 1 END) AS open,
 count(CASE WHEN delivered_on<=:as_of AND delivered_on<=promised_on THEN 1 END)*1.0
 /nullif(count(CASE WHEN delivered_on<=:as_of THEN 1 END),0) AS on_time_rate
FROM joined;
