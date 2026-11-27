# contacts

An address book on the command line. Contacts live in `data/contacts.json`.

```
contacts find <text>
contacts export [--format json]
npm test
```

`export` writes every contact to stdout; `json`, the only format so far, is the default.
