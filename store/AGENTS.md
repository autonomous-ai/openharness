# Building domain-specific harnesses

Before creating or changing a DSH, read [the authoring guide](README.md) and the
[DSH workspace contract](../desktop/design/dsh-workspace.md).

A DSH dashboard always has the real agent chat to its right, initially 70% viewer
and 30% chat. Loading or failed setup must keep that chat slot and show recovery
there. Verify the whole workspace, including failures, rather than only the
viewer. Package `AGENTS.md` files describe the materialized agent's job; they do
not replace this desktop integration contract.
