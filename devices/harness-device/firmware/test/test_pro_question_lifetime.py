"""Replay Pro question attention through real notice callbacks and ESP-IDF cJSON.

Reuses the app fixture's real dispatch/state/renderer extraction. All notification
lifetime functions are production source, with deterministic USB/clock only.
Optional HABITAT_QUESTION_TRANSCRIPT is exact Desktop/CLI native-app traffic.
"""
from pathlib import Path
import os,re,subprocess,tempfile

HERE=Path(__file__).resolve().parent
fixture=HERE/'test_pro_app_interactions.py'
ns={'__file__':str(fixture),'__name__':'pro_question_fixture'}
exec(compile(fixture.read_text().split('with tempfile.TemporaryDirectory(prefix="harness-pro-app-interactions-")')[0],str(fixture),'exec'),ns)
code=ns['code'];function=ns['function'];NATIVE=ns['NATIVE'];FONTS=ns['FONTS']
JSON_DIR=Path(os.environ['IDF_PATH'])/'components/json/cJSON'
# SDK cJSON accepts the fixture's small stack objects and real parsed host frames.
a=code.index('typedef struct cJSON');b=code.index('static cJSON object(',a)
code=code[:a]+'''#include "cJSON.h"
enum { JSTRING=cJSON_String,JTRUE=cJSON_True,JARRAY=cJSON_Array,JOBJECT=cJSON_Object,JNUMBER=cJSON_Number };
'''+code[b:]
code=code.replace('int main(int argc,char **argv)','void prior_main(int argc,char **argv)')
# Fixture-owned stack strings are never freed or modified by cJSON.
code=re.sub(r'(?<=\.valuestring=)(id|token|agent|fetch)(?=[,}])',r'(char *)\1',code)
code=code.replace('.valuestring=note?note:""','.valuestring=(char *)(note?note:"")')
code+='static bool display_is_asleep(void) { return false; }\n'
for name in ('habitat_scene_receipt','habitat_scene_presented','ui_draft_source'):
    code+=function(name)
cable=(NATIVE/'../../cable_client.c').resolve().read_text()
for name in ('str_of','bool_of','handle_notifications'):
    code+=function(name,cable)
