# Changelog

## Unreleased

- `drain()` resolves once every pending job has finished, not only the running ones.
- A job that throws no longer stops the queue; `add()` returns its rejected promise.

## 2.3.1 - 2026-09-14

- `size` is 0 after `clear()`.

## 2.3.0 - 2026-08-02

- `concurrency` option.
