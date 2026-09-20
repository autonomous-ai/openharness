SELECT r.route, count(*) AS shipments,
 count(CASE WHEN s.delivered_on<=:as_of THEN 1 END) AS delivered,
 count(CASE WHEN s.delivered_on IS NULL OR s.delivered_on>:as_of THEN 1 END) AS open,
 count(CASE WHEN s.delivered_on<=:as_of AND s.delivered_on<=s.promised_on THEN 1 END)*1.0
 /nullif(count(CASE WHEN s.delivered_on<=:as_of THEN 1 END),0) AS on_time_rate
FROM shipments s JOIN routes r ON s.route_id=r.route_id
WHERE :region='' OR r.region=:region
GROUP BY r.route ORDER BY on_time_rate DESC, r.route;
