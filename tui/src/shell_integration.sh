# Loaded only in shells opened by Harness. Never installed in user startup files.
_hn_request() (
    exec 4<>/dev/tty
    [ -t 4 ] || { printf '%s\n' 'Run this command at an interactive Harness prompt.' >&2; exit 1; }
    # zsh subshells inherit the same RANDOM state. Use fresh OS randomness so
    # successive commands cannot accidentally reuse a completed request id.
    _hn_nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \r\n')
    [ "${#_hn_nonce}" = 32 ] || { printf '%s\n' 'Could not create a shell request.' >&2; exit 1; }
    _hn_id="$$-$_hn_nonce"
    _hn_dir="$HOME/.harness/shell-requests/$_HN_CONTEXT"
    umask 077
    mkdir -p -- "$_hn_dir" || exit 1
    _hn_fifo="$_hn_dir/$_hn_id"
    mkfifo -- "$_hn_fifo" || exit 1
    trap 'rm -f -- "$_hn_fifo"; rmdir -- "$_hn_dir" 2>/dev/null || true' EXIT
    trap 'printf "\\033]633;hn;%s;%s;cancel;\\007" "$_HN_CONTEXT" "$_hn_id" >&4; exit 130' INT
    trap 'printf "\\033]633;hn;%s;%s;cancel;\\007" "$_HN_CONTEXT" "$_hn_id" >&4; exit 143' TERM HUP
    exec 3<>"$_hn_fifo" || exit 1
    _hn_query=$(printf '%s' "${2-}" | base64 | tr -d '\r\n')
    # A freshly reattached stream may miss its first output event. Retry the same
    # request id; the client deduplicates it and never repeats the action.
    _hn_attempt=0
    _hn_attempts=120
    [ "$1" != picker-ready ] || _hn_attempts=5
    while [ "$_hn_attempt" -lt "$_hn_attempts" ]; do
        _hn_attempt=$((_hn_attempt + 1))
        printf '\033]633;hn;%s;%s;%s;%s\007' "$_HN_CONTEXT" "$_hn_id" "$1" "$_hn_query" >&4
        IFS= read -r -t 1 _hn_reply <&3 || continue
        case "$_hn_reply" in
            "HN:$_hn_id:"*)
                _hn_reply=${_hn_reply#"HN:$_hn_id:"}
                _hn_code=${_hn_reply%%:*}
                _hn_data=${_hn_reply#*:}
                if [ "$_hn_code" = 0 ]; then
                    printf '%s' "$_hn_data" | base64 -d
                    exit 0
                fi
                [ -z "$_hn_data" ] || { printf '%s' "$_hn_data" | base64 -d >&2; printf '\n' >&2; }
                exit 1
                ;;
        esac
    done
    printf '%s\n' 'Harness did not answer. Your shell is still available; try again.' >&2
    exit 1
)
_hn_pick() {
    if [ -n "${_HN_PICKER-}" ] && [ -x "$_HN_PICKER" ]; then
        "$_HN_PICKER" --shell-picker "$@" </dev/tty
    else
        "${_HN_CLI:-harness}" tui --shell-picker "$@" </dev/tty
    fi
}
function ch {
    local _hn_selected
    if [ "$#" -gt 0 ]; then _hn_request host-inline "$*"; return $?; fi
    _hn_selected=$(_hn_pick host) || return $?
    _hn_request host-inline "$_hn_selected"
}
function cm {
    local _hn_selected
    if [ "$*" = default ]; then _hn_request model-inline default; return $?; fi
    if [ "$#" = 1 ]; then case "$1" in *' :: '*) _hn_request model-inline "$1"; return $?;; esac; fi
    _hn_selected=$(_hn_pick model "$*") || return $?
    _hn_request model-inline "$_hn_selected"
}
_hn_sessions() {
    local _hn_selected
    if [ "${1-}" = --id ] && [ "$#" = 2 ]; then _hn_request session-inline "$2"; return $?; fi
    _hn_selected=$(_hn_pick sessions "$*") || return $?
    _hn_request session-inline "$_hn_selected"
}
_hn_native() {
    local _hn_engine="$1" _hn_binary="$1" _hn_resolved
    shift
    case "$_hn_engine" in
        cursor) _hn_binary=cursor-agent ;;
        commandcode) _hn_binary=cmd ;;
    esac
    if [ -n "${ZSH_VERSION-}" ]; then
        _hn_resolved=$(whence -p -- "$_hn_binary") || _hn_resolved=''
    else
        _hn_resolved=$(type -P -- "$_hn_binary") || _hn_resolved=''
    fi
    if [ -n "$_hn_resolved" ] && [ -f "$_hn_resolved" ] && [ -x "$_hn_resolved" ]; then
        "$_hn_resolved" "$@"
    else
        "${_HN_CLI:-harness}" shell-launch "$_hn_engine" --native -- "$@"
    fi
}
_hn_agent() {
    local _hn_engine="$1" _hn_route _hn_grid _hn_model _hn_arg
    shift
    case "$_hn_engine" in
        codex|claude|cursor|opencode|pi|hermes|commandcode|devin|muse|amp|kilo|grok|agy|copilot) ;;
        cursor-agent) _hn_engine=cursor ;;
        cmd) _hn_engine=commandcode ;;
        *) printf '%s\n' 'Use hn run with a supported agent, such as codex, claude, or pi.' >&2; return 2 ;;
    esac
    # Selector words are consumed only before --. The Rust helper keeps argv
    # literal and validates the destination without changing this shell.
    for _hn_arg in "$@"; do
        case "$_hn_arg" in
            --) break ;;
            @*|:*|%*) "$_HN_PICKER" --shell-compose-launch "$_hn_engine" "$@"; return $? ;;
        esac
    done
    # Native configuration, maintenance and resume commands remain native. A model
    # flag takes precedence over cm for this invocation, including profile settings.
    # Subcommands are only meaningful in the command position, not in a prompt.
    case "${1-}" in
        resume|fork|login|logout|auth|update|completion|mcp|mcp-server|doctor)
            _hn_native "$_hn_engine" "$@"; return $? ;;
    esac
    for _hn_arg in "$@"; do
        case "$_hn_arg" in
            --) break ;;
            --profile|--profile=*|-p|-p?*)
                if [ "$_hn_engine" = codex ]; then _hn_native "$_hn_engine" "$@"; return $?; fi ;;
            -h|--help|-V|--version|--resume|--resume=*|--continue|-r|-r?*|--model|--model=*|-m|-m?*|--provider|--provider=*|--oss|--local-provider|--local-provider=*|-c|--config|--config=*|--settings|--settings=*)
                _hn_native "$_hn_engine" "$@"; return $? ;;
        esac
    done
    _hn_route=$(_hn_request route) || return $?
    if [ -z "$_hn_route" ]; then
        _hn_native "$_hn_engine" "$@"
    else
        case "$_hn_engine" in
            codex|claude) ;;
            *) printf 'cm routing is not supported for %s yet. Run cm default to use its own model settings.\n' "$_hn_engine" >&2; return 2 ;;
        esac
        _hn_grid=${_hn_route%%'
'*}
        _hn_model=${_hn_route#*'
'}
        "${_HN_CLI:-harness}" shell-launch "$_hn_engine" "$_hn_grid" "$_hn_model" -- "$@"
    fi
}
# User aliases/functions keep their meaning. The explicit `hn run <agent>` path
# remains available even when an agent name is customized.
if [ -n "${ZSH_VERSION-}" ]; then
    (( $+aliases[codex] || $+functions[codex] )) || function codex { _hn_agent codex "$@"; }
    (( $+aliases[claude] || $+functions[claude] )) || function claude { _hn_agent claude "$@"; }
    (( $+aliases[cursor-agent] || $+functions[cursor-agent] )) || function cursor-agent { _hn_agent cursor "$@"; }
    (( $+aliases[opencode] || $+functions[opencode] )) || function opencode { _hn_agent opencode "$@"; }
    (( $+aliases[pi] || $+functions[pi] )) || function pi { _hn_agent pi "$@"; }
    (( $+aliases[hermes] || $+functions[hermes] )) || function hermes { _hn_agent hermes "$@"; }
    (( $+aliases[cmd] || $+functions[cmd] )) || function cmd { _hn_agent commandcode "$@"; }
    (( $+aliases[devin] || $+functions[devin] )) || function devin { _hn_agent devin "$@"; }
    (( $+aliases[muse] || $+functions[muse] )) || function muse { _hn_agent muse "$@"; }
    (( $+aliases[amp] || $+functions[amp] )) || function amp { _hn_agent amp "$@"; }
    (( $+aliases[kilo] || $+functions[kilo] )) || function kilo { _hn_agent kilo "$@"; }
    (( $+aliases[grok] || $+functions[grok] )) || function grok { _hn_agent grok "$@"; }
    (( $+aliases[agy] || $+functions[agy] )) || function agy { _hn_agent agy "$@"; }
    (( $+aliases[copilot] || $+functions[copilot] )) || function copilot { _hn_agent copilot "$@"; }
elif [ -n "${BASH_VERSION-}" ]; then
    alias codex >/dev/null 2>&1 || declare -F codex >/dev/null || function codex { _hn_agent codex "$@"; }
    alias claude >/dev/null 2>&1 || declare -F claude >/dev/null || function claude { _hn_agent claude "$@"; }
    alias cursor-agent >/dev/null 2>&1 || declare -F cursor-agent >/dev/null || function cursor-agent { _hn_agent cursor "$@"; }
    alias opencode >/dev/null 2>&1 || declare -F opencode >/dev/null || function opencode { _hn_agent opencode "$@"; }
    alias pi >/dev/null 2>&1 || declare -F pi >/dev/null || function pi { _hn_agent pi "$@"; }
    alias hermes >/dev/null 2>&1 || declare -F hermes >/dev/null || function hermes { _hn_agent hermes "$@"; }
    alias cmd >/dev/null 2>&1 || declare -F cmd >/dev/null || function cmd { _hn_agent commandcode "$@"; }
    alias devin >/dev/null 2>&1 || declare -F devin >/dev/null || function devin { _hn_agent devin "$@"; }
    alias muse >/dev/null 2>&1 || declare -F muse >/dev/null || function muse { _hn_agent muse "$@"; }
    alias amp >/dev/null 2>&1 || declare -F amp >/dev/null || function amp { _hn_agent amp "$@"; }
    alias kilo >/dev/null 2>&1 || declare -F kilo >/dev/null || function kilo { _hn_agent kilo "$@"; }
    alias grok >/dev/null 2>&1 || declare -F grok >/dev/null || function grok { _hn_agent grok "$@"; }
    alias agy >/dev/null 2>&1 || declare -F agy >/dev/null || function agy { _hn_agent agy "$@"; }
    alias copilot >/dev/null 2>&1 || declare -F copilot >/dev/null || function copilot { _hn_agent copilot "$@"; }
fi
function hn {
    case "${1-}" in
        pick) shift; _hn_choose "$@" ;;
        sessions) shift; _hn_sessions "$@" ;;
        ch) shift; ch "$@" ;;
        cm) shift; cm "$@" ;;
        run) shift; _hn_agent "$@" ;;
        *) command hn "$@" ;;
    esac
}

