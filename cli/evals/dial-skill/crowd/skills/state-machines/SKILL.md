---
name: state-machines
description: "Use when an object moves through statuses such as an order, a payment or a deployment: models the states and allowed transitions explicitly, rejects transitions that are not allowed, records each transition with its time and cause, and tests every edge of the graph."
---

List the states and draw the transitions before writing code. Put the transition table in one place and route every status change through it. Store the history of transitions rather than only the current state. Write a test per allowed transition and one that shows a forbidden one is refused.
