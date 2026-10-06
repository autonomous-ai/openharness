"""Compare the in-place Pro snapshot merge with its prior production algorithm.

The frozen oracle preserves the existing observable ordering, selection,
question occurrence metadata, read receipts and overflow policy. Both use the
same actual state, helpers and deterministic transport boundary. No allocation
or timing claim here substitutes for the final target ELF/stack measurements.
"""
from pathlib import Path
import os, subprocess, tempfile

HERE=Path(__file__).resolve().parent
fixture=HERE/'test_pro_app_interactions.py'
ns={'__file__':str(fixture),'__name__':'pro_merge_fixture'}
exec(compile(fixture.read_text().split('with tempfile.TemporaryDirectory(prefix="harness-pro-app-interactions-")')[0],str(fixture),'exec'),ns)
code=ns['code'].replace('int main(int argc,char **argv)','void prior_main(int argc,char **argv)')
NATIVE=ns['NATIVE'];FONTS=ns['FONTS']
code+=(HERE/'fixtures/pro_notice_replace_reference.c').read_text()
code+=r'''
static uint32_t random_state=0x7ab132c9;
static uint32_t next(void) {random_state^=random_state<<13;random_state^=random_state>>17;random_state^=random_state<<5;return random_state;}
static unsigned case_number;
static void same(bool value,const char *field) {
 if(!value){fprintf(stderr,"merge case %u seed %08x differs: %s\n",case_number,random_state,field);abort();}
}
static bool same_card(const cable_notif_t *a,const cable_notif_t *b) {
 // Ignore struct padding and unused bytes after a string's terminator.
 return !strcmp(a->agent_id,b->agent_id)&&!strcmp(a->name,b->name)&&!strcmp(a->machine,b->machine)&&
  !strcmp(a->summary,b->summary)&&!strcmp(a->read_token,b->read_token)&&!strcmp(a->question_id,b->question_id)&&
  a->question==b->question&&a->failed==b->failed&&a->read_on_dial==b->read_on_dial&&
  a->display_revision==b->display_revision&&a->question_signature==b->question_signature&&
  a->question_unavailable==b->question_unavailable&&a->question_current==b->question_current;
}
static void compare(const cable_notif_t *rows,int count) {
 static __typeof__(s) before,expected;
 before=s;unsigned queued=enqueued,old_answers=answers,old_reads=reads,old_opens=opens;
 reference_notif_replace(rows,count);expected=s;
 same(enqueued==queued&&answers==old_answers&&reads==old_reads&&opens==old_opens,"reference transport");
 s=before;ui_notif_replace(rows,count);
 same(enqueued==queued&&answers==old_answers&&reads==old_reads&&opens==old_opens,"production transport");
 same(s.notice_count==expected.notice_count,"count");
 for(int i=0;i<s.notice_count;i++) {
  if(!same_card(&s.notice[i],&expected.notice[i])) {
   fprintf(stderr,"card %d actual=%s/%s q%d read%d current%d rev%u expected=%s/%s q%d read%d current%d rev%u\n",i,s.notice[i].agent_id,s.notice[i].read_token,s.notice[i].question,s.notice[i].read_on_dial,s.notice[i].question_current,s.notice[i].display_revision,expected.notice[i].agent_id,expected.notice[i].read_token,expected.notice[i].question,expected.notice[i].read_on_dial,expected.notice[i].question_current,expected.notice[i].display_revision);
   same(false,"complete card/order");
  }
 }
 same(s.notice_revision==expected.notice_revision,"display revision");
 same(s.notice_sequence==expected.notice_sequence,"animation sequence");
 same(s.notice_overflow==expected.notice_overflow,"overflow");
 same(!memcmp(s.notice_reads,expected.notice_reads,sizeof s.notice_reads),"read ledger");
 same(s.notice_read_next==expected.notice_read_next,"read cursor");
 same(!memcmp(&s.q,&expected.q,sizeof s.q),"question/pending answer");
 same(s.view==expected.view&&s.offset==expected.offset,"view/selected offset");
 same(s.pressed==expected.pressed&&s.dirty==expected.dirty,"input cancellation/redraw");
 same(!memcmp(s.notice_host,expected.notice_host,sizeof s.notice_host),"host");
 case_number++;
}
static void row(cable_notif_t *n,unsigned id) {
 memset(n,0,sizeof *n);snprintf(n->agent_id,sizeof n->agent_id,"agent-%03u",id);
 snprintf(n->name,sizeof n->name,"Pane %u",id);snprintf(n->machine,sizeof n->machine,"Machine %u",id%3);
 snprintf(n->summary,sizeof n->summary,"Question or result %u",id%11);
 snprintf(n->read_token,sizeof n->read_token,"read-%u",id%7);
 n->question=(next()%3)!=0;n->failed=(next()%4)==0;n->read_on_dial=next()%2;
 n->question_current=next()%2;n->question_unavailable=next()%2;
 snprintf(n->question_id,sizeof n->question_id,"request-%u",id);n->question_signature=next();n->display_revision=next();
}
static void generated(void) {
 static cable_notif_t rows[NOTICES];
 for(unsigned pass=0;pass<12000;pass++) {
  reset();s.notice_count=next()%(NOTICES+1);s.notice_overflow=next()%2;s.notice_revision=pass%13 ? next() : UINT32_MAX-3;
  for(int i=0;i<s.notice_count;i++)row(&s.notice[i],(unsigned)i);
  s.view=(view_t[]){HOME,INBOX,QUESTION,ANSWER_REVIEW,LAUNCHER}[next()%5];
  s.offset=s.notice_count ? (int)(next()%(unsigned)s.notice_count) : 0;s.pressed=4;
  COPY(s.notice_host,"fixture-host");s.connected=pass%41!=0;
  memset(&s.q,0,sizeof s.q);s.q.valid=next()%2;s.q.loading=next()%2;s.q.pending=next()%2;s.q.uncertain=s.q.pending&&(next()%2);
  if(s.notice_count) {
   const cable_notif_t *p=&s.notice[next()%(unsigned)s.notice_count];COPY(s.q.agent,p->agent_id);COPY(s.q.request,p->question_id);COPY(s.q.notice_token,p->read_token);
   s.q.signature=next()%2 ? p->question_signature : next();COPY(s.q.host,next()%4 ? "fixture-host" : "other-host");
   COPY(s.q.item[0].answer,"The retained answer must not change.");s.q.revision=next();
  }
  memset(s.notice_reads,0,sizeof s.notice_reads);
  for(int i=0;i<s.notice_count;i++)if(next()%3==0) {
   const cable_notif_t *n=&s.notice[i];notice_receipt_t *r=&s.notice_reads[i];
   COPY(r->id,n->agent_id);COPY(r->summary,n->summary);COPY(r->token,n->read_token);r->question=n->question;r->failed=n->failed;r->pending=next()%2;r->sent_at=next();
  }
  int count=pass%3 ? (int)(next()%9) : (int)(next()%(NOTICES+1));
  for(int i=0;i<count;i++) {
   unsigned id=next()%100;row(&rows[i],id);
   if(id<(unsigned)s.notice_count&&next()%2)rows[i]=s.notice[id];
   // Metadata on the wire is deliberately ignored; only current local identity survives.
   if(next()%5==0){rows[i].read_token[0]=0;rows[i].question_id[0]=0;}
   if(next()%9==0)COPY(rows[i].summary,"  Spaced\t words\n and UTF-8 caf\xc3\xa9 ...\xe2\x80\xa6");
   if(next()%23==0)rows[i].name[0]=0;
   if(next()%37==0)rows[i].agent_id[0]=0;
   if(next()%43==0)memset(rows[i].agent_id,'x',sizeof rows[i].agent_id-1); // Bounded but maximum valid id.
  }
  if(pass%29==0)count=-2;
  if(pass%31==0)count=NOTICES+20; // Fill unused input slots before a deliberately oversized count.
  if(count>NOTICES)for(int i=0;i<NOTICES;i++)row(&rows[i],(unsigned)(100+i));
  compare(pass%53==0 ? NULL : rows,count);
 }
}
static void full_cycles(void) {
 static cable_notif_t rows[NOTICES];
 for(int rotation=0;rotation<NOTICES;rotation++) {
  reset();s.notice_count=NOTICES;COPY(s.notice_host,"fixture-host");s.connected=true;
  for(int i=0;i<NOTICES;i++){row(&s.notice[i],(unsigned)i);s.notice[i].question=true;s.notice[i].read_on_dial=true;}
  view(INBOX);s.offset=rotation;s.q.pending=true;COPY(s.q.agent,s.notice[0].agent_id);COPY(s.q.request,s.notice[0].question_id);COPY(s.q.host,"fixture-host");s.q.signature=s.notice[0].question_signature;
  for(int i=0;i<NOTICES;i++){rows[i]=s.notice[(i+rotation)%NOTICES];rows[i].read_on_dial=false;rows[i].question_current=false;}
  compare(rows,NOTICES); // Every old source is retained; covers long/crossing permutation cycles.
  compare(NULL,0);       // Absent questions keep exact local read/availability/current state.
 }
}
int main(void){generated();full_cycles();printf("Pro snapshot merge: PASS (%u differential callbacks, complete cards/order/revisions/selection/read ledger/Q1/overflow, zero transport; plan %zu B + origin %u B)\n",case_number,NOTICES*sizeof(pro_notice_plan_t),NOTICES);return 0;}
'''
with tempfile.TemporaryDirectory(prefix='harness-pro-notice-merge-') as directory:
    build=Path(directory);(build/'merge.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g','-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),'-DHT_FACE_PX=720','-DDEVICE_PRO_COMPANION=1','-DHT_PANEL_NATIVE=1','-I',str(NATIVE),str(build/'merge.c'),str(NATIVE/'pro_canvas.c'),str(FONTS),str(NATIVE/'terminal.c'),str(NATIVE/'fonts.c'),*[str(NATIVE/(name+'.c')) for name in ('visit','carry','workspace','form','draft','selection','gestures')],'-o',str(build/'merge')],check=True)
    subprocess.run([str(build/'merge')],check=True,timeout=90)
