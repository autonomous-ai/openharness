# logstat

Counts the lines of a log file by level.

```sh
logstat app.log
logstat --csv app.log
logstat --errors-only --csv app.log
```

## Flags

- `--csv`: print the counts as CSV instead of a table.
- `--errors-only`: count only `ERROR` lines.
- `--no-header`: leave out the header line of the table or CSV.
- `--help`: print the usage.

## Development

```sh
npm test
```
