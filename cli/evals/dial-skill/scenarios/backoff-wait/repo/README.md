# uptime-check

Checks that each URL it is given answers. The on-call cron runs it every minute and pages when it exits 1.

```
uptime-check https://status.shop.invalid/health https://api.shop.invalid/health
npm test
```

Each URL gets one GET, with a 5 s timeout. A network error or a 5xx status counts as down; any other status as up (a
404 is the site answering). It prints one line per URL, `UP 200 <url>` or `DOWN 503 <url>`, and exits 1 when any URL
is down.