# Direct shell widgets use the same picker and actions as the commands. The
# line editor owns the draft throughout: no accept-line, injected command, or
# evaluation of the selected value. A parked computer/session keeps its draft.
_hn_choose() {
    local _hn_choice _hn_kind _hn_value
    _hn_choice=$(_hn_pick choose "$*") || return $?
    case "$_hn_choice" in *'
'*) ;; *) return 1;; esac
    _hn_kind=${_hn_choice%%'
'*}
    _hn_value=${_hn_choice#*'
'}
    [ -n "$_hn_value" ] || return 1
    case "$_hn_kind" in
        host) _hn_request host-inline "$_hn_value" ;;
        model) _hn_request model-inline "$_hn_value" ;;
        sessions) _hn_request session-inline "$_hn_value" ;;
        *) return 1 ;;
    esac
}
_hn_picker_widget() {
    local _hn_message _hn_choice _hn_rest _hn_cursor _hn_line _hn_kind _hn_value _hn_nl='
'
    if [ -n "${ZSH_VERSION-}" ]; then
        _hn_choice=$(_HN_PICKER_WIDGET=1 _hn_pick compose "$BUFFER" "$CURSOR" "$@") || { zle reset-prompt; return 0; }
    elif [ "${READLINE_LINE+x}" = x ]; then
        # Bash 5 changed bind-x's READLINE_POINT from bytes to characters.
        if [ "${BASH_VERSINFO[0]}" -ge 5 ]; then
            _hn_choice=$(_HN_PICKER_WIDGET=1 _hn_pick compose "$READLINE_LINE" "$READLINE_POINT" "$@") || return 0
        else
            _hn_choice=$(_HN_PICKER_WIDGET=1 _hn_pick compose "$READLINE_LINE" "$READLINE_POINT" --bytes "$@") || return 0
        fi
    else
        _hn_choice=$(_HN_PICKER_WIDGET=1 _hn_pick choose) || return 0
    fi
    _hn_kind=${_hn_choice%%"$_hn_nl"*}; _hn_value=${_hn_choice#*"$_hn_nl"}
    if [ "$_hn_kind" = edit ]; then
        _hn_cursor=${_hn_value%%"$_hn_nl"*}; _hn_line=${_hn_value#*"$_hn_nl"}
        case "$_hn_cursor" in ''|*[!0-9]*) return 0;; esac
        if [ -n "${ZSH_VERSION-}" ]; then BUFFER=$_hn_line; CURSOR=$_hn_cursor; zle reset-prompt
        else
            READLINE_LINE=$_hn_line
            if [ "${BASH_VERSINFO[0]}" -ge 5 ]; then READLINE_POINT=$_hn_cursor
            else
                _hn_rest=${_hn_line:0:$_hn_cursor}
                local LC_ALL=C
                READLINE_POINT=${#_hn_rest}
            fi
        fi
        return 0
    fi
    case "$_hn_kind" in
        host|model) _hn_message=$(_hn_request "$_hn_kind-inline" "$_hn_value" 2>&1) || : ;;
        sessions) _hn_message=$(_hn_request session-inline "$_hn_value" 2>&1) || : ;;
    esac
    if [ -n "$_hn_message" ]; then
        if [ -n "${ZSH_VERSION-}" ]; then
            # The finder moved the physical cursor while ZLE retained its own
            # display state. A raw printf here is erased by the next redisplay.
            # Let the line editor keep the explanation beneath the prompt.
            zle reset-prompt
            zle -M "$_hn_message"
            return 0
        fi
        printf '\r\n%s\r\n' "$_hn_message" >/dev/tty
    fi
    if [ -n "${ZSH_VERSION-}" ]; then zle reset-prompt; fi
    return 0
}
_hn_new_widget() { _hn_picker_widget --agents; }
# Private startup key: if the user has already typed, leave their draft alone.
_hn_begin_widget() {
    if [ -n "${ZSH_VERSION-}" ]; then [ -z "$BUFFER" ] && _hn_new_widget
    else [ -z "${READLINE_LINE-}" ] && _hn_new_widget
    fi
    return 0
}
# Ctrl-P opens the finder at the shell prompt; it is never intercepted from an
# agent, editor or child process. Up still recalls history. Like fzf's widgets,
# this can be rebound or disabled in the user's rc file before integration loads.
# A terminal can map Cmd-P to Ctrl-P; reporting Cmd-P via Kitty is also supported.
_hn_picker_key=${HN_PICKER_KEY-'\C-p'}
_hn_new_key=${HN_NEW_KEY-'\C-n'}
if [ -n "${ZSH_VERSION-}" ]; then
    zle -N hn-picker-widget _hn_picker_widget
    zle -N hn-new-widget _hn_new_widget
    zle -N hn-begin-widget _hn_begin_widget
    for _hn_keymap in emacs viins; do bindkey -M "$_hn_keymap" '\e[9001~' hn-begin-widget; done
    if [ -n "$_hn_picker_key" ]; then
        for _hn_keymap in emacs viins; do bindkey -M "$_hn_keymap" "$_hn_picker_key" hn-picker-widget; done
    fi
    if [ -n "$_hn_new_key" ]; then
        for _hn_keymap in emacs viins; do bindkey -M "$_hn_keymap" "$_hn_new_key" hn-new-widget; done
    fi
