#include "pro_metrics.h"
#include "cJSON.h"

static const cJSON *field(const cJSON *p, const char *key)
{ return cJSON_GetObjectItemCaseSensitive(p, key); }
static bool same(const cJSON *v, const char *text)
{ return cJSON_IsString(v) && v->valuestring && !strcmp(v->valuestring, text); }
static bool shape(const cJSON *p, unsigned limit)
{
    if (!cJSON_IsObject(p)) return false;
    unsigned count = 0;
    for (const cJSON *a = p->child; a; a = a->next) {
        if (++count > limit || !a->string) return false;
        for (const cJSON *b = p->child; b != a; b = b->next)
            if (!strcmp(a->string, b->string)) return false;
    }
    return true;
}
static bool timestamp(const cJSON *v, uint64_t *out)
{
    if (!cJSON_IsNumber(v) || !(v->valuedouble >= 1 && v->valuedouble <= 9007199254740991.0)) return false;
    uint64_t value = (uint64_t)v->valuedouble;
    if ((double)value != v->valuedouble) return false;
    *out = value; return true;
}
static int choice(const cJSON *v, const char *const *names, int count)
{
    for (int i = 0; i < count; i++) if (same(v, names[i])) return i;
    return -1;
}
static bool day(const cJSON *v)
{
    if (!cJSON_IsString(v) || !v->valuestring || strlen(v->valuestring) != 10) return false;
    const char *s = v->valuestring;
    for (int i = 0; i < 10; i++) {
        if (i == 4 || i == 7) { if (s[i] != '-') return false; }
        else if (s[i] < '0' || s[i] > '9') return false;
    }
    unsigned year = (s[0]-'0')*1000 + (s[1]-'0')*100 + (s[2]-'0')*10 + s[3]-'0';
    unsigned month = (s[5]-'0')*10+s[6]-'0', date = (s[8]-'0')*10+s[9]-'0';
    static const unsigned days[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (!year || month < 1 || month > 12) return false;
    unsigned maximum = days[month-1] + (month == 2 && !(year%4) && (year%100 || !(year%400)));
    return date >= 1 && date <= maximum;
}
bool pro_metrics_decode(const cJSON *p, const char *machine, pro_metrics_usage_t *out)
{
    pro_metrics_usage_t u = {0};
    static const char *const coverages[] = {"complete", "partial", "unavailable"};
    static const char *const ids[] = {"claude", "codex", "opencode"};
    static const char *const states[] = {"disabled", "scanning", "ok", "partial", "unavailable", "failed"};
    const cJSON *name = field(p,"machineName"), *date = field(p,"day"), *stale = field(p,"stale");
    int coverage = choice(field(p,"coverage"), coverages, 3);
    if (!out || !machine || !machine[0] || strlen(machine) >= 48 || !shape(p,24) ||
        !same(field(p,"scope"),"local-transcripts") || !same(field(p,"machineId"),machine) ||
        !cJSON_IsString(name) || !name->valuestring || strlen(name->valuestring) >= sizeof u.machine_name ||
        !day(date) || !same(field(p,"currency"),"USD") || !same(field(p,"costKind"),"estimated") ||
        coverage < 0 || !cJSON_IsBool(stale) ||
        !timestamp(field(p,"windowStartMs"),&u.start) || !timestamp(field(p,"windowEndMs"),&u.end) ||
        !timestamp(field(p,"generatedAtMs"),&u.generated) || u.start > u.generated || u.generated >= u.end ||
        u.end-u.start < 23ull*3600000 || u.end-u.start > 25ull*3600000) return false;
    u.coverage = (uint8_t)coverage; u.stale = cJSON_IsTrue(stale);
    snprintf(u.machine_name,sizeof u.machine_name,"%s",name->valuestring);
    // A display label is never an identity. Keep escaped control characters
    // from making a machine name look like an extra reading or a new row.
    for (char *c=u.machine_name;*c;c++) if ((unsigned char)*c < 32 || *c == 127) *c=' ';
    snprintf(u.day,sizeof u.day,"%s",date->valuestring);
    const cJSON *providers = field(p,"providers");
    if (!cJSON_IsArray(providers)) return false;
    unsigned seen = 0, enabled = 0; bool all_priced = true;
    for (const cJSON *item=providers->child;item;item=item->next) {
        int id=choice(field(item,"id"),ids,3), state=choice(field(item,"state"),states,6);
        const cJSON *on=field(item,"enabled"), *priced=field(item,"priced"), *as_of=field(item,"asOfMs");
        if (!shape(item,8) || id < 0 || (seen & (1u<<id)) || state < 0 || !cJSON_IsBool(on) || !cJSON_IsBool(priced)) return false;
        seen |= 1u<<id;
        pro_metrics_provider_t *provider=&u.providers[id];
        provider->enabled=cJSON_IsTrue(on); provider->priced=cJSON_IsTrue(priced); provider->state=(uint8_t)state;
        provider->has_as_of=as_of!=NULL;
        if (as_of && (!timestamp(as_of,&provider->as_of) || provider->as_of > u.generated)) return false;
        if (!provider->enabled && (state!=PRO_SOURCE_DISABLED || provider->priced || as_of)) return false;
        if (provider->enabled && state==PRO_SOURCE_DISABLED) return false;
        bool readable=state==PRO_SOURCE_OK || state==PRO_SOURCE_PARTIAL || state==PRO_SOURCE_SCANNING;
        if (provider->priced && (!provider->enabled || !as_of || provider->as_of<u.start || !readable)) return false;
        if (provider->enabled) { enabled++; all_priced &= state==PRO_SOURCE_OK && provider->priced; }
    }
    if (seen != 7) return false;
    const cJSON *cost=field(p,"costUsd"), *as_of=field(p,"asOfMs");
    u.has_cost=cost!=NULL;
    if (cost) {
        if (!cJSON_IsNumber(cost) || !(cost->valuedouble>=0 && cost->valuedouble<=1e9) ||
            !timestamp(as_of,&u.as_of) || u.as_of<u.start || u.as_of>u.generated) return false;
        u.cost=cost->valuedouble;
    }
    if ((!cost && as_of) || ((coverage==PRO_METRICS_UNAVAILABLE)==u.has_cost) ||
        u.stale != (!cost || u.generated-u.as_of>300000)) return false;
    bool matching_scan=false;
    for (unsigned i=0;i<3;i++) {
        const pro_metrics_provider_t *provider=&u.providers[i];
        if (provider->enabled && provider->has_as_of && provider->as_of==u.as_of &&
            (provider->state==PRO_SOURCE_OK || provider->state==PRO_SOURCE_PARTIAL || provider->state==PRO_SOURCE_SCANNING)) matching_scan=true;
    }
    if (cost && (!enabled || !matching_scan)) return false;
    if (coverage==PRO_METRICS_COMPLETE && !all_priced) return false;
    *out=u; return true;
}
bool pro_metrics_reply(pro_metrics_t *m, const cJSON *p, uint32_t now)
{
    if (m->phase!=PRO_METRICS_WAIT || (int32_t)(now-m->deadline)>=0 || !shape(p,12) ||
        !same(field(p,"t"),"metrics.state") || !same(field(p,"requestId"),m->request)) return false;
    const cJSON *schema=field(p,"schema");
    if (!cJSON_IsNumber(schema) || schema->valuedouble!=1) return false;
    pro_metrics_usage_t usage;
    bool ok=cJSON_IsTrue(field(p,"ok")) && pro_metrics_decode(field(p,"usage"),m->machine,&usage);
    m->request[0]=0;
    if (!ok) { memset(&m->usage,0,sizeof m->usage); m->phase=PRO_METRICS_ERROR; return true; }
    m->usage=usage; m->received=now; m->age_minute=UINT32_MAX; m->phase=PRO_METRICS_READY;
    pro_metrics_tick(m,now); return true;
}
