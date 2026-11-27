---
name: date-time-handling
description: "Use when code stores, compares or displays dates and times: keeps instants in UTC, converts to a time zone only for display, uses the platform's time zone database, and tests daylight-saving transitions, leap days and month ends."
---

Store timestamps as UTC instants and calendar dates as plain dates; they are different things. Never do arithmetic on formatted strings. Inject the clock so tests can fix the time. Test the hour that repeats and the hour that is skipped when clocks change.
