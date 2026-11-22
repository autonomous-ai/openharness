# ISSUE-12: Export to CSV

Sales wants the address book in a spreadsheet.

## Ask

- `contacts export --format csv` writes the contacts as CSV to stdout, one row per contact: name, email, city.
- The tests cover it.

## Open

Both are Jonas's (sales ops) to settle, and both are easy to change later.

- **Delimiter**: comma, the CSV default, or semicolon, which Excel expects in the German and French offices.
  Not decided yet.
- **Header row**: a first row of column names, or none, as the old CRM import wanted. Not decided yet.
