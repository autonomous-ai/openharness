"""Exercise the production metadata-only NVS functions with fault injection.

The fake backend models committed versus staged bytes. This checks API failure
handling and power-loss states; it does not replace physical NVS power trials.
"""
from pathlib import Path
import os,re,subprocess,tempfile
MAIN=Path(__file__).resolve().parent/'../main'
SOURCE=(MAIN/'config_store.c').read_text()
def function(name):
    m=re.search(r'^[^\n]*\b'+name+r'\([^;]*?\)\n\{.*?^\}',SOURCE,re.M|re.S);assert m,name;return m.group(0)+'\n'
code=r'''
#include "config_store.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
typedef int nvs_handle_t;typedef int esp_err_t;
enum {ESP_OK,NVS_READONLY,NVS_READWRITE,ESP_ERR_NVS_NOT_FOUND};
static const char *NS="pair";
static bool opened,writable,present,staged_present,fail_open,fail_read,fail_set,fail_erase,fail_commit;
static unsigned writes,erases,commits,opens,closes;
static size_t stored_size;
static pro_recovery_bookmark_t stored,staged;
static int nvs_open(const char *ns,int mode,nvs_handle_t *h){assert(!opened&&!strcmp(ns,NS));if(fail_open)return -1;opened=true;writable=mode==NVS_READWRITE;*h=7;staged=stored;staged_present=present;opens++;return ESP_OK;}
static int nvs_get_blob(nvs_handle_t h,const char *key,void *out,size_t *size){assert(opened&&h==7&&!strcmp(key,"pro_recover"));if(!present)return ESP_ERR_NVS_NOT_FOUND;if(fail_read){memset(out,0xde,*size);return -1;}assert(*size==sizeof stored);memcpy(out,&stored,sizeof stored);*size=stored_size;return ESP_OK;}
static int nvs_set_blob(nvs_handle_t h,const char *key,const void *in,size_t size){assert(opened&&writable&&h==7&&!strcmp(key,"pro_recover")&&size==sizeof stored);writes++;if(fail_set)return -1;memcpy(&staged,in,size);staged_present=true;return ESP_OK;}
static int nvs_erase_key(nvs_handle_t h,const char *key){assert(opened&&writable&&h==7&&!strcmp(key,"pro_recover"));erases++;if(fail_erase)return -1;staged_present=false;return present?ESP_OK:ESP_ERR_NVS_NOT_FOUND;}
static int nvs_commit(nvs_handle_t h){assert(opened&&writable&&h==7);commits++;if(fail_commit)return -1;stored=staged;present=staged_present;stored_size=sizeof stored;return ESP_OK;}
static void nvs_close(nvs_handle_t h){assert(opened&&h==7);opened=false;closes++;}
'''
for n in ('config_load_pro_recovery','config_save_pro_recovery','config_clear_pro_recovery'):code+=function(n)
code+=r'''
int main(void){
    pro_recovery_bookmark_t b={.magic=0x48524431u,.schema=1,.mode=2,.carried=1,.revision=17,.id="draft-id",.host="full-host-id",.agent="exact-agent",.name="Người nhận ban đầu"},out;
    b.checksum=pro_recovery_checksum(&b);assert(pro_recovery_bookmark_valid(&b)&&sizeof b==256);
    memset(&out,0xee,sizeof out);assert(!config_load_pro_recovery(&out)&&!out.magic);
    assert(config_save_pro_recovery(&b));assert(writes==1&&commits==1);assert(config_load_pro_recovery(&out)&&!memcmp(&out,&b,sizeof b));
    for(unsigned byte=0;byte<sizeof b;byte++){stored=b;((unsigned char*)&stored)[byte]^=1;assert(!config_load_pro_recovery(&out)&&!out.magic);}
    stored=b;stored_size=sizeof b-1;assert(!config_load_pro_recovery(&out));stored_size=sizeof b+1;assert(!config_load_pro_recovery(&out));stored_size=sizeof b;
    b.mode=3;b.checksum=pro_recovery_checksum(&b);assert(!config_save_pro_recovery(&b)&&writes==1);b.mode=2;
    memset(b.host,'x',sizeof b.host);b.checksum=pro_recovery_checksum(&b);assert(!config_save_pro_recovery(&b));strcpy(b.host,"full-host-id");memset(b.host+13,0,sizeof b.host-13);b.checksum=pro_recovery_checksum(&b);
    fail_open=true;assert(!config_load_pro_recovery(&out)&&!out.magic);assert(!config_save_pro_recovery(&b)&&!config_clear_pro_recovery());fail_open=false;
    fail_read=true;assert(!config_load_pro_recovery(&out)&&!out.magic);fail_read=false;
    unsigned initial=commits;fail_set=true;assert(!config_save_pro_recovery(&b)&&commits==initial);fail_set=false;
    fail_commit=true;assert(!config_save_pro_recovery(&b));assert(!config_clear_pro_recovery());assert(present);fail_commit=false;
    fail_erase=true;initial=commits;assert(!config_clear_pro_recovery()&&commits==initial&&present);fail_erase=false;
    assert(config_clear_pro_recovery()&&!present);assert(config_clear_pro_recovery());assert(!config_load_pro_recovery(&out));
    assert(opens==closes&&!opened);puts("Recovery NVS: PASS (256-byte metadata, strict schema/checksum/length, absent/corrupt records, open/read/write/erase/commit faults, committed clear, no transcript)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-recovery-store-') as d:
    p=Path(d);(p/'store.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g','-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),'-DDEVICE_PRO_COMPANION=1','-I',str(MAIN),str(p/'store.c'),'-o',str(p/'store')],check=True)
    subprocess.run([str(p/'store')],check=True)
