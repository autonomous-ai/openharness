---
name: websocket-connections
description: "Use when building features on long-lived WebSocket connections: reconnects with backoff and jitter, resumes from the last acknowledged message, sends heartbeats to detect dead peers, bounds the outgoing queue per connection, and closes with codes the other side can act on."
---

Treat every connection as one that will drop. Number messages so a reconnect can resume without gaps or duplicates. Ping on an interval and close a peer that stops answering. Cap the send buffer and shed or close a slow consumer rather than letting memory grow. Test reconnects under packet loss.
