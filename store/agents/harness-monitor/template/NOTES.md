# Harness Monitor

The session table works without sending a prompt. The assistant stays beside the table. Use the viewer’s zoom icon when you want a full-width table.

New monitors default to Space Bunny Free for both main and auxiliary requests, a free model whose
provider keeps no data and trains on none. Choose another model with `/models` if you prefer. A missing
free model is an error, not permission to switch to a paid model.

Cleanup is always explicit. Stopping retains history and launch settings; Open resumes through the
owning daemon. No automatic cleanup runs while you are away.