elif [ -n "${BASH_VERSION-}" ]; then
    for _hn_keymap in emacs-standard vi-insert; do
        if [ -n "$_hn_picker_key" ]; then bind -m "$_hn_keymap" -x "\"$_hn_picker_key\": _hn_picker_widget"; fi
        # Bash 3.2 cannot edit the draft; leave its next-history key intact.
        if [ "${BASH_VERSINFO[0]}" -ge 4 ] && [ -n "$_hn_new_key" ]; then
            bind -m "$_hn_keymap" -x "\"$_hn_new_key\": _hn_new_widget"
        fi
        if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then bind -m "$_hn_keymap" -x '"\e[9001~": _hn_begin_widget'; fi
    done
fi
unset _hn_picker_key _hn_new_key _hn_keymap

# Automatic suggestions are limited to Harness agent selectors. The line editor
# inserts the real character first; Rust checks quoting, native option values and
# the -- boundary before opening anything. Ordinary typing never spawns a picker.
_hn_auto_context() {
    [ "${HN_AUTOCOMPLETE-1}" != 0 ] || return 1
    case "$1" in *' @'|*' :'|*' %'|*' @'*':') ;; *) return 1;; esac
    local _hn_command=${1%% *} _hn_definition
    case "$_hn_command" in codex|claude|cursor-agent|opencode|pi|hermes|cmd|devin|muse|amp|kilo|grok|agy|copilot) ;; *) return 1;; esac
    # Customized commands retain their normal completion behavior.
    if [ -n "${ZSH_VERSION-}" ]; then
        (( $+aliases[$_hn_command] )) && return 1
        _hn_definition=${functions[$_hn_command]-}
    else
        alias "$_hn_command" >/dev/null 2>&1 && return 1
        _hn_definition=$(declare -f "$_hn_command")
    fi
    case "$_hn_definition" in *'_hn_agent '*) return 0;; *) return 1;; esac
}
if [ -n "${ZSH_VERSION-}" ] && [ "${HN_AUTOCOMPLETE-1}" != 0 ]; then
    _hn_auto_widget() {
        local _hn_symbol _hn_before=$BUFFER
        case "$KEYS" in '@') _hn_symbol=host;; ':') _hn_symbol=folder;; '%') _hn_symbol=model;; *) return 0;; esac
        # KEYMAP can be the alias "main". ZLE displays missing-widget errors
        # itself, so redirecting stderr does not suppress that message.
        local _hn_saved="_hn_insert_${KEYMAP}_$_hn_symbol"
        if (( $+widgets[$_hn_saved] )); then zle "$_hn_saved"
        else zle "_hn_insert_emacs_$_hn_symbol"
        fi
        # bracketed-paste bypasses these key bindings. Also respect paste-magic.
        [ "${PASTED+x}" != x ] && [ "$BUFFER" != "$_hn_before" ] && _hn_auto_context "$LBUFFER" && _hn_picker_widget --auto
        return 0
    }
    zle -N hn-auto-widget _hn_auto_widget
    for _hn_keymap in emacs viins; do
        for _hn_char in '@' ':' '%'; do
            case "$_hn_char" in '@') _hn_symbol=host;; ':') _hn_symbol=folder;; '%') _hn_symbol=model;; esac
            _hn_insert=$(bindkey -M "$_hn_keymap" "$_hn_char"); _hn_insert=${_hn_insert##* }
            # Only wrap insertion keys, leaving user macros and other actions intact.
            case "$_hn_insert" in self-insert|self-insert-unmeta)
                zle -A "$_hn_insert" "_hn_insert_${_hn_keymap}_$_hn_symbol"
                bindkey -M "$_hn_keymap" "$_hn_char" hn-auto-widget;;
            esac
        done
    done
