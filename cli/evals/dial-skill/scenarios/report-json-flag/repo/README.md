# sales-cli

Prints the quarter's sales by region.

## Usage

```sh
node src/cli.js report                 # every region
node src/cli.js report --region North  # one region
```

## Layout

- `src/cli.js`: the command line.
- `src/report.js`: builds the report's rows and prints them as a table.
- `src/sales.js`: the quarter's orders.
- `vendor/tablekit/`: the table printer, vendored.

## Development

```sh
npm test
```
