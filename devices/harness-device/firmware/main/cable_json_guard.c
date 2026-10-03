#include "cable_json_guard.h"

bool cable_json_guard(const uint8_t *bytes, size_t length)
{
    if (!bytes || !length || length >= CABLE_JSON_MAX) return false;
    uint8_t stack[CABLE_JSON_DEPTH];
    unsigned depth = 0, tokens = 0;
    bool string = false, escaped = false, started = false, finished = false, atom = false;
    for (size_t i = 0; i < length; i++) {
        const uint8_t c = bytes[i];
        if (string) {
            if (c < 0x20) return false;
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') string = false;
            continue;
        }
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { atom = false; continue; }
        if (c < 0x20 || finished) return false;
        if (!started) {
            if (c != '{') return false;
            started = true;
        }
        if (c == '"') {
            if (++tokens > CABLE_JSON_TOKENS) return false;
            string = true; atom = false;
        }
        else if (c == '{' || c == '[') {
            if (++tokens > CABLE_JSON_TOKENS || depth == CABLE_JSON_DEPTH) return false;
            stack[depth++] = c;
            atom = false;
        } else if (c == '}' || c == ']') {
            if (!depth || stack[depth - 1] != (c == '}' ? '{' : '[')) return false;
            if (!--depth) finished = true;
            atom = false;
        } else if (c == ':' || c == ',') atom = false;
        else if (!atom) {
            if (++tokens > CABLE_JSON_TOKENS) return false;
            atom = true;
        }
    }
    return finished && !string && !depth;
}