elif [ -n "${BASH_VERSION-}" ] && [ "${BASH_VERSINFO[0]}" -ge 4 ] && [ "${HN_AUTOCOMPLETE-1}" != 0 ]; then
    _hn_insert_bash() {
        # Bash 4 uses bytes; Bash 5 uses character offsets in the active locale.
        if [ "${BASH_VERSINFO[0]}" -lt 5 ]; then local LC_ALL=C; fi
        READLINE_LINE=${READLINE_LINE:0:READLINE_POINT}$1${READLINE_LINE:READLINE_POINT}
        READLINE_POINT=$((READLINE_POINT + 1))
    }
    _hn_auto_bash() {
        _hn_insert_bash "$1"
        # The whole line is only a cheap prefix check; Rust uses the real cursor.
        _hn_auto_context "$READLINE_LINE" && _hn_picker_widget --auto
        return 0
    }
    for _hn_keymap in emacs-standard vi-insert; do
        _hn_bindings=$(bind -m "$_hn_keymap" -p)
        for _hn_char in '@' ':' '%'; do
            case "$_hn_bindings" in *"\"$_hn_char\": self-insert"*)
                bind -m "$_hn_keymap" -x "\"$_hn_char\": _hn_auto_bash '$_hn_char'";;
            esac
        done
    done
