SELECT s._record AS shipments_record,r._record AS routes_record,s.shipment_id,r.route,s.promised_on,s.delivered_on,
 CASE WHEN s.delivered_on IS NULL OR s.delivered_on>:as_of THEN 'Open'
 WHEN s.delivered_on<=s.promised_on THEN 'On time' ELSE 'Late' END AS outcome,s.packages
FROM shipments s JOIN routes r ON s.route_id=r.route_id
WHERE (:region='' OR r.region=:region) AND (:route='' OR r.route=:route)
ORDER BY s.promised_on,s.shipment_id;
