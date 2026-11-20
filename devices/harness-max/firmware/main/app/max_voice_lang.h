// Harness Max's voice language before anyone chooses one. The Pro's config_store.c reads English when no language was
// ever saved and stays as it is; the bar writes its own default over that once, at boot.
#pragma once

#include <stdbool.h>

#define MAX_VOICE_LANG_DEFAULT "vi"   // the owner, 20 Nov: the bar transcribes Vietnamese until Settings says otherwise

// After config_store_init, before the hello: when no voice language was ever saved, save MAX_VOICE_LANG_DEFAULT.
// A language the person chose (settings.set voiceLang) is never overwritten. True when it wrote the default.
bool max_voice_lang_default(void);
