#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct cJSON cJSON;
enum { PRO_METRICS_EMPTY, PRO_METRICS_WAIT, PRO_METRICS_READY, PRO_METRICS_ERROR, PRO_METRICS_EXPIRED };
enum { PRO_METRICS_COMPLETE, PRO_METRICS_PARTIAL, PRO_METRICS_UNAVAILABLE };
enum { PRO_SOURCE_DISABLED, PRO_SOURCE_SCANNING, PRO_SOURCE_OK, PRO_SOURCE_PARTIAL, PRO_SOURCE_UNAVAILABLE, PRO_SOURCE_FAILED };
typedef struct {
    uint8_t state;
    bool enabled, priced, has_as_of;
    uint64_t as_of;
} pro_metrics_provider_t;
typedef struct {
    char machine_name[40], day[11];
    uint64_t start, end, generated, as_of;
    double cost;
    bool has_cost, stale;
    uint8_t coverage;
    pro_metrics_provider_t providers[3]; // Claude, Codex, OpenCode; canonical order.
} pro_metrics_usage_t;
typedef struct {
    char machine[48], request[48];
    bool supported;
    uint8_t phase;
    uint32_t serial, deadline, received, age_minute;
    pro_metrics_usage_t usage;
} pro_metrics_t;

static inline void pro_metrics_close(pro_metrics_t *m)
{
    m->phase = PRO_METRICS_EMPTY; m->request[0] = 0;
    memset(&m->usage, 0, sizeof m->usage);
}
static inline void pro_metrics_source(pro_metrics_t *m, const char *machine, bool supported)
{
    bool valid = supported && machine && machine[0] && strlen(machine) < sizeof m->machine;
    if (m->supported != valid || strcmp(m->machine, valid ? machine : "")) pro_metrics_close(m);
    m->supported = valid;
    snprintf(m->machine, sizeof m->machine, "%s", valid ? machine : "");
}
static inline bool pro_metrics_begin(pro_metrics_t *m, uint32_t now, uint32_t hi, uint32_t lo)
{
    if (!m->supported || !m->machine[0] || m->phase == PRO_METRICS_WAIT) return false;
    pro_metrics_close(m);
    if (!++m->serial) ++m->serial;
    snprintf(m->request, sizeof m->request, "metrics-%08lx%08lx-%08lx",
             (unsigned long)hi, (unsigned long)lo, (unsigned long)m->serial);
    m->phase = PRO_METRICS_WAIT; m->deadline = now + 20000;
    return true;
}
// The host bounds projection age to 20 seconds. Without a wall clock on the
// device, use that conservative allowance plus elapsed monotonic time.
static inline uint64_t pro_metrics_elapsed(const pro_metrics_t *m, uint32_t now)
{ return (uint32_t)(now - m->received) + 20000ull; }
static inline uint64_t pro_metrics_age(const pro_metrics_t *m, uint32_t now)
{ return m->usage.generated - m->usage.as_of + pro_metrics_elapsed(m, now); }
static inline bool pro_metrics_expired(const pro_metrics_t *m, uint32_t now)
{ return m->usage.generated + pro_metrics_elapsed(m, now) >= m->usage.end; }
static inline bool pro_metrics_tick(pro_metrics_t *m, uint32_t now)
{
    if (m->phase == PRO_METRICS_WAIT && (int32_t)(now - m->deadline) >= 0) {
        m->phase = PRO_METRICS_ERROR; m->request[0] = 0; return true;
    }
    if (m->phase != PRO_METRICS_READY) return false;
    if (pro_metrics_expired(m, now)) {
        m->phase = PRO_METRICS_EXPIRED; m->usage.has_cost = false; return true;
    }
    uint32_t minute = m->usage.has_cost ? (uint32_t)(pro_metrics_age(m, now) / 60000) : 0;
    if (m->age_minute == minute) return false;
    m->age_minute = minute; return true;
}
// No allocation, retained JSON pointers, raw errors, paths or transcript text.
bool pro_metrics_decode(const cJSON *usage, const char *machine, pro_metrics_usage_t *out);
bool pro_metrics_reply(pro_metrics_t *m, const cJSON *payload, uint32_t now);
