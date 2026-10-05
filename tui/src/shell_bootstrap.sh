# A private rc overlay sources the user's normal files and then our helpers.
# ZDOTDIR is restored before user code runs; nested shells use normal startup.
_hn_rc=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/hn-shell.XXXXXXXX") || exit 1
export _HN_RC="$_hn_rc"
cat > "$_hn_rc/integration" <<'HN_INTEGRATION_EOF'
@INTEGRATION@
HN_INTEGRATION_EOF
case "${SHELL##*/}" in
    zsh)
        export _HN_ZDOTDIR_SET="${ZDOTDIR+x}" _HN_ZDOTDIR="${ZDOTDIR-}"
        cat > "$_hn_rc/.zshenv" <<'HN_ZSHENV_EOF'
if [ "$_HN_ZDOTDIR_SET" = x ]; then export ZDOTDIR="$_HN_ZDOTDIR"; else unset ZDOTDIR; fi
[[ ! -f "${ZDOTDIR:-$HOME}/.zshenv" ]] || source "${ZDOTDIR:-$HOME}/.zshenv"
export _HN_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
export ZDOTDIR="$_HN_RC"
HN_ZSHENV_EOF
        cat > "$_hn_rc/.zprofile" <<'HN_ZPROFILE_EOF'
ZDOTDIR="$_HN_USER_ZDOTDIR"
[[ ! -f "$ZDOTDIR/.zprofile" ]] || source "$ZDOTDIR/.zprofile"
_HN_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$_HN_RC"
HN_ZPROFILE_EOF
        cat > "$_hn_rc/.zshrc" <<'HN_ZSHRC_EOF'
ZDOTDIR="$_HN_USER_ZDOTDIR"
# macOS /etc/zshrc derives history from ZDOTDIR before this file runs.
case "${HISTFILE-}" in "$_HN_RC/"*) HISTFILE="$ZDOTDIR/${HISTFILE##*/}" ;; esac
[[ ! -f "$ZDOTDIR/.zshrc" ]] || source "$ZDOTDIR/.zshrc"
_HN_USER_ZDOTDIR="$ZDOTDIR"
source "$_HN_RC/integration"
ZDOTDIR="$_HN_RC"
HN_ZSHRC_EOF
        cat > "$_hn_rc/.zlogin" <<'HN_ZLOGIN_EOF'
ZDOTDIR="$_HN_USER_ZDOTDIR"
[[ ! -f "$ZDOTDIR/.zlogin" ]] || source "$ZDOTDIR/.zlogin"
if [ "$_HN_ZDOTDIR_SET" != x ] && [ "$ZDOTDIR" = "$HOME" ]; then unset ZDOTDIR; fi
rm -rf -- "$_HN_RC"
unset _HN_RC _HN_ZDOTDIR _HN_ZDOTDIR_SET _HN_USER_ZDOTDIR
HN_ZLOGIN_EOF
        export ZDOTDIR="$_hn_rc"
        exec "$SHELL" -l -i ;;
    bash)
        cat > "$_hn_rc/bashrc" <<'HN_BASHRC_EOF'
[[ ! -f "$HOME/.bashrc" ]] || source "$HOME/.bashrc"
source "$_HN_RC/integration"
rm -rf -- "$_HN_RC"
unset _HN_RC
HN_BASHRC_EOF
        exec "$SHELL" --rcfile "$_hn_rc/bashrc" -i ;;
    *)
        rm -rf -- "$_hn_rc"
        printf '%s\n' 'ch and cm currently need zsh or bash. Your normal shell is available.' >&2
        exec "$SHELL" -i ;;
esac
