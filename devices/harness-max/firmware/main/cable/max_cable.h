// What Harness Max's cable (main/pro_fork/cable/pro_cable.c, its copy of the Pro's) adds to the Pro's cable/pro_cable.h
// and cable/cable_features.h: the sends for the apps, answering and New Harness, and the welcome features they wait on.
// The replies come back as calls of the Max's pro_app_api.h (main/pro_fork/pro_app_api.h). The Pro sends none of these.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "cable/cable_features.h"
#include "cable/pro_cable.h"

// ---- the welcome's features ----
// Those only the Max reads, above every bit of the Pro's (cable_features.h), so a feature the Pro takes later cannot
// land on one of them.
enum {
    CABLE_FEATURE_FORM = 1u << 16,              // New Harness: `form` reaches the desktop's form
    CABLE_FEATURE_QUESTION_REVIEW = 1u << 17,   // `question.read` and `answer.reviewed`
    CABLE_FEATURE_QUESTION_TIER = 1u << 18,     // a `question` with `tier: "list"` is filed silently (the Max asks for it)
};
// The Pro's features (cable_features_parse) and the Max's, from the same `features` list by the same rule: more than 16
// entries, or one that is not a string, makes the whole result 0 (main/cable/max_cable_features.c).
uint32_t max_cable_features_parse(const cJSON *welcome);
// welcome.features names every CABLE_FEATURE_* bit in `feature`, the Pro's or the Max's.
bool pro_cable_supports(uint32_t feature);

// ---- the apps ----
// app.pick {app}: the person picked this app on the device. False when it was not sent.
bool pro_cable_app_pick(const char *app, bool wait);

// ---- voice ----
// The next voice.begin is a spoken name for this form's field at this revision: it carries formId and formRevision and
// no agentId, and the reply arrives as pro_app_voice_form. NULL: an ordinary recording. Set before each pro_voice_begin.
void pro_cable_voice_form(const char *form_id, int revision);

// ---- answering and New Harness ----
// `wait`: block for the port like a tap's agent.open (the touch task), or give up at once (the render task). Each
// returns false when the message is malformed or could not go out.
// question.read {agentId, requestId}: the open question whole, for answering it (pro_app_question_state replies).
bool pro_cable_question_read(const char *agent_id, const char *request_id, bool wait);
// answer.reviewed {agentId, token, requestId, choices}: one option mask per question, bit j for option j
// (pro_app_answer_receipt replies).
bool pro_cable_answer_reviewed(const char *agent_id, const char *token, const char *request_id, const uint8_t *choices,
                               int count, bool wait);
// answer {agentId, requestId, answers:{key: value}}: a daemon without question.review. `request_id` is the question's
// id; no reply comes.
bool pro_cable_answer(const char *agent_id, const char *request_id, const char *const keys[], const char *const values[],
                      int count, bool wait);
// form {requestId, formId, surface:"new", op, revision, delta}: New Harness on the cabled computer. op is open, state,
// move (delta -8..8, not 0), activate, back or close; formId is [A-Za-z0-9-]{1,48} (pro_app_form_state replies).
bool pro_cable_form(const char *form_id, const char *request_id, const char *op, int revision, int delta, bool wait);
