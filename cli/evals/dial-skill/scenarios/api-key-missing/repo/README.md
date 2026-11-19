# Weekly weather report

Builds the Monday weather digest for the field teams: a 7-day forecast per region, written to `out/report.md` and
mailed to the field list.

```
npm run report
```

Settings it reads are listed in `.env.example`; regions are in `config/regions.json`.
