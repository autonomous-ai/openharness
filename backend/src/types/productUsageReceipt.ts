/** Shared by the write path (lib/productUsage.ts) and the one-time receipt cleanup (scripts/product-usage/): no imports,
 * so the script loads without the server's environment. */

/** How many UTC days, today included, a signed-in report is accepted for. Its receipt, which only stops a retry counting
 * twice, is kept one day longer ([PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS]): a report accepted in the window's last moment
 * commits a moment later, and Mongo's expiry runs about once a minute. 36 days held about 4M receipts (2026-10-29). */
export const PRODUCT_USAGE_RECEIPT_DAYS = 3
export const PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS = PRODUCT_USAGE_RECEIPT_DAYS + 1
