// A fake Harness daemon on the far side of the cable: the scripted demo. Frames are cable frames (type + payload).
//
// It speaks what cli/src/cable/cableSession.ts speaks, message for message, so the bar shows the same screens it shows
// cabled to a real computer: a hello gets a welcome, the machine and the agents of one computer, in the mockup's apps
// (Harness, Orca, herdr and VS Code have agents); a tap, a voice turn, an answer, an app pick or New Harness gets the
// daemon's reply. A device that says appFilter is shown the shown app's agents, after `apps`; any other, every agent.
//
// Two demos. The person's (`story` false, --demo): everything rests and nothing moves by itself; what a person says to
// an agent starts its turn, and four agents play their case (a failure, a question only Orca answers, a permission, a
// question the bar answers) every other time. The story (`story` true, --story): agents work, ask and finish on their
// own, the app in front moving between them, in a loop for ever; a person takes it over while they use the bar, and it
// resumes after a quiet minute.
//
// Pure C11, no threads and no ESP-IDF. Its state is static. The one use of the heap is cJSON parsing a frame the device
// sent, freed before max_demo_receive returns, and bounded by the firmware's own JSON guard (cable_json_guard.h).
// Everything it sends is written into a fixed outbox and handed out by max_demo_tick.
//
// Not thread-safe: the host calls all four from one thread.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef void (*max_demo_emit_fn)(uint8_t type, const uint8_t *payload, size_t len, void *ctx);

// Start over: no device greeted, every agent at rest, the story (when `story`) at its beginning. `now_ms` is the host's
// monotonic clock; it may wrap.
void max_demo_reset(uint32_t now_ms, bool story);

// A frame the device sent (CABLE_TYPE_JSON or CABLE_TYPE_PCM). Replies wait for the next max_demo_tick.
void max_demo_receive(uint8_t type, const uint8_t *payload, size_t len, uint32_t now_ms);

// Advance the demo to `now_ms` and hand every frame now due to `emit`, in order, each a CABLE_TYPE_JSON payload of at
// most CABLE_MAX_PAYLOAD bytes. `emit` must not call back into this module.
void max_demo_tick(uint32_t now_ms, max_demo_emit_fn emit, void *ctx);

// When max_demo_tick next has something to do: `now_ms` when a reply is waiting, otherwise at most a second away.
uint32_t max_demo_next_ms(uint32_t now_ms);
