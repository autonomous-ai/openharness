#pragma once
#include "pro_player.h"
#include "cJSON.h"
#include <string.h>
#include <stdio.h>
#include <math.h>

static inline bool player_integer(const cJSON *p,const char *key,double min,double max,double *value)
{
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(p,key);
    if(!cJSON_IsNumber(v) || !isfinite(v->valuedouble) || v->valuedouble<min || v->valuedouble>max ||
       v->valuedouble!=floor(v->valuedouble)) return false;
    *value=v->valuedouble; return true;
}
static inline bool player_string(const cJSON *p,const char *key,char *dst,size_t cap)
{
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(p,key);
    if(!cJSON_IsString(v) || strlen(v->valuestring)>=cap) return false;
    snprintf(dst,cap,"%s",v->valuestring); return true;
}
static inline bool pro_player_library_parse(const cJSON *p,pro_player_library_t *out)
{
    pro_player_library_t page={0}; double n;
    if(!player_integer(p,"request",0,UINT32_MAX,&n)) return false;
    page.request=(uint32_t)n;
    if(!player_integer(p,"offset",0,1000000,&n)) return false;
    page.offset=(int)n;
    if(!player_integer(p,"total",0,1000000,&n)) return false;
    page.total=(int)n;
    if(!player_integer(p,"machines",0,1000000,&n)) return false;
    page.machines=(int)n;
    if(page.offset>(page.total>6 ? page.total-6 : 0)) return false;
    const cJSON *rows=cJSON_GetObjectItemCaseSensitive(p,"rows");
    if(!cJSON_IsArray(rows) || cJSON_GetArraySize(rows)>PRO_PLAYER_ROWS) return false;
    const cJSON *r;
    cJSON_ArrayForEach(r,rows) {
        pro_player_row_t *row=&page.rows[page.count]; char status[16];
        if(!player_string(r,"id",row->id,sizeof row->id) || !row->id[0] ||
           !player_string(r,"machineId",row->machine_id,sizeof row->machine_id) || !row->machine_id[0] ||
           !player_string(r,"name",row->name,sizeof row->name) ||
           !player_string(r,"engine",row->engine,sizeof row->engine) ||
           !player_string(r,"status",status,sizeof status) ||
           !player_integer(r,"ageSeconds",-1,315360000,&n)) return false;
        row->age_seconds=(int32_t)n;
        static const char *states[]={"idle","working","question","finished","failed","paused","offline"};
        bool known=false;
        for(unsigned i=0;i<sizeof states/sizeof states[0];i++)
            if(!strcmp(status,states[i])) { row->status=(pro_player_status_t)i; known=true; break; }
        if(!known) return false;
        for(int i=0;i<page.count;i++) if(!strcmp(page.rows[i].id,row->id)) return false;
        page.count++;
    }
    if(page.count!=(page.total-page.offset<6 ? page.total-page.offset : 6)) return false;
    *out=page; return true;
}