fi
unset _hn_keymap _hn_char _hn_symbol _hn_insert _hn_bindings

# Like fzf's shell widgets: selection edits a draft; only the subsequent Enter
# executes it. Tab on other commands still invokes the user's original widget.
# Ctrl-T, Ctrl-R, Alt-C and their fzf configuration are never rebound.
_hn_completion_context() {
    _hn_complete_kind='' _hn_complete_head='' _hn_complete_query=''
    case "$1" in
        'ch '*) _hn_complete_kind=host; _hn_complete_head='ch '; _hn_complete_query=${1#'ch '};;
        'cm '*) _hn_complete_kind=model; _hn_complete_head='cm '; _hn_complete_query=${1#'cm '};;
        'hn sessions '*) _hn_complete_kind=sessions; _hn_complete_head='hn sessions --id '; _hn_complete_query=${1#'hn sessions '};;
        *) return 1;;
    esac
    # Completion must never interpret shell code, quoted strings or pipelines.
    # Those keep their ordinary completion behavior.
    case "$_hn_complete_query" in *[\;\|\&\<\>\$\`\"\'\\]*|--*) return 1;; esac
    _hn_complete_query=${_hn_complete_query%\*\*}
}
if [ -n "${ZSH_VERSION-}" ]; then
    _hn_complete_widget() {
        local _hn_complete_kind _hn_complete_head _hn_complete_query _hn_selected _hn_result=0
        if ! _hn_completion_context "$LBUFFER"; then
            zle "_hn_tab_${KEYMAP}" 2>/dev/null || zle _hn_tab_main
            return
        fi
        _hn_selected=$(_HN_PICKER_WIDGET=1 _hn_pick "$_hn_complete_kind" "$_hn_complete_query" --completion) || _hn_result=$?
        if [ "$_hn_result" = 0 ] && [ -n "$_hn_selected" ]; then
            LBUFFER="$_hn_complete_head${(q)_hn_selected} "
        fi
        zle reset-prompt
        return 0
    }
    zle -N _hn_complete_widget
    # Copy the actual Tab widget, including fzf-completion or a user's plugin.
    # A keyboard macro is not a widget: leave such custom bindings untouched.
    for _hn_keymap in main emacs viins; do
        _hn_tab=$(bindkey -M "$_hn_keymap" '^I' 2>/dev/null)
        _hn_tab=${_hn_tab##* }
        [ "$_hn_tab" = _hn_complete_widget ] && continue
        if zle -A "$_hn_tab" "_hn_tab_$_hn_keymap" 2>/dev/null; then
            bindkey -M "$_hn_keymap" '^I' _hn_complete_widget
        fi
    done
    unset _hn_keymap _hn_tab
elif [ -n "${BASH_VERSION-}" ]; then
    # Programmable completion also works with macOS's Bash 3.2; it does not need
    # READLINE_LINE (Bash 4+) or a macro that evaluates the current input buffer.
    _hn_complete_bash() {
        local _hn_complete_kind _hn_complete_head _hn_complete_query _hn_selected _hn_quoted _hn_result=0
        COMPREPLY=()
        _hn_completion_context "${COMP_LINE:0:COMP_POINT}" || return 0
        # Bash replaces only COMP_WORDS[COMP_CWORD], unlike ZLE's whole LBUFFER.
        # Restrict to a single unquoted query word so earlier arguments stay intact.
        [ "$COMP_CWORD" = 1 ] || { [ "${COMP_WORDS[0]}" = hn ] && [ "$COMP_CWORD" = 2 ]; } || return 0
        _hn_selected=$(_HN_PICKER_WIDGET=1 _hn_pick "$_hn_complete_kind" "$_hn_complete_query" --completion) || _hn_result=$?
        # fzf's Bash completion uses this terminal-status response to ask
        # Readline to redraw after it regains control. It also restores a draft
        # erased by terminal reflow when the picker was resized and cancelled.
        bind '"\e[0n": redraw-current-line' 2>/dev/null
        printf '\033[5n' >/dev/tty
        [ "$_hn_result" = 0 ] || return 0
        [ -n "$_hn_selected" ] || return 0
        printf -v _hn_quoted '%q' "$_hn_selected"
        [ "$_hn_complete_kind" != sessions ] || _hn_quoted="--id $_hn_quoted"
        COMPREPLY=("$_hn_quoted")
    }
    for _hn_complete_cmd in ch cm hn; do
        complete -p "$_hn_complete_cmd" >/dev/null 2>&1 || complete -F _hn_complete_bash "$_hn_complete_cmd"
    done
    unset _hn_complete_cmd
fi

# Report cwd without changing the user's prompt. Splits follow cd immediately,
# including names containing spaces, Unicode, percent signs, or terminal controls.
_hn_cwd() {
    local LC_ALL=C _hn_i=0 _hn_char _hn_uri='' _hn_byte
    while [ "$_hn_i" -lt "${#PWD}" ]; do
        _hn_char=${PWD:$_hn_i:1}
        case "$_hn_char" in
            [a-zA-Z0-9/._~-]) _hn_uri="$_hn_uri$_hn_char" ;;
            *) printf -v _hn_byte '%d' "'$_hn_char"; printf -v _hn_byte '%%%02X' "$((_hn_byte & 255))"; _hn_uri="$_hn_uri$_hn_byte" ;;
        esac
        _hn_i=$((_hn_i + 1))
    done
    printf '\033]7;file://localhost%s\007' "$_hn_uri"
    if [ "${_HN_START_PICKER-}" = 1 ]; then
        unset _HN_START_PICKER
        if [ -n "${ZSH_VERSION-}" ] || [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
            _hn_request picker-ready >/dev/null || :
        fi
    fi
}
if [ -n "${ZSH_VERSION-}" ]; then
    typeset -ga precmd_functions
    precmd_functions=(${precmd_functions:#_hn_cwd} _hn_cwd)
elif [ -n "${BASH_VERSION-}" ]; then
    case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
        'declare -a '*) PROMPT_COMMAND+=(_hn_cwd) ;;
        *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }_hn_cwd" ;;
    esac
fi