code+=r'''
static void receive(const cJSON *frame) {
 const char *t=str_of(frame,"t"),*agent=str_of(frame,"agentId");assert(t);
 if(!strcmp(t,"question"))ui_question_show(agent,str_of(frame,"name"),str_of(frame,"machine"),str_of(frame,"id"),cJSON_GetObjectItemCaseSensitive(frame,"questions"));
 else if(!strcmp(t,"question.close"))ui_question_close(agent,str_of(frame,"id"));
 else if(!strcmp(t,"notif.replace"))handle_notifications(frame);
 else if(!strcmp(t,"notif.seen")) {const char *token=str_of(frame,"readToken");if(token)ui_notif_read(agent,token);}
 else if(!strcmp(t,"question.state"))ui_question_state(frame);
}
static void frame(const char *json) {cJSON *p=cJSON_Parse(json);assert(p);receive(p);cJSON_Delete(p);}
static void pushed(const char *agent,const char *id,const char *last) {
 char json[1400];snprintf(json,sizeof json,"{\"t\":\"question\",\"agentId\":\"%s\",\"name\":\"Research\",\"id\":\"%s\",\"questions\":[{\"key\":\"scope\",\"q\":\"Which scope should we use?\",\"options\":[\"This file only\",\"%s\"],\"canText\":true}]}",agent,id,last);frame(json);
}
static void snapshot(const char *agent,const char *token,bool question) {
 char json[800];snprintf(json,sizeof json,"{\"t\":\"notif.replace\",\"items\":[{\"agentId\":\"%s\",\"name\":\"Research\",\"summary\":\"Which scope should we use?\",\"question\":%s,\"readToken\":\"%s\"}]}",agent,question?"true":"false",token);frame(json);
}
static cable_notif_t *notice(const char *agent) {
 for(int i=0;i<s.notice_count;i++)if(!strcmp(s.notice[i].agent_id,agent))return &s.notice[i];return NULL;
}
static void empty_snapshot(void) {frame("{\"t\":\"notif.replace\",\"items\":[]}");}
static void start(void) {reset();s.notice_count=0;view(HOME);ui_draft_source("fixture-host");}
static void presented(void) {ht_scene_t scene;render(&scene);habitat_scene_presented(habitat_scene_receipt());}
static void inspect(const char *dir,const char *name) {ht_scene_t scene;render(&scene);portrait(&scene,dir,name);}
static void read_failure(void) {
 cJSON *p=cJSON_CreateObject();cJSON_AddStringToObject(p,"agentId",s.q.agent);cJSON_AddStringToObject(p,"requestId",s.q.fetch);cJSON_AddBoolToObject(p,"ok",false);cJSON_AddStringToObject(p,"error","No readable question. Check the terminal.");ui_question_state(p);cJSON_Delete(p);
}
static void projected_state(bool can_text) {
 char json[1800];snprintf(json,sizeof json,"{\"t\":\"question.state\",\"agentId\":\"%s\",\"requestId\":\"%s\",\"id\":\"Q1\",\"token\":\"token-1\",\"ok\":true,\"questions\":[{\"key\":\"scope\",\"q\":\"Which scope should we use?\",\"options\":[\"This file only\",\"The whole project\"],\"canText\":%s}]}",s.q.agent,s.q.fetch,can_text?"true":"false");frame(json);
}
static void lifetime(const char *dir) {
 for(int destination=0;destination<3;destination++)for(int replace_first=0;replace_first<2;replace_first++) {
  start();pushed("remote","Q1","The whole project");snapshot("remote","read-1",true);assert(!strcmp(notice("remote")->question_id,"Q1"));
  view(INBOX);presented();assert(notice("remote")->read_on_dial);unsigned before=enqueued;
  if(destination==1){act(A_QUESTION,0);question_state_reply(true,false,"Q1","token-1");assert(s.q.valid);}
  else if(destination==2){notice_add("result","Build","","A result",false,false);s.offset=1;}
  else view(HOME);
  if(replace_first)empty_snapshot();ui_notif_read("remote","read-1");if(!replace_first)empty_snapshot();
  assert(waiting()==1&&notice("remote")&&notice("remote")->read_on_dial&&!answers&&!opens);
  assert(enqueued==before+(destination==1?1:0));
  if(destination==0){inspect(dir,"question-after-later");act(A_INBOX,1);inspect(dir,"read-question-retained");}
  if(destination==1){assert(s.q.valid);inspect(dir,"answer-after-read-ack");}
  ui_question_close("remote","wrong");assert(waiting()==1);
  ui_question_close("remote","Q1");assert(!waiting()&&!notice("remote"));
 }
 // New occurrence tokens never inherit a known older question identity.
 start();pushed("remote","Q1","The whole project");snapshot("remote","read-1",true);view(INBOX);presented();
 snapshot("remote","read-2",true);assert(!notice("remote")->question_id[0]&&!notice("remote")->read_on_dial);
 ui_question_close("remote","Q1");ui_notif_read("remote","read-1");assert(waiting()==1&&!notice("remote")->read_on_dial);
 pushed("remote","Q2","The whole project");assert(!strcmp(notice("remote")->question_id,"Q2"));
 ui_question_close("remote","Q1");assert(waiting()==1);ui_question_close("remote","Q2");assert(!waiting());
 // Same full question replay is quiet and preserves a current answer draft.
 start();pushed("remote","Q1","The whole project");snapshot("remote","read-1",true);view(INBOX);presented();act(A_QUESTION,0);question_state_reply(true,false,"Q1","token-1");
 COPY(s.q.item[0].draft,"draft-one");COPY(s.q.item[0].answer,"Only this file.");s.offset=2;uint32_t sequence=s.notice_sequence,revision=s.q.revision;
 pushed("remote","Q1","The whole project");assert(s.notice_sequence==sequence&&s.q.revision==revision&&s.q.valid&&s.offset==2&&!strcmp(s.q.item[0].draft,"draft-one")&&notice("remote")->read_on_dial&&!strcmp(notice("remote")->read_token,"read-1"));
 pushed("remote","Q1","A different option");assert(!s.q.valid&&s.q.revision!=revision&&!notice("remote")->read_on_dial);
 // A new unread occurrence revokes an unsent down-captured Answer action.
 start();pushed("remote","Q1","The whole project");snapshot("remote","read-1",true);view(INBOX);act(A_QUESTION,0);projected_state(true);s.q.item[0].selected=1;view(ANSWER_REVIEW);
 action_t old_answer=make_action(hit(A_ANSWER,0));unsigned old_queue=enqueued;snapshot("remote","read-2",true);assert(!s.q.valid&&!s.q.pending);dispatch(old_answer);assert(enqueued==old_queue&&!s.q.pending);
 // Host question.read maps canText to current speech eligibility. That is not
 // a new question and cannot invalidate an unsent or pending choice answer.
 for(int pending=0;pending<2;pending++) {
  start();pushed("remote","Q1","The whole project");snapshot("remote","read-1",true);view(INBOX);presented();act(A_QUESTION,0);projected_state(false);
  assert(s.q.valid&&s.q.supported&&!s.q.item[0].can_text);COPY(s.q.item[0].answer,"This file only");s.q.item[0].selected=1;
  if(pending){view(ANSWER_REVIEW);act(A_ANSWER,0);assert(s.q.pending);}
  sequence=s.notice_sequence;revision=s.q.revision;unsigned queued=enqueued;
  pushed("remote","Q1","The whole project");assert(s.notice_sequence==sequence&&s.q.revision==revision&&s.q.valid&&s.q.pending==(bool)pending&&notice("remote")->read_on_dial&&enqueued==queued);
  if(!pending){pushed("remote","Q1","A different option");assert(!s.q.valid&&s.q.revision!=revision);}
 }
 // Q2 may replace its card but never the saved Q1 answer awaiting a receipt.
 for(int settle=0;settle<3;settle++) {
  start();pushed("remote","Q1","The whole project");snapshot("remote","read-1",true);view(INBOX);act(A_QUESTION,0);projected_state(true);
  s.q.item[0].selected=1;COPY(s.q.item[0].answer,"This file only");view(ANSWER_REVIEW);act(A_ANSWER,0);assert(s.q.pending);
  char fetch[48];COPY(fetch,s.q.fetch);revision=s.q.revision;unsigned queued=enqueued;
  if(settle!=2){ui_set_connected(false);ui_set_connected(true);ui_draft_source("fixture-host");revision=s.q.revision;}
  pushed("remote","Q2","A different option");empty_snapshot();
  assert(s.q.pending&&s.q.revision==revision&&!strcmp(s.q.request,"Q1")&&!strcmp(s.q.item[0].answer,"This file only")&&notice("remote")&&!strcmp(notice("remote")->question_id,"Q2")&&enqueued==queued);
  view(HOME);act(A_INBOX,1);assert(s.view==QUESTION);inspect(dir,settle==2?"old-answer-new-question":"unknown-answer-new-question");
  if(settle==0)act(A_QUESTION_CLOSE,0);
  else if(settle==1)receipt_frame("remote",fetch,"token-1",true,false);
  else ui_question_close("remote","Q1");
  assert(!s.q.pending&&notice("remote")&&!strcmp(notice("remote")->question_id,"Q2")&&waiting()==1&&!answers&&!opens);
 }
 // A different host cannot settle an old unknown answer with coincident IDs.
 start();pushed("remote","Q1","The whole project");view(INBOX);act(A_QUESTION,0);projected_state(true);s.q.item[0].selected=1;view(ANSWER_REVIEW);act(A_ANSWER,0);
 char old_fetch[48];COPY(old_fetch,s.q.fetch);ui_draft_source("other-host");assert(s.q.pending&&s.q.uncertain&&!s.q.valid);
 pushed("remote","Q1","The whole project");receipt_frame("remote",old_fetch,"token-1",true,false);ui_question_close("remote","Q1");assert(s.q.pending&&s.q.uncertain&&!notice("remote"));
 act(A_QUESTION_CLOSE,0);assert(!s.q.pending);
 // An ok host response can still exceed local answer bounds. Keep desktop Open.
 start();pushed("remote","Q1","The whole project");view(INBOX);act(A_QUESTION,0);question_state_reply(false,false,"Q1","token-1");
 assert(!s.q.supported&&notice("remote")->question_unavailable&&!waiting());view(INBOX);ht_scene_t bounded;render(&bounded);assert(!controls(A_QUESTION)&&controls(A_NOTICE));
 // Failed current reads retain context through the desktop, not a zombie Answer.
 start();pushed("remote","Q1","The whole project");snapshot("remote","read-1",true);view(INBOX);act(A_QUESTION,0);read_failure();
 view(HOME);assert(!waiting());inspect(dir,"question-unavailable-home");view(INBOX);inspect(dir,"question-unavailable-card");assert(!controls(A_QUESTION)&&controls(A_NOTICE));
 pushed("remote","Q2","The whole project");assert(waiting()==1&&!notice("remote")->question_unavailable);
 // An old fetch/failure cannot block Q2 after its notification occurrence changes.
 view(INBOX);act(A_QUESTION,0);snapshot("remote","read-2",true);read_failure();assert(!notice("remote")->question_unavailable);
 view(INBOX);act(A_QUESTION,0);snapshot("remote","read-3",true);read_failure();assert(!notice("remote")->question_unavailable);
 pushed("remote","Q2","The whole project");assert(waiting()==1);
 // Link loss retains same-host attention, never submission authority or wrong-host cards.
 ui_set_connected(false);assert(waiting()==1&&!s.q.valid);ui_set_connected(true);ui_draft_source("fixture-host");empty_snapshot();assert(waiting()==1);
 pushed("remote","Q2","The whole project");ui_draft_source("other-host");assert(!waiting()&&!notice("remote"));
 pushed("remote","Q1","The whole project");ui_draft_source(NULL);assert(!waiting());
 // Roster absence is not a question resolution. Unknown oversized request IDs stay desktop-only.
 start();pushed("remote","Q1","The whole project");s.count=0;empty_snapshot();assert(waiting()==1);
 char long_id[82];memset(long_id,'q',81);long_id[81]=0;pushed("remote",long_id,"The whole project");assert(!waiting()&&notice("remote")->question_unavailable&&!notice("remote")->question_id[0]);
 // Normal result receipts keep their existing disappearance semantics.
 start();snapshot("remote","result-1",false);view(HOME);ui_notif_read("remote","result-1");assert(!s.notice_count);
 start();snapshot("remote","result-1",false);view(INBOX);presented();ui_notif_read("remote","result-1");empty_snapshot();assert(s.notice_count==1);view(HOME);empty_snapshot();assert(!s.notice_count);
 puts("Pro question lifetime: PASS (real read ACK and empty snapshots in both orders; Home/Answer/other card; exact close, new tokens, content change, quiet replay, failed reads, host identity, old result behavior)");
}
static void capacity(const char *dir) {
 for(int count=25;count<=64;count+=39) {
  start();char agent[48],id[80];
  for(int i=0;i<count;i++){snprintf(agent,sizeof agent,"pending-%02d",i);snprintf(id,sizeof id,"request-%02d",i);pushed(agent,id,"The whole project");}
  assert(waiting()==count&&s.notice_count==count);view(INBOX);s.offset=0;bool seen[64]={0};
  for(int i=0;i<count;i++) {
   ht_scene_t scene;render(&scene);assert(controls(A_QUESTION));int index=-1;assert(sscanf(s.notice[s.offset].agent_id,"pending-%d",&index)==1&&index>=0&&index<count&&!seen[index]);seen[index]=true;
   action_t answer=make_action(s.hits[0]);for(int j=0;j<s.hit_count;j++)if(s.hits[j].enabled&&s.hits[j].action==A_QUESTION)answer=make_action(s.hits[j]);
   COPY(agent,s.notice[s.offset].agent_id);dispatch(answer);assert(s.q.loading&&!strcmp(s.q.agent,agent)); // Exact off-roster card route.
   COPY(agent,s.q.agent);view(INBOX);s.offset=i;if(i+1<count)act(A_DOWN,count);
  }
  for(int i=0;i<count;i++)assert(seen[i]);
  if(count==64){s.offset=0;inspect(dir,"pending-catalog-64");}
  for(int i=0;i<16;i++){snprintf(agent,sizeof agent,"result-%02d",i);notice_add(agent,"Result","","Finished",false,false);assert(waiting()==count);}
  empty_snapshot();assert(waiting()==count&&s.notice_count==count);
 }
 // A full pending catalog + unread rows reserves the result currently read.
 start();char agent[48],id[80];for(int i=0;i<64;i++){snprintf(agent,sizeof agent,"p-%02d",i);snprintf(id,sizeof id,"q-%02d",i);pushed(agent,id,"The whole project");}
 snapshot("reading","read-result",false);view(INBOX);s.offset=(int)(notice("reading")-s.notice);presented();
 cable_notif_t rows[8]={0};for(int i=0;i<8;i++){snprintf(rows[i].agent_id,sizeof rows[i].agent_id,"new-result-%d",i);COPY(rows[i].read_token,"unread");COPY(rows[i].summary,"Finished");}
 ui_notif_replace(rows,8);assert(waiting()==64&&notice("reading")&&!strcmp(s.notice[s.offset].agent_id,"reading")&&s.notice_count==72);
 pushed("p-new","q-new","The whole project");assert(waiting()==65&&notice("reading")&&s.notice_count==72);
 notice_add("overflow-result","Result","","Finished",false,false);assert(waiting()==65&&notice("reading")&&s.notice_count==72);
 empty_snapshot();assert(waiting()==65&&notice("reading")&&!strcmp(s.notice[s.offset].agent_id,"reading"));
 // Cumulative turnover is a display limit, not a fabricated close receipt.
 start();pushed("pending-old","old-request","The whole project");view(INBOX);act(A_QUESTION,0);question_state_reply(true,false,"old-request","old-token");
 s.q.item[0].selected=1;COPY(s.q.item[0].answer,"Keep the old answer");view(ANSWER_REVIEW);act(A_ANSWER,0);assert(s.q.pending);char saved_answer[sizeof s.q.item[0].answer];COPY(saved_answer,s.q.item[0].answer);ui_set_connected(false);ui_set_connected(true);ui_draft_source("fixture-host");
 pushed("reading-card","reading-request","The whole project");view(INBOX);s.offset=(int)(notice("reading-card")-s.notice);
 unsigned queued=enqueued;for(int i=0;i<150;i++){snprintf(agent,sizeof agent,"turnover-%03d",i);snprintf(id,sizeof id,"turnover-request-%03d",i);pushed(agent,id,"The whole project");}
 assert(s.notice_count==72&&s.notice_overflow&&notice("turnover-149")&&notice("reading-card")&&notice("pending-old")&&s.q.pending&&!strcmp(s.q.item[0].answer,saved_answer)&&enqueued==queued&&!answers&&!opens);
 assert(!strcmp(s.notice[s.offset].agent_id,"reading-card"));inspect(dir,"question-overflow");
 pushed("pending-old","new-request","A different option");assert(s.q.pending&&!strcmp(s.q.request,"old-request"));
 for(int i=150;i<230;i++){snprintf(agent,sizeof agent,"turnover-%03d",i);snprintf(id,sizeof id,"turnover-request-%03d",i);pushed(agent,id,"The whole project");}
 assert(!notice("pending-old")&&s.q.pending&&notice("turnover-229")&&notice("reading-card")); // Q2 isn't pinned just by Q1's agent.
 view(HOME);act(A_INBOX,1);assert(s.view==QUESTION);act(A_QUESTION_CLOSE,0);assert(!s.q.pending&&s.notice_count==72);
 while(s.notice_count){COPY(agent,s.notice[0].agent_id);COPY(id,s.notice[0].question_id);ui_question_close(agent,id);}
 act(A_INBOX,0);assert(s.view==INBOX&&s.notice_overflow);ht_scene_t overflow;render(&overflow);assert(!text_has(&overflow,"All caught up")&&!controls(A_DESKTOP)&&controls(A_HOME));inspect(dir,"question-overflow-empty");
 ui_draft_source("other-host");assert(!s.notice_overflow); // Host boundary clears only the local overflow hint.
 // An open unsent review also retains its exact notice while newer cards arrive.
 start();pushed("reviewed","reviewed-request","The whole project");view(INBOX);act(A_QUESTION,0);question_state_reply(true,false,"reviewed-request","reviewed-token");
 for(int i=0;i<80;i++){snprintf(agent,sizeof agent,"new-%03d",i);snprintf(id,sizeof id,"new-request-%03d",i);pushed(agent,id,"The whole project");}
 assert(s.q.valid&&notice("reviewed")&&notice("new-079")&&s.notice_count==72&&s.notice_overflow);
 printf("Question capacity: PASS (25/64 exact card routes, all pending retained across results/empty snapshots, selected result reserved); Pro notice=%zu bytes, receipt=%zu bytes, arrays=%zu bytes\n",sizeof(cable_notif_t),sizeof(notice_receipt_t),sizeof s.notice+sizeof s.notice_reads+NOTICES*sizeof(cable_notif_t));
}
static void transcript(const char *path) {
 if(!path||!*path)return;FILE *f=fopen(path,"rb");assert(f);fseek(f,0,SEEK_END);long n=ftell(f);rewind(f);assert(n>0&&n<1000000);char *bytes=calloc((size_t)n+1,1);assert(bytes&&fread(bytes,1,(size_t)n,f)==(size_t)n);fclose(f);
 cJSON *root=cJSON_Parse(bytes);free(bytes);assert(root);const cJSON *events=cJSON_GetObjectItemCaseSensitive(root,"events"),*e;assert(cJSON_IsArray(events));start();unsigned frames=0,checks=0;
 cJSON_ArrayForEach(e,events) {
  const char *direction=str_of(e,"direction");const cJSON *p=cJSON_GetObjectItemCaseSensitive(e,"frame");
  if(direction&&p) {
   if(!strcmp(direction,"host-to-device")){receive(p);frames++;}
   else if(!strcmp(str_of(p,"t")?str_of(p,"t"):"","notif.read")) {
    const char *id=str_of(p,"agentId"),*token=str_of(p,"readToken");cable_notif_t *n=notice(id);assert(n&&!strcmp(n->read_token,token));view(INBOX);s.offset=(int)(n-s.notice);presented();assert(n->read_on_dial);
   }
  } else if(!strcmp(str_of(e,"event")?str_of(e,"event"):"","checkpoint")) {
   const char *name=str_of(e,"name"),*id=str_of(e,"agentId");
   if(!strcmp(name,"later-before-read-ack")){view(HOME);assert(waiting()==1);}
   else if(!strcmp(name,"read-ack-released")){assert(waiting()==1&&notice(id)&&notice(id)->read_on_dial);}
   else if(!strcmp(name,"stale-close-rejected")){assert(waiting()==1&&notice(id));}
   // Producer records question-opened before the queued cable question frame.
   else if(!strcmp(name,"question-opened")){assert(id&&str_of(e,"requestId"));}
   else if(!strcmp(name,"question-closed")){assert(!notice(id)&&!waiting());}
   checks++;
  }
 }
 assert(frames>5&&checks>=7&&!answers&&!opens);cJSON_Delete(root);printf("Native app transcript: PASS (%u exact host frames, %u checkpoints, no answer input)\n",frames,checks);
}
int main(int argc,char **argv){lifetime(argc>1?argv[1]:NULL);capacity(argc>1?argv[1]:NULL);transcript(argc>2?argv[2]:NULL);return 0;}
'''
with tempfile.TemporaryDirectory(prefix='harness-pro-question-lifetime-') as directory:
    build=Path(directory);(build/'lifetime.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g','-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),'-DHT_FACE_PX=720','-DDEVICE_PRO_COMPANION=1','-DHT_PANEL_NATIVE=1','-I',str(NATIVE),'-I',str(JSON_DIR),str(build/'lifetime.c'),str(JSON_DIR/'cJSON.c'),str(NATIVE/'pro_canvas.c'),str(FONTS),str(NATIVE/'terminal.c'),str(NATIVE/'fonts.c'),*[str(NATIVE/(name+'.c')) for name in ('visit','carry','workspace','form','draft','selection','gestures')],'-o',str(build/'lifetime')],check=True)
    preview=os.environ.get('HABITAT_PRO_PREVIEW_DIR','');Path(preview).mkdir(exist_ok=True) if preview else None
    subprocess.run([str(build/'lifetime'),preview,os.environ.get('HABITAT_QUESTION_TRANSCRIPT','')],check=True)
