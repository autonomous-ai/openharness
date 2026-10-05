#include "../main/ui/habitat/pro_contacts.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static pro_contacts_t state;
static unsigned passes, begins, cancels, ends, commits;
static int selected;
static pro_contact_result_t sample(unsigned n, uint32_t t, int dx, int dy, bool reverse)
{
    pro_contact_t p[5]={{(uint16_t)(350+dx),(uint16_t)(220+dy),2},
                        {(uint16_t)(500+dx),(uint16_t)(320+dy),7}, {90,90,3}, {100,100,4}, {110,110,5}};
    if(reverse) { pro_contact_t a=p[0];p[0]=p[1];p[1]=a; }
    pro_contact_result_t r=pro_contacts_sample(&state,p,n,t);
    passes+=r.event==PRO_CONTACT_PASS;begins+=r.event==PRO_CONTACT_BEGIN;
    cancels+=r.event==PRO_CONTACT_CANCEL;ends+=r.event==PRO_CONTACT_END;
    if(r.event==PRO_CONTACT_END&&r.step){commits++;selected=r.step;}
    return r;
}
static void reset(void) {memset(&state,0,sizeof state);passes=begins=cancels=ends=commits=0;selected=0;}
static void sweep(uint32_t t,int sign)
{
    sample(2,t,0,0,false);sample(2,t+40,sign*50,4,true);
    sample(2,t+80,sign*110,8,false);sample(0,t+100,sign*110,8,false);
}
int main(void)
{
    reset();sample(1,100,0,0,false);sample(1,500,150,200,false);sample(0,600,150,200,false);
    assert(passes==3&&!begins&&!cancels&&!ends);
    for(int sign=-1;sign<=1;sign+=2){reset();sweep(100,sign);assert(commits==1&&selected==-sign&&!passes&&begins==1);}
    reset();sample(1,80,0,0,false);sweep(100,-1);assert(passes==1&&commits==1&&selected==1);
    reset();sample(1,0,0,0,false);sweep(181,-1);assert(cancels==1&&!commits&&passes==1);
    reset();sample(1,0,0,0,false);sample(1,20,30,0,false);sample(1,40,0,0,false);sweep(60,-1);
    assert(cancels==1&&!commits&&passes==3); // Return-to-origin is still a moved scroll.
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);sample(2,80,-110,0,false);
    sample(1,100,-110,0,false);sample(1,180,-110,0,false);sample(0,200,-110,0,false);
    assert(commits==1&&!passes&&ends==1);
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);sample(2,80,-110,0,false);
    sample(1,100,-110,0,false);sample(1,180,-110,0,true);sample(0,200,-110,0,false);
    assert(!commits&&cancels==1); // Remaining track identity cannot change.
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);sample(2,80,-110,0,false);
    sample(1,100,-110,0,false);sample(1,200,-110,0,false);sample(1,281,-110,0,false);sample(0,300,0,0,false);
    assert(!commits&&cancels==1);
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);sample(2,80,-110,0,false);
    sample(1,100,-110,0,false);sample(2,120,-110,0,false);sample(0,140,0,0,false);
    assert(!commits&&cancels==1);
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);sample(2,80,-110,0,false);
    sample(1,100,-140,0,false);sample(0,120,0,0,false);assert(!commits&&cancels==1);
    for(int count=3;count<=5;count++) {
        reset();sample(1,0,0,0,false);sample(count,20,0,0,false);sample(2,40,-50,0,false);
        sample(1,60,-100,0,false);sample(0,80,0,0,false);assert(passes==1&&!commits&&cancels==1);
        sample(1,100,0,0,false);sample(0,180,0,0,false);assert(passes==3);
    }
    reset();sample(2,0,0,0,false);sample(2,40,-50,30,false);sample(2,80,-110,57,false);sample(0,100,0,0,false);
    assert(!commits&&cancels==1);
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);sample(2,80,-95,0,false);sample(0,100,0,0,false);
    assert(!commits&&ends==1);
    reset();sample(2,0,0,0,false);sample(2,40,-110,0,false);sample(0,60,0,0,false);assert(!commits);
    reset();sample(2,0,0,0,false);sample(2,20,-50,0,false);sample(2,40,-110,0,false);sample(0,60,0,0,false);assert(!commits);
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);sample(2,80,-110,0,false);
    sample(2,120,-30,0,false);sample(0,140,0,0,false);assert(!commits);
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);sample(2,80,30,0,false);sample(0,100,0,0,false);
    assert(!commits&&cancels==1);
    reset();sample(2,0,0,0,false);sample(2,121,-50,0,false);sample(0,140,0,0,false);assert(cancels==1&&!commits);
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);sample(2,80,-110,0,false);sample(0,201,0,0,false);assert(!commits);
    reset();sample(2,0,0,0,false);for(unsigned t=100;t<=1300;t+=100)sample(2,t,-110,0,false);
    sample(0,1320,0,0,false);assert(!commits&&cancels==1);
    reset();sample(2,0,0,0,false);sample(2,40,-161,0,false);sample(0,60,0,0,false);assert(cancels==1&&!commits);
    reset();sweep(UINT32_MAX-50,-1);assert(commits==1); // Monotonic tick wraps normally.
    pro_contact_t bad[2]={{350,220,2},{500,320,2}};
    reset();assert(pro_contacts_sample(&state,bad,2,0).event==PRO_CONTACT_CANCEL);
    bad[1].id=7;bad[1].x=720;reset();assert(pro_contacts_sample(&state,bad,2,0).event==PRO_CONTACT_CANCEL);
    bad[1].x=500;reset();sample(2,0,0,0,false);bad[1].id=9;
    assert(pro_contacts_sample(&state,bad,2,40).event==PRO_CONTACT_CANCEL);
    reset();sample(2,0,0,0,false);bad[1].id=7;bad[0].x=300;bad[1].x=550;
    assert(pro_contacts_sample(&state,bad,2,40).event==PRO_CONTACT_CANCEL); // Pinch.
    reset();sample(2,0,0,0,false);sample(2,40,-50,0,false);pro_contacts_block(&state);
    sample(2,80,-110,0,false);sample(1,100,-110,0,false);sample(0,120,0,0,false);assert(!commits&&!passes);
    sample(1,140,0,0,false);sample(0,220,0,0,false);assert(passes==2);
    // Adversarial count/position/identity traces: once a contact has two fingers,
    // no single-finger DOWN/UP can escape until an observed all-up boundary.
    uint32_t random=0x911;
    for(unsigned trial=0;trial<2000;trial++) {
        reset();bool multi=false;unsigned emitted=0;
        for(unsigned tick=0;tick<200;tick++) {
            random=random*1664525u+1013904223u;unsigned n=(random>>16)%6;
            pro_contact_t p[5];for(unsigned j=0;j<5;j++)p[j]=(pro_contact_t){(random+j*81)%740,(random/3+j*40)%740,(random>>(j+1))%7};
            if(n>=2)multi=true;
            pro_contact_result_t r=pro_contacts_sample(&state,p,n,tick*20);
            if(multi)assert(r.event!=PRO_CONTACT_PASS);
            if(r.event==PRO_CONTACT_END&&r.step){assert(r.step==-1||r.step==1);assert(++emitted==1);}
            if(!n){multi=false;emitted=0;}
        }
    }
    puts("Pro contacts: PASS (tracked pairs, thresholds, quarantine, release tails, tick wrap, 400000 adversarial samples)");
}
