# vi → Vim → Neovim: how the screen changed, and who each one is for

Research date: 26 September 2026.
Scope: what a person sees on screen, mainly with no user configuration, and how that changed. Editing features, plugins and scripting are mentioned only where they change the screen.
Versions checked: POSIX.1-2024 (`vi`, `ex`); nvi as shipped by OpenBSD and FreeBSD 14.3; BusyBox 1.38 `vi`; the traditional BSD/System V vi as preserved in the "Heirloom" ex-vi; Vim 9.2 (released 14 Feb 2026; help files dated Sep 2026; 9.3 in development); Neovim 0.12.5 (23 Aug 2026).
Links are inline. "Unknown" means I could not establish it from a source. Anything marked "inference" is my reading, not a sourced fact.

---

## Summary

- **vi's screen (1977 on):** text fills the screen, rows past the end of the file show `~`, rows it chose not to draw show `@`, and one bottom line is both the `:`/`/` input line and the message line. There is no status line, no ruler, no colour, no line numbers, and no mode indicator unless you `:set showmode` (POSIX default: unset). nvi (4.4BSD) later added a ruler, incremental search, horizontal scrolling and split screens, all off by default.
- **Vim kept that screen and the key language.** It added screen elements that appear only when you use a feature: status lines when you split (3.0, 1994), a tab line when you open a second tab (7.0, 2006), popup menus while completing (7.0), syntax colours after `:syntax on` (5.0, 1998). From 5.0 (1998) through 7.4, Vim with no vimrc started in `'compatible'` mode and looked like vi: no `-- INSERT --`, no ruler, no colours. `defaults.vim` in 8.0 (2016) turned on syntax, ruler, showcmd, wildmenu, incremental search and the mouse. 9.2 (2026) made ruler, showcmd and wildmenu built-in defaults. Vim still shows no status line with one window, no line numbers and no search highlighting by default.
- **Neovim kept Vim's screen and almost all its keys, but changed the defaults in its first release (0.1, Nov 2015):** status line always on, `hlsearch`, `incsearch`, `wildmenu`, and syntax on from 0.1.4. It then turned the UI into a protocol, so external UIs can draw the command line, popup menu, tab line, messages and each window themselves. It added floating windows (0.4, 2019), LSP diagnostics as signs, virtual text and floats (0.5–0.6, 2021), a global status line (0.7), a winbar and `cmdheight=0` (0.8), a status column (0.9), and a new default colour scheme with truecolour detection (0.10, 2024). 0.12 (2026) added a default status line that shows diagnostics and progress, and an experimental replacement for the message and command-line area.
- **In practice, a distribution or a set of plugins decides what a Neovim screen looks like, not Neovim itself.** LazyVim, NvChad, AstroNvim and kickstart.nvim add a start dashboard, buffer tabs, a styled status line, a file tree, icons and popup key hints. LazyVim also floats the command line. LazyVim sets `laststatus=3`, relative line numbers, an always-on sign column, `showmode=false` and the tokyonight theme.
- **Audiences (Stack Overflow survey, IDE question):** in 2025, 24.3% of the 26,143 people who answered used Vim and 14.0% used Neovim. Neovim was the most "loved" or "admired" development environment every year from 2021 to 2025 (74–83%); Vim scored 59–70%. In the raw 2025 data, Neovim use drops from 24.5% of 18–24-year-olds to 7.9% of 45–54-year-olds. Vim stays between 24% and 27% across the same ages. About three-quarters of Vim users and two-thirds of Neovim users also use VS Code.
- **In 2026, "vi" is mostly a name.** Debian and Ubuntu base installs run Vim-tiny in `compatible` mode. Fedora runs Vim-minimal with a ruler, Alpine runs BusyBox vi, FreeBSD and OpenBSD run nvi, and macOS runs Vim 9.1. Arch replaced the traditional vi with Vim in 2026 because the old code "no longer builds". A brief switch to full Vim was reverted to Vim's vi-compatible mode after users objected.
- **The pattern:** each transition kept the vi key language, changing only a handful of keys, and kept the vi screen layout. The look changed through defaults and through screen elements that appear on use. Visible default changes drew complaints each time: Vim 8's mouse and auto-indent on Debian in 2016, and Neovim's `mouse=a` in 2015–17 and its 2023 colour scheme. The projects kept most of these changes and added ways to opt out. The mouse was pulled back in both: Vim limited `mouse=a` to xterm-like terminals in 2019, and Neovim removed it in 0.2, then brought it back in 0.8 with a right-click menu. Later, features moved from Neovim back into Vim: the terminal, popup command-line completion, virtual text, and most of the new defaults.

---

## 1. vi

### 1.1 What is on the screen

- **Text rows, and `~` past the end of the file.** Joy and Horton's *An Introduction to Display Editing with Vi* (4.4BSD USD:12) says: "the editor will place only the character `~' on each remaining line. This indicates that the last line in the file is on the screen" ([paper §2](https://docs-archive.freebsd.org/44doc/usd/12.vi/paper-2.html)). POSIX requires the same: such rows "shall be displayed as a single <tilde> ('~') character" ([POSIX vi](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/vi.html)).
- **`@` placeholder rows.** "The editor only puts full lines on the display; if there is not enough room on the display to fit a logical line, the editor leaves the physical line empty, placing only an @ on the line as a place holder." On dumb terminals, deleted lines were left as `@` until `^R` redrew the screen ([paper §8](https://docs-archive.freebsd.org/44doc/usd/12.vi/paper-8.html), [§5](https://docs-archive.freebsd.org/44doc/usd/12.vi/paper-5.html)). POSIX keeps both uses ([POSIX vi](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/vi.html)).
- **One bottom line for commands and messages.** POSIX: "The last line of the screen shall be used to report errors or display informational messages. It shall also be used to display the input for 'line-oriented commands' (/, ?, :, and !)". The command character serves as the prompt. If a shell escape overwrites the screen, vi waits for a key before redrawing ([POSIX vi](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/vi.html)).
- **No status line, ruler, colour or line numbers.** None of these is described in POSIX. Position is shown only on request: `^G` "shall be equivalent to the ex file command", which reports the file name, current line, number of lines, and whether the file is modified or read-only ([POSIX vi](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/vi.html), [POSIX ex `file`](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/ex.html)).
- **No mode indicator by default.** POSIX lists `showmode` as "[Default unset]". When it is set, "the current mode that the editor is in shall be displayed on the last line of the display" ([POSIX ex, Edit Options](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/ex.html)). The traditional BSD/System V code, preserved as Heirloom ex-vi, prints `INSERT MODE`, `APPEND MODE`, `CHANGE MODE`, `OPEN MODE` or `REPLACE MODE` "in the window's lower right corner" ([ex-vi manual](https://ex-vi.sourceforge.net/ex.html), [source `ex_vops2.c`](https://github.com/n-t-roff/heirloom-ex-vi/blob/master/ex_vops2.c)). Oracle's Solaris guide: "Because vi doesn't indicate which mode you're currently in, distinguishing between command mode and entry mode is probably the single greatest cause of confusion among new vi users" ([Oracle](https://docs.oracle.com/cd/E19253-01/806-7612/editorvi-5/index.html)).
- **Built for slow terminals.** "On terminals which run at speeds greater than 1200 baud the editor uses the full terminal screen. On terminals which are slower than 1200 baud … the editor uses 8 lines as the default window size. At 1200 baud the default is 16 lines." Terminals that cannot move the cursor get "open mode", which shows one line at a time ([paper §8](https://docs-archive.freebsd.org/44doc/usd/12.vi/paper-8.html)). Wikipedia cites Joy on the 300-baud modem and the ADM-3A keyboard behind the terse commands and `hjkl` ([Wikipedia: vi](https://en.wikipedia.org/wiki/Vi_(text_editor))).
- **Nothing else.** No mouse, no split windows (in classic vi), no syntax colour. No intro screen is documented in POSIX, the Joy/Horton paper or the nvi man page.

### 1.2 Options that change the screen

| Option (abbr.) | Default | What it changes on screen | Source |
|---|---|---|---|
| `number` (`nu`) | off | Line number in front of each line | [POSIX ex](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/ex.html) |
| `list` | off | Tabs as `^I`, line ends as `$` | POSIX ex; [paper §8](https://docs-archive.freebsd.org/44doc/usd/12.vi/paper-8.html) |
| `showmode` (`smd`) | off | Mode name on the last line (traditional vi: bottom right) | POSIX ex; [ex-vi](https://ex-vi.sourceforge.net/ex.html) |
| `showmatch` (`sm`) | off | Cursor jumps briefly to the matching `(` or `{` | POSIX ex |
| `window`, `w300`/`w1200`/`w9600` | set by line speed | How many rows are redrawn | POSIX ex; ex-vi |
| `redraw`, `slowopen` | off / depends on terminal | How much is redrawn while typing on slow or dumb terminals | POSIX ex; ex-vi |
| `flash` / `errorbells` | `flash` on (ex-vi) / `errorbells` off | Screen flash instead of a beep | ex-vi; POSIX ex |
| `terse`, `report` | off, 5 | Shorter error messages; line count at which "N lines changed" is reported | POSIX ex |
| `tabstop`, `wrapmargin` | 8, 0 | Tab width; automatic line wrap | POSIX ex |

### 1.3 Later implementations of vi

- **nvi** ("The nex/nvi replacements for the ex/vi editor first appeared in 4.4BSD"). Its screen options are all off by default ([OpenBSD vi(1)](https://man.openbsd.org/vi.1), [FreeBSD vi(1)](https://man.freebsd.org/cgi/man.cgi?query=vi&sektion=1&manpath=FreeBSD+14.3-RELEASE)):
  - `ruler` "Display a row/column/percentage ruler on the colon command line"
  - `showmode` "Display the current editor mode and a 'modified' flag"
  - `searchincr` makes `/` and `?` incremental
  - `leftright` and `sidescroll` scroll sideways instead of wrapping
  - split screens: capitalise `:e`, `:n`, `:fg`, `:ta` or `:vi` and "the current screen is split"; `^W` moves between screens
  - `cedit` edits the colon-command history; `filec` (default Tab on OpenBSD) completes file names on the colon line

  The man page's advice to beginners: "The command you should enter as soon as you start editing is: `:set verbose showmode`" ([OpenBSD vi(1)](https://man.openbsd.org/vi.1)).
- **BusyBox vi** always writes a status line on the last line, in the format `%c %s%s%s %d/%d %d%%`. That is a mode letter (`-` command, `I` insert, `R` replace), the file name, `[Readonly]`/`[Modified]`, and current/total lines with a percentage. `:set` knows only `ai`, `et`, `fl`, `ic`, `sm` and `ts` ([editors/vi.c](https://github.com/mirror/busybox/blob/master/editors/vi.c)). It is the only vi here that shows the mode by default.

### 1.4 What runs when you type `vi` in 2026

| System | What `vi` is | What you see with no user config | Source |
|---|---|---|---|
| POSIX | Required "on systems that both support the User Portability Utilities option and define the POSIX2_CHAR_TERM symbol. On other systems it is optional." | §1.1 | [POSIX vi](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/vi.html) |
| Debian / Ubuntu base install | `vim.tiny` (package vim-tiny, Priority: important). "This package's sole purpose is to provide the vi binary for base installations." | `/etc/vim/vimrc.tiny` sets `compatible` "to provide a Vim environment as compatible with the original vi as possible": no mode indicator, no ruler, no colour | [package](https://packages.debian.org/trixie/vim-tiny), [control](https://sources.debian.org/src/vim/2:9.1.1230-2/debian/control), [vimrc.tiny](https://sources.debian.org/src/vim/2:9.1.1230-2/debian/tiny/vimrc.tiny.in) |
| Debian / Ubuntu with full `vim` installed | `vim.basic` takes over the `vi` link (alternatives priority 30 vs 15) | Vim plus `defaults.vim` (§2.3) | [vim.alternatives](https://sources.debian.org/src/vim/2:9.1.1230-2/debian/vim.alternatives), [vim-tiny.alternatives](https://sources.debian.org/src/vim/2:9.1.1230-2/debian/vim-tiny.alternatives) |
| Fedora / RHEL family | `vim-minimal` ("providing the commands vi, view, ex, rvi, and rview"), built to read `/etc/virc` | `/etc/virc` sets `nocompatible` and `ruler`, so `-- INSERT --` and a ruler appear | [package](https://packages.fedoraproject.org/pkgs/vim/vim-minimal/), [virc](https://src.fedoraproject.org/rpms/vim/blob/rawhide/f/virc), [vim.spec](https://src.fedoraproject.org/rpms/vim/blob/rawhide/f/vim.spec) |
| Arch Linux | Since Jan 2026, `ex-vi-compat` replaces the traditional vi, "which is unmaintained and no longer builds". Today `vi` is a script that runs `vim -C -u …`, reading only `EXINIT` or `.exrc` "as required by POSIX". In Feb 2026 it was briefly a plain symlink to `vim`. That was reverted on 21 Mar 2026 after a merge request titled "`vi` no longer opens Vim in compatibility mode" | Vim in `compatible` mode: a vi-like screen | [package](https://archlinux.org/packages/extra/any/ex-vi-compat/), [forum](https://bbs.archlinux.org/viewtopic.php?id=311868), [commit mail](https://www.mail-archive.com/arch-commits@lists.archlinux.org/msg970183.html), [vi.sh](https://gitlab.archlinux.org/archlinux/packaging/packages/ex-vi-compat/-/blob/main/vi.sh), [commit log](https://gitlab.archlinux.org/archlinux/packaging/packages/ex-vi-compat/-/commits/main) |
| Alpine and other BusyBox systems | BusyBox `vi` (`CONFIG_VI=y` in Alpine's BusyBox 1.38 config) | BusyBox status line | [busyboxconfig](https://gitlab.alpinelinux.org/alpine/aports/-/blob/master/main/busybox/busyboxconfig) |
| FreeBSD 14.3, OpenBSD | nvi | nvi defaults (all extras off) | [FreeBSD](https://man.freebsd.org/cgi/man.cgi?query=vi&sektion=1&manpath=FreeBSD+14.3-RELEASE), [OpenBSD](https://man.openbsd.org/vi.1) |
| macOS 26.6.2 | `/usr/bin/vi` → `vim` (Vim 9.1, patches 1–1752) | The system vimrc sets `nocompatible` and `skip_defaults_vim=1`. Result: no syntax colour, no ruler, no incremental search, no mouse; `showmode`, `showcmd` and `wildmenu` on | Checked on this machine: `/usr/share/vim/vimrc` and `vi -es '+set ruler? showcmd? …'` |

---

## 2. Vim

### 2.1 What Vim kept from vi

- **The layout.** Rows past the end show `~` (`fillchars` default `eob:~`). The last line is the command and message line. A last line that does not fit shows `@` (`fillchars` `lastline:@`; `display` defaults to empty). With one window there is no status line: `laststatus` defaults to 1, meaning "only if there are at least two windows". `number` and `hlsearch` are still off by default ([options.txt](https://vimhelp.org/options.txt.html)).
- **The key language.** "Although Vim is 99% Vi compatible, some things in Vi can be considered to be a bug, or at least need improvement. But still, Vim starts in a mode which behaves like the 'real' Vi as much as possible" ([vi_diff.txt](https://vimhelp.org/vi_diff.txt.html)). The README says: "Still, Vi compatibility is maintained, those who have Vi 'in the fingers' will feel at home" ([README](https://github.com/vim/vim/blob/master/README.md)). `'compatible'` is still on in the C defaults ("default on, off when a vimrc or gvimrc file is found, reset in defaults.vim"). `'cpoptions'` flags keep individual vi behaviours ([options.txt](https://vimhelp.org/options.txt.html)).
- **What Vim dropped.** Open mode ("Vim does not support open mode, since it's not really useful"). The options `redraw`, `slowopen`, `w300`/`w1200`/`w9600`, `flash` and `optimize` are accepted but do nothing ([vi_diff.txt §1–2](https://vimhelp.org/vi_diff.txt.html)).
- **vi's `showmode`,** but on by default in Vim: `-- INSERT --` at the bottom left. In `'compatible'` mode it is off, as in vi ([options.txt](https://vimhelp.org/options.txt.html)).

### 2.2 What Vim changed or added, by version

Sources: Bram Moolenaar's 2000 talk ([vimstory.pdf](http://moolenaar.net/vimstory.pdf)), the release table on [Wikipedia](https://en.wikipedia.org/wiki/Vim_(text_editor)), and the help files [version5](https://vimhelp.org/version5.txt.html), [version6](https://vimhelp.org/version6.txt.html), [version7](https://vimhelp.org/version7.txt.html), [version8](https://vimhelp.org/version8.txt.html) and [version9](https://vimhelp.org/version9.txt.html) (patch numbers are from these files).

| Year | Version | Visible change | On by default? |
|---|---|---|---|
| 1991 | 1.14 | First public release (Amiga) | — |
| 1992 | 1.22 | Port to Unix; renamed "Vi IMproved". The sources disagree on the name: Bram's 2000 slides tie the rename to 1.22, while Wikipedia calls 2.0 (Dec 1993) the "first release using 'Vi IMproved'" | — |
| by 1994 | 3.0 or earlier | Visual mode: `v`, `V`, `CTRL-V` selections, shown highlighted. The 4.0 notes change how these keys behave "in Visual mode", so it existed in 3.0; first version unknown ([version4](https://vimhelp.org/version4.txt.html)) | It is a command |
| 1994 | 3.0 | Multiple windows (horizontal splits). Today each window has a status line once there are two or more | When used |
| 1996 | 4.0 | GUI (gVim): menus, scrollbars, mouse | GUI only |
| 1998 | 5.0 | Syntax highlighting via `:syntax on`; `hlsearch`; `guicursor` (cursor shape per mode, GUI); `background`; `:intro` and a startup message when Vim starts without a file; Win32 GUI; `'compatible'` becomes the default (§2.3) | Syntax and hlsearch: no |
| 1998 | 5.2 | GUI popup (right-click) menu, dialogs, file browser; `listchars` | GUI; no |
| 1999 | 5.4 | `wildmenu` (completion matches listed on the status line), `statusline`, `rulerformat`; GTK GUI with toolbar | No |
| 2001 | 6.0 | Vertical splits, folding, diff mode, `:colorscheme`, signs (`:sign`), command-line window (`q:`, "like Nvi") | When used |
| 2006 | 7.0 | Tab pages and tab line (plain text or GUI tabs); Insert-mode completion popup menu (the notes call it "rather primitive"); spell-error highlighting; `cursorline`/`cursorcolumn`; matching-bracket highlight (matchparen plugin); `numberwidth` | Tab line with 2+ tabs; matchparen on unless `'compatible'` ([matchparen.vim](https://github.com/vim/vim/blob/master/runtime/plugin/matchparen.vim)); others no |
| 2010 | 7.3 | `relativenumber`, `colorcolumn`, conceal | No |
| 2014 | 7.4.338 | `breakindent` | No |
| 2016 | 7.4.1799 | `termguicolors` (24-bit colour in terminals) | No |
| 2016 | 7.4.2201 | `signcolumn` option | `auto` |
| 2016 | 8.0 | `defaults.vim` when there is no vimrc: syntax on, `ruler`, `showcmd`, `wildmenu`, `incsearch`, `scrolloff=5`, `display=truncate` (`@@@`), `mouse=a`; `Q` mapped to `gq` ([defaults.vim @ v8.0.0000](https://github.com/vim/vim/blob/v8.0.0000/runtime/defaults.vim)) | Yes, without a vimrc |
| 2017 | 8.0.1238 | With `incsearch` and `hlsearch` both set, all matches highlight while you type | — |
| 2018 | 8.1 | `:terminal` window | When used |
| 2019 | 8.1.2226 | `defaults.vim` uses `mouse=nvi` outside xterm so terminal copy/paste works | — |
| 2019 | 8.2 | Popup windows (text drawn over other windows; `wincolor`); text properties | For plugins |
| 2022 | 8.2.4325 / 9.0 | Command-line completion in a popup menu (`wildoptions=pum`); new versions of the bundled colour schemes ([vim/colorschemes](https://github.com/vim/colorschemes)) | No |
| 2024 | 9.1 | Virtual text ("useful for language server features (e.g. inlay hints)"); `smoothscroll`; undercurl, double, dotted and dashed underlines; middle-click closes a tab | No |
| 2024–25 | 9.1.0862 (Nov 2024), 9.1.0895, 9.1.0899, 9.1.1550 (Jul 2025), [commit ba36510](https://github.com/vim/vim/commit/ba36510920654a52d8b5908f5a61c6969bb31942) (Sep 2025) | `wildmenu`, `history=200`, `backspace=indent,eol,start`, `showcmd` (now also on Unix) and `ruler` become built-in defaults | Yes, in `nocompatible` |
| 2026 | 9.2 (14 Feb 2026) | The defaults above ship. Also: `tabpanel` (a vertical tab line); completion menu highlights matched text and item kinds; Insert-mode autocompletion; inline diff highlighting in the default `diffopt`; "Improved visual highlighting"; Wayland; GTK font 12 pt; optional packages for commenting, nohlsearch, highlight-on-yank and OSC 52; `:Tutor`; the intro points to Kuwasha instead of ICCF | Mixed |
| 2026 | 9.3 (in development) | Experimental GTK 4 GUI; popup transparency | — |

Other visible facts:

- **Built-in colours.** The completion popup (`Pmenu`) is LightMagenta on a light background and Magenta on a dark one. The status line is reverse bold, search matches have a yellow background, and line numbers are brown ([highlight.c](https://github.com/vim/vim/blob/master/src/highlight.c)). The 9.0 notes describe new versions of the bundled schemes, not a change to these built-in defaults.
- **Terminal cursor shape.** Vim does not change the terminal cursor's shape by mode unless you set `t_SI`/`t_EI`. The help says: "These are not standard termcap/terminfo entries, you need to set them yourself" ([term.txt](https://vimhelp.org/term.txt.html#termcap-cursor-shape)). The GUI has changed the cursor shape per mode since 5.0 (`guicursor`).
- **Intro screen.** Current text: "VIM - Vi IMproved", the version, "by Bram Moolenaar et al.", "Vim is open source and freely distributable", then a line about Uganda/Kuwasha or "Sponsor Vim development!" (two starts out of four), then help hints. In `'compatible'` mode it adds: "Running in Vi compatible mode / type :set nocp<Enter> for Vim defaults / type :help cp-default<Enter> for info on this" ([version.c](https://github.com/vim/vim/blob/master/src/version.c); the compatible-mode block was already in [7.0](https://github.com/vim/vim/blob/v7.0/src/version.c)).

### 2.3 With no vimrc: how close Vim looks to vi, over time

| Vim version (years) | What "no user vimrc" means | What the screen shows |
|---|---|---|
| 4.x (1996–98) | `'compatible'` off by default: "In version 4.x the default value for the 'compatible' option was off" ([version5 `cp-default`](https://vimhelp.org/version5.txt.html#cp-default)). Versions before 4.x: unknown | Vim defaults (details unknown) |
| 5.0–7.4 (1998–2016) | `'compatible'` on by default, "switched off if Vim finds a vimrc file." Bram expected that "a lot of people switching from Vim 4.x to 5.0 will find this annoying" ([version5](https://vimhelp.org/version5.txt.html#cp-default)) | Looks like vi: no `-- INSERT --`, no ruler, no `showcmd`, no colour, no bracket highlight, no status line. The intro screen says "Running in Vi compatible mode". Visual mode, splits and multi-level undo still work (undo "also in Vi compatible mode" since 5.0) |
| 8.0–9.1 (2016–2026) | `defaults.vim` is sourced when "no user vimrc file is found" (not with `-u NONE` or `-C`). The 8.0 notes: "Thus Vim no longer starts up in Vi compatible mode" ([starting.txt](https://vimhelp.org/starting.txt.html#defaults.vim), [version8](https://vimhelp.org/version8.txt.html#incompatible-8)) | Syntax colour, a ruler at the bottom right, partial commands, wildmenu, incremental search, 5 lines of scroll context, the mouse (`a` in xterm-like terminals, `nvi` elsewhere since 8.1.2226), bracket highlight. Still no status line, no line numbers, no search highlighting |
| 9.2 (2026 on) | `ruler`, `showcmd`, `wildmenu`, `history` and `backspace` are now C defaults for `nocompatible`; `defaults.vim` keeps the rest ([version9 `changed-9.2`](https://vimhelp.org/version9.txt.html#changed-9.2)) | Same screen as above, but ruler, showcmd and wildmenu survive when you create a vimrc |

Two catches:

- **A vimrc switches `defaults.vim` off.** As soon as you create any `~/.vimrc`, `defaults.vim` is no longer loaded. The help recommends adding `unlet! skip_defaults_vim` and `source $VIMRUNTIME/defaults.vim` ([starting.txt](https://vimhelp.org/starting.txt.html#defaults.vim)). Before 9.2, a user with a one-line vimrc lost the ruler, showcmd and syntax colours.
- **A system-wide vimrc does not switch off `'compatible'`.** Only a user vimrc does: "This doesn't happen for the system-wide vimrc or gvimrc file" ([options.txt](https://vimhelp.org/options.txt.html)). So distribution files decide the look:
  - Debian and Ubuntu `vim`: `/etc/vim/vimrc` loads `debian.vim` ("NOTE: debian.vim sets 'nocompatible'"), leaves `syntax on` commented out, and warns that `defaults.vim` "will override any settings in these files" ([vimrc](https://sources.debian.org/src/vim/2:9.1.1230-2/debian/runtime/vimrc)).
  - Fedora `vim`: `/etc/vimrc` sets `nocompatible`, `ruler`, `showcmd`, `wildmenu`, `incsearch` and `scrolloff=5`, plus `syntax on` and `hlsearch` when the terminal has colours ([vimrc](https://src.fedoraproject.org/rpms/vim/blob/rawhide/f/vimrc)). Fedora's Vim therefore highlights search matches by default, which upstream Vim does not.
  - macOS: `skip_defaults_vim=1` (§1.4).

  "Vim with no vimrc" gives three different screens on Debian, Fedora and macOS.

---

## 3. Neovim

### 3.1 What Neovim kept from Vim

- "Nvim differs from Vim in many ways, although editor and Vimscript (not Vim9script) features are mostly identical" ([vim_diff.txt](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/vim_diff.txt)).
- **The screen:** the cell grid, `~` rows, the last-line command line, `-- INSERT --`, the `statusline`/`tabline` format language, the highlight group names (with new ones added), the hit-enter prompt (until the experimental `ui2`), and the intro screen layout. The intro still carries the "Help poor children in Uganda!" line. 0.12 adds a small box-drawn "N" logo and horizontal rules ([version.c 0.11.0](https://github.com/neovim/neovim/blob/v0.11.0/src/nvim/version.c), [0.12.5](https://github.com/neovim/neovim/blob/v0.12.5/src/nvim/version.c)).
- **Not kept:** `'compatible'` ("is always disabled"). The charter lists POSIX vi conformance and Vim9script as non-goals ([charter](https://neovim.io/charter/)).

### 3.2 Default changes that are visible on screen

Release dates are from the GitHub release and tag data. Sources: the defaults lists in [vim_diff.txt at v0.1.0](https://github.com/neovim/neovim/blob/v0.1.0/runtime/doc/vim_diff.txt), [v0.1.4](https://github.com/neovim/neovim/blob/v0.1.4/runtime/doc/vim_diff.txt), [v0.2.0](https://github.com/neovim/neovim/blob/v0.2.0/runtime/doc/vim_diff.txt) and [v0.12.5](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/vim_diff.txt); newsletters [#7](https://neovim.io/news/2016/11/), [#8](https://neovim.io/news/2017/12/), [#9](https://neovim.io/news/2020/04/), [#10](https://neovim.io/news/2020/10/) and [2022](https://neovim.io/news/2022/12/); release notes for [0.3.0](https://github.com/neovim/neovim/releases/tag/v0.3.0), [0.4.0](https://github.com/neovim/neovim/commit/e2cc5fe09d98ce1ccaaa666a835c896805ccc196), [0.6.0](https://github.com/neovim/neovim/releases/tag/v0.6.0) and [0.8.0](https://github.com/neovim/neovim/releases/tag/v0.8.0); and the news files [0.9](https://neovim.io/doc/user/news-0.9.html), [0.10](https://neovim.io/doc/user/news-0.10.html), [0.11](https://neovim.io/doc/user/news-0.11.html) and [0.12](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/news.txt).

| Version (date) | Visible default change |
|---|---|
| 0.1.0 (1 Nov 2015) | `laststatus=2` (status line always shown), `hlsearch`, `incsearch`, `wildmenu`, `mouse=a`, `listchars` "tab:> ,trail:-,nbsp:+", `display=lastline`; built-in `:terminal` |
| 0.1.4 (25 Apr 2016) | Syntax highlighting and `filetype plugin indent on` by default |
| 0.2.0 (1 May 2017) | `mouse=a` removed. `ruler`, `showcmd` and `belloff=all` on. "`guicursor` now works in the TUI" (bar cursor in Insert mode) |
| 0.3 (2018) | `fillchars` defaults: window separator `│`, fold filler `·`. `sidescroll=1`. Long messages scroll only the message area (`msgsep`). 0.3.2: `background=dark` |
| 0.4.0 (15 Sep 2019) | `wildoptions=pum`: command-line completion in a vertical popup menu ("In fact, that's the default!"). The terminal UI detects the terminal's background colour. Visual mode highlights the character under the cursor |
| 0.6.0 (30 Nov 2021) | `inccommand=nosplit` (live `:s` preview in the buffer), `hidden`, `Y` = `y$`, `CTRL-L` also clears search highlighting |
| 0.7.0 (15 Apr 2022) | `Q` replays the last macro (in Vim it enters Ex mode) |
| 0.8.0 (30 Sep 2022) | `mouse=nvi` and `mousemodel=popup_setpos` (right-click menu); `&` = `:&&` |
| 0.10.0 (16 May 2024) | New default colour scheme, "Nvim branded" and accessible; the old one is `:colorscheme vim`. `termguicolors` on "when Nvim is able to determine that the host terminal emulator supports 24-bit color". Tree-sitter highlighting for Lua, Vim help and query files. `gc` commenting. `K` = LSP hover; `]d`, `[d`, `CTRL-W d` for diagnostics |
| 0.11.0 (26 Mar 2025) | Diagnostic virtual text off by default. LSP maps `grn`, `grr`, `gri`, `gra`, `gO`. `[q`/`]q`-style list navigation. The right-click menu gains "Open in web browser", "Go to definition" and diagnostics items. No line numbers or sign column in terminal buffers |
| 0.12.0 (29 Mar 2026) | The default status line shows `vim.diagnostic.status()`, LSP progress, a busy marker `◐` and terminal exit codes ([options.lua](https://github.com/neovim/neovim/blob/v0.12.5/src/nvim/options.lua)). Tree-sitter highlighting for Markdown. Inline diff highlighting. Intro logo |

Current full list, 0.12.5: `fillchars` "vert:│,fold:·,foldsep:│", `wildoptions` "pum,tagfile", `completeopt` "menu,popup", `belloff` "all", `mouse` "nvi", `termguicolors` on when detected, `laststatus=2`, `hlsearch`, `incsearch`, `ruler`, `showcmd` ([vim_diff.txt](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/vim_diff.txt), [options.txt](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/options.txt)).

### 3.3 New things Neovim can draw

| Version (date) | Screen element | Default? |
|---|---|---|
| 0.1 (Nov 2015) | Terminal buffers: "a mostly complete VT220/xterm-like terminal emulator" ([0.1.0 doc](https://github.com/neovim/neovim/blob/v0.1.0/runtime/doc/nvim_terminal_emulator.txt)) | When used |
| 0.1.7 (Nov 2016) | `inccommand`: live preview of `:substitute` (`split` also shows a preview window) | Opt-in until 0.6 |
| 0.2.1 (Nov 2017) | Window-local highlighting (`winhighlight`); coloured command line | Opt-in |
| 0.3.2 (Dec 2018) | Virtual text API (`nvim_buf_set_virtual_text`) | For plugins |
| 0.4 (Sep 2019) | Floating windows (`nvim_open_win`); pseudo-transparency (`winblend`, `pumblend`); several sign columns; undercurl in the terminal UI | API / opt-in |
| 0.5 (Jul 2021) | LSP client (diagnostics as signs, underlines and virtual text; hover in floats); experimental Tree-sitter highlighting; float borders and z-index; extmark decorations; a highlight-on-yank function; `init.lua` | Needs configuration |
| 0.6 (Nov 2021) | `vim.diagnostic` (virtual text, signs, underlines, floats) | Virtual text on whenever there are diagnostics, until 0.11 |
| 0.7 (Apr 2022) | Global status line, `laststatus=3`: "Instead of having one statusline per window, the global statusline always runs the full available width" | Opt-in |
| 0.8 (Sep 2022) | `winbar` ("an extra statusline at the top of each window"); `cmdheight=0` (experimental); `mousescroll`; `vim.ui_attach` (experimental: Lua code can take over messages and the command line, which noice.nvim uses) | Opt-in |
| 0.9 (Apr 2023) | `statuscolumn` (full control of the gutter); LSP semantic-token highlighting (on when the server supports it); `:Inspect` and `:InspectTree`; `splitkeep`; `showcmdloc` | Mixed |
| 0.10 (May 2024) | LSP inlay hints (turned on with `vim.lsp.inlay_hint.enable()`); `smoothscroll`; float footers; inline virtual text; OSC 8 hyperlinks | Opt-in |
| 0.11 (Mar 2025) | `winborder` (default border for floats); diagnostic `virtual_lines`; highlights for matched text in the completion menu | Opt-in / default styling |
| 0.12 (Mar 2026) | `ui2`, an experimental redesign of the message and command-line area. It "Avoids 'Press ENTER' interruptions", "Highlights the cmdline as you type", and folds long messages behind a `[+x]` marker with a pager window ([lua.txt `ui2`](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/lua.txt)). Also `pumborder`, `autocomplete`, and progress bars via OSC 9;4 | Experimental / opt-in |

### 3.4 The decoupled UI and external UIs

- **Architecture.** "The Nvim UI is 'decoupled' from the core editor: all UIs, including the builtin TUI are just plugins that connect to a Nvim server … Multiple Nvim UI clients can connect to the same Nvim editor server" ([vim_diff.txt](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/vim_diff.txt)). Since 0.9 (Apr 2023) the terminal UI runs as a separate process ([news-0.9](https://neovim.io/doc/user/news-0.9.html)).
- **Protocol.** "The default UI model is a terminal-like grid with a single, monospace font. The UI can opt-in to have windows drawn on separate grids, and have some elements ('widgets') presented by the UI itself" ([UI protocol](https://neovim.io/doc/user/api-ui-events.html)). The opt-ins:
  - `ext_cmdline`: the UI draws the command line
  - `ext_popupmenu`: the UI draws the completion menu and wildmenu
  - `ext_tabline`: the UI draws the tab line
  - `ext_messages`: the UI draws messages
  - `ext_multigrid`: each window is its own grid
  - `ext_linegrid` and `ext_hlstate`: line-based updates with detailed highlight state
  - `ext_termcolors`: the UI supplies the default colours

  Dates:
  - An externalised popup menu was in use by a Sublime Text integration by 2017.
  - The tab line, command line and wildmenu could be externalised from 0.2.1 (Nov 2017) ([newsletter #8](https://neovim.io/news/2017/12/)).
  - Line-based grid updates arrived during 0.3.x ([0.4 notes](https://github.com/neovim/neovim/commit/e2cc5fe09d98ce1ccaaa666a835c896805ccc196)).
  - Multigrid came in 0.4: "Windows are sent to UIs as distinct objects, so that UIs can control layout instead of being stuck with the classic TUI layout."
  - `ext_messages` existed by 0.4 (2019); its first release is unknown.
- **What external UIs do with it:**
  - [Neovide](https://neovide.dev/features.html) is a GPU GUI with ligatures, an "Animated Cursor … with a smear effect", pixel-smooth scrolling, animated window moves and "Blurred Floating Windows".
  - [vscode-neovim](https://github.com/vscode-neovim/vscode-neovim) "uses a fully embedded Neovim instance". VS Code handles Insert mode and draws the command line and messages in its own UI. The Neovim status line and floating windows are not shown. It requires Neovim 0.10+.
  - [Firenvim](https://github.com/glacambre/firenvim) replaces browser text areas with Neovim and lets you choose Neovim's command line, its own (`ext_cmdline`), or none.
  - Newsletter #10 (Oct 2020) lists about ten more GUIs, including Veonim, gonvim, GNvim, FVim and glrnvim ([#10](https://neovim.io/news/2020/10/)).

### 3.5 Distributions: what a Neovim screen looks like in practice

Stars are from the GitHub API on 26 Sep 2026. Creation dates are when the repository was created.

| Distribution | Repo created | Stars | What it puts on screen (per its docs or config) |
|---|---|---|---|
| [LazyVim](https://github.com/LazyVim/LazyVim) ("Transform your Neovim into a full-fledged IDE") | Dec 2022 | 27,544 | Dashboard (snacks.nvim), buffer tabs (bufferline), styled status line (lualine), noice.nvim ("completely replaces the UI for messages, cmdline and the popupmenu"), indent guides, notifications, icons ([UI plugins](https://www.lazyvim.org/plugins/ui)). Colour scheme tokyonight "moon". Options: `laststatus=3`, `number` + `relativenumber`, `signcolumn=yes`, `cursorline`, `list`, `showmode=false`, `ruler=false`, `pumblend=10`, `smoothscroll`, a custom `statuscolumn`, `mouse=a` ([options.lua](https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua)) |
| [NvChad](https://nvchad.com/docs/features) | Mar 2021 | 28,492 | base46 theming ("68 themes") with a live theme switcher, its own status line in 4 styles, "tabufline" (tabs plus buffer list), the nvdash dashboard, a key cheatsheet, terminal windows |
| [AstroNvim](https://docs.astronvim.com/) | Feb 2022 | 14,442 | "Statusline, Winbar, and Tabline with Heirline", Neo-tree file explorer, Blink completion, snacks.picker |
| [kickstart.nvim](https://github.com/nvim-lua/kickstart.nvim) ("NOT a Neovim distribution, but instead a starting point") | Jun 2022 | 31,512 | One documented `init.lua`: tokyonight-night, mini.statusline, which-key, telescope, gitsigns; `number`, `cursorline`, `signcolumn=yes`, `list`, `showmode=false`, `inccommand=split`, `scrolloff=10`, `mouse=a` ([init.lua](https://github.com/nvim-lua/kickstart.nvim/blob/master/init.lua)) |
| LunarVim / SpaceVim | 2018 / 2016 | 19,262 / 20,200 | LunarVim's last push was Jun 2025; SpaceVim is archived (GitHub API) |

What users change, by the numbers:

- **Options survey.** A community survey of Neovim options ran 22 Nov – 8 Dec 2022 (227 answers, self-selected via Reddit). It found `termguicolors` 95%, `number` 86%, `cursorline` 66%, `relativenumber` 59%, `mouse=a` 58%, `showmode=false` 57%, `laststatus=3` 54%, `signcolumn=yes` 47%, `showtabline=2` 42%, `cmdheight=0` 25% ([results](https://gist.github.com/echasnovski/fa70dc75c475369747d2a485a13303fb)).
- **Dotfyle.** Dotfyle tracks "1000+" public configs; these are counts of configs that use each plugin, as of Sep 2026. Denominator unknown. nvim-treesitter 2,524; nvim-lspconfig 2,383; telescope 1,911; nvim-web-devicons (icons) 1,850; gitsigns (sign column) 1,775; lualine (status line) 1,693; nvim-cmp (completion menu) 1,576; which-key (key-hint popup) 1,438; catppuccin 973; tokyonight 890 ([plugins](https://dotfyle.com/neovim/plugins/top), [colour schemes](https://dotfyle.com/neovim/colorscheme/top)).
- **Vim had distributions first.** spf13-vim (2010, "The ultimate vim distribution", 15,476 stars), amix/vimrc (2012, 31,812), vim-sensible (2013, "Defaults everyone can agree on") and vim-airline (2013, 17,967). Newsletter #7 credits Tim Pope's defaults as the model for Neovim's ([#7](https://neovim.io/news/2016/11/)).

### 3.6 Side by side: first launch with no configuration

| | vi (POSIX / nvi) | Vim 9.2 (no vimrc, so `defaults.vim`) | Neovim 0.12 |
|---|---|---|---|
| Intro screen | None documented | Yes: name, version, "by Bram Moolenaar et al.", sponsor or Kuwasha line, help hints; a "Vi compatible mode" block when `'compatible'` | Yes: "N" logo, version, ":help nvim if you are new", ":checkhealth", ":help news", Kuwasha line |
| Rows past end of file | `~` | `~` | `~` |
| Status line | None | None with one window; appears when you split | Always: file name, flags, diagnostics and progress when present, ruler |
| Mode indicator | None (nvi, traditional vi: optional) | `-- INSERT --` | `-- INSERT --` |
| Cursor position | `^G` on request (nvi: optional ruler) | Ruler at bottom right of the command line | Ruler inside the status line |
| Partial command | — | Shown (`showcmd`) | Shown |
| Colour | None | Syntax colour if the terminal has colours; built-in palette (magenta completion menu) | Syntax colour; "Nvim" palette; 24-bit colour when detected; Tree-sitter for Lua, help and Markdown |
| Matching bracket | `showmatch` off | Highlighted (matchparen) | Highlighted |
| Line numbers | Off | Off | Off |
| Search | Plain | Incremental; matches not kept highlighted | Incremental; all matches stay highlighted |
| `:s` preview | — | — | Live in the buffer |
| Mouse | None | On (`a` in xterm-like terminals, else `nvi`) | On (`nvi`) with a right-click menu |
| Terminal cursor shape by mode | Terminal's own | Unchanged unless configured | Bar in Insert mode |
| Window separator | — (nvi splits only horizontally) | `\|` | `│` |
| `:` Tab completion | — (nvi: file names) | Horizontal list just above the command line | Vertical popup menu |
| Completion menu | — | Popup (magenta by default) | Popup; extra info in a floating window |
| Floating windows | — | Popup windows exist, for plugins | Floats for hover and diagnostics once an LSP server is configured |
| Long messages | "Hit return" prompt | Whole screen scrolls; "Press ENTER" | Only the message area scrolls, above a separator line; "Press ENTER" (experimental `ui2` removes it) |
| Bell | Beep or flash | Beeps on some errors (e.g. `Esc` in Normal mode); `errorbells` off | Silent (`belloff=all`) |

---

## 4. Audiences

### 4.1 vi

- **Who uses it:** anyone on a machine where vi is the one editor guaranteed to exist. POSIX requires it with the User Portability Utilities option ([POSIX vi](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/vi.html)). Distributions put it in the base system: Debian's vim-tiny is Priority: important, "to provide the vi binary for base installations". Alpine gets it from BusyBox, and the BSDs from nvi (§1.4).
- **Why:** the same keys on every system, a tiny footprint, and it works on serial consoles and dumb terminals. That is inference from the design goals above, not measured.
- **How many use it:** unknown. The Stack Overflow survey lists Vim and Neovim, not vi.
- **Trend:** the historical code is fading. Arch removed the traditional vi in 2026 because it is "unmaintained and no longer builds". Vim's README now presents vim.tiny as "a (mostly) POSIX-compatible vi implementation … used by many Linux distributions as the default vi editor" ([README](https://github.com/vim/vim/blob/master/README.md)). In 2000 Bram said Vim was "Included in all Linux distributions, often as 'Vi'" and "Perhaps some people typed 'Vi' and didn't know it was actually Vim they were using" ([vimstory.pdf](http://moolenaar.net/vimstory.pdf)).

### 4.2 Vim

- **How it describes itself:** "a greatly improved version of the good old UNIX editor Vi … Still, Vi compatibility is maintained … This editor is very useful for editing programs and other plain text files" ([README](https://github.com/vim/vim/blob/master/README.md)). So it serves two groups: people with vi "in the fingers", and programmers.
- **Usage (Stack Overflow):** 24.2% (2021), 23.3% (2022), 22.3% (2023), 21.6% (2024), 24.3% (2025). Loved or admired: 66.7–69.7% from 2021 to 2024, 59.3% in 2025 (table in §4.4).
- **Who, from the raw 2025 data (§4.5):**
  - Use is flat across ages 18–64 (23.6–26.7%).
  - Use rises with coding experience, from 18.7% at 0–4 years to 27.4% at 30+.
  - 75.0% of Vim users also used VS Code; only 3.9% used no other listed tool.
  - 65.5% use a Linux distribution for professional work, against 46.1% of all respondents.

  Inference: for many people Vim is a second editor, used in terminals and on servers.
- **Stability:** Vim 9 kept legacy Vim script alongside Vim9 script, still has `'compatible'`, and changes defaults slowly. For example, `ruler` went from `defaults.vim` (2016) to a built-in default only in 2026. Bram Moolenaar died on 3 Aug 2023; 9.1 is dedicated to him, and 9.2 was released by the project team ([version9](https://vimhelp.org/version9.txt.html)).

### 4.3 Neovim

- **How it describes itself:** "Neovim is for users who want the good parts of Vim, and more." Its goals are "Extensible. Usable. Vim." and "Optimize 'out of the box', for new users but especially regular users." Its non-goals include "Turn Vim into an IDE" and "Conform to POSIX vi", and also "Limit third-party applications (such as IDEs!) built with Neovim" ([charter](https://neovim.io/charter/)). The README adds "Enable advanced UIs without modifications to the core" ([README](https://github.com/neovim/neovim/blob/master/README.md)).
- **"PDE":** "TJ DeVries (a Neovim core team member) coined the phrase 'Personalised Development Environment' or PDE" in 2022 ([Oliver Davies, Oct 2022](https://www.oliverdavies.uk/blog/neovim-personalised-development-environment)). It means an editor you configure by writing code, in place of an IDE. Agoda Engineering names a late-2022 video by DeVries, "PDE: A different take on editing code" ([Medium](https://medium.com/agoda-engineering/personalized-development-environment-pde-a-different-take-on-editing-code-0ec05b323ae6); secondary source).
- **Usage (Stack Overflow):** 5.0% (2021), 6.8% (2022), 11.9% (2023), 12.5% (2024), 14.0% (2025). It was the top loved or admired IDE every year: 82.4%, 82.9%, 81.4%, 82.7%, 74.4%.
- **Who, from the raw data (§4.5):**
  - Use falls with age. In 2025: 24.5% of 18–24, 15.7% of 25–34, 11.7% of 35–44, 7.9% of 45–54, 5.8% of 55–64 and 2.5% of 65+. In 2024, 23.6% of under-18s used it.
  - Hobbyists use it more than professionals: 23.0% vs 13.6% in 2025.
  - 67.9% also used VS Code; 9.5% used no other listed tool.
  - 63.1% use Linux for professional work.

  This supports the "younger developers" hypothesis for Neovim, and not for Vim.
- **GitHub stars (26 Sep 2026):** Neovim 102,584; Vim 40,955. This is not like-for-like: Vim's GitHub repository dates only from Aug 2015, while Neovim has been on GitHub since it began in 2014.

### 4.4 Stack Overflow survey: IDE question

"Loved" (2021–22) and "admired" (2023–25) are what the survey called the share of current users who want to keep using the tool. The question and the way the sample was drawn changed between years.

| Year | Responses to the IDE question | Vim used | Neovim used | Vim loved/admired | Neovim loved/admired | Source |
|---|---|---|---|---|---|---|
| 2021 | 82,277 | 24.19% | 4.99% | 69.7% | 82.4% (top) | [2021](https://insights.stackoverflow.com/survey/2021#section-most-popular-technologies-integrated-development-environment) |
| 2022 | 71,010 | 23.34% | 6.75% | 69.7% | 82.9% (top) | [2022](https://survey.stackoverflow.co/2022/#section-most-popular-technologies-integrated-development-environment) |
| 2023 | 86,544 | 22.29% | 11.88% | 66.7% | 81.4% (top) | [2023](https://survey.stackoverflow.co/2023/#section-most-popular-technologies-integrated-development-environment) |
| 2024 | 58,121 | 21.6% | 12.5% | 69.2% | 82.7% (top) | [2024](https://survey.stackoverflow.co/2024/technology) |
| 2025 | 26,143 | 24.3% | 14.0% | 59.3% | 74.4% (top) | [2025](https://survey.stackoverflow.co/2025/technology) |

Splits published on the same pages (Vim / Neovim):

- **Professional developers:** 2021 24.8% / 4.5%; 2022 23.7% / 6.2%; 2023 22.6% / 11.1%; 2024 21.6% / 11.4%; 2025 24.0% / 13.6%.
- **"Learning to code":** 2022 16.4% / 7.3%; 2023 16.5% / 14.0%; 2024 19.7% / 20.1%; 2025 24.0% / 23.7% (n = 1,960).

The 2026 survey opened on 23 Jun 2026 ([SO blog](https://stackoverflow.blog/2026/06/23/the-2026-developer-survey-is-now-open-for-human-developers-only/)); no results page existed on 26 Sep 2026.

### 4.5 Cross-tabs from the raw survey data

Method: I streamed the public `results.csv` files for [2024](https://github.com/StackExchange/Survey/tree/main/packages/archive/2024) and [2025](https://github.com/StackExchange/Survey/tree/main/packages/archive/2025). I counted everyone who gave a non-empty answer to the IDE question (`NEWCollabToolsHaveWorkedWith` in 2024, `DevEnvsHaveWorkedWith` in 2025). My totals are slightly different from the published ones: 57,592 vs 58,121 in 2024, and 26,019 vs 26,143 in 2025. Stack Overflow's own filter is unknown. Overall rates match: Vim 21.7% / Neovim 12.6% in 2024, 24.4% / 14.1% in 2025.

**Share using each editor, by age:**

| Age | 2024 n | 2024 Vim | 2024 Neovim | 2025 n | 2025 Vim | 2025 Neovim |
|---|---|---|---|---|---|---|
| Under 18 | 2,210 | 19.8% | 23.6% | — | — | — |
| 18–24 | 11,847 | 20.9% | 19.3% | 4,106 | 24.6% | 24.5% |
| 25–34 | 21,052 | 21.3% | 12.4% | 8,608 | 23.7% | 15.7% |
| 35–44 | 13,519 | 22.8% | 9.4% | 7,550 | 24.5% | 11.7% |
| 45–54 | 5,738 | 23.6% | 7.2% | 3,725 | 26.7% | 7.9% |
| 55–64 | 2,357 | 21.4% | 4.1% | 1,499 | 23.6% | 5.8% |
| 65+ | 628 | 18.5% | 2.1% | 407 | 16.5% | 2.5% |

**Share using each editor, by years of coding:**

| Years coding | 2024 Vim | 2024 Neovim | 2025 Vim | 2025 Neovim |
|---|---|---|---|---|
| 0–4 | 15.7% | 15.1% | 18.7% | 17.2% |
| 5–9 | 19.8% | 16.2% | 21.7% | 19.4% |
| 10–19 | 23.2% | 12.3% | 24.8% | 14.7% |
| 20–29 | 25.2% | 8.9% | 26.7% | 11.1% |
| 30+ | 25.4% | 6.6% | 27.4% | 8.2% |

**By occupation (2025 `MainBranch`), Vim / Neovim:**

- Developer by profession (n = 20,909): 24.1% / 13.6%
- Codes as a hobby (n = 829): 21.2% / 23.0%
- Learning to code (n = 829): 20.7% / 19.3%
- Former developer (n = 588): 25.2% / 8.0%

**Other tools and operating systems (2025):**

| | Vim users (n = 6,355) | Neovim users (n = 3,663) | All who answered (n = 26,019) |
|---|---|---|---|
| Also used VS Code | 75.0% | 67.9% | — |
| Used only Vim and/or Neovim | 3.9% | 9.5% | — |
| Linux for professional work* | 65.5% | 63.1% | 46.1% |
| macOS for professional work | 38.8% | 37.8% | 34.9% |
| Windows for professional work | 41.8% | 34.4% | 49.4% |

\* Linux means Ubuntu, "Linux (non-WSL)", Debian, Red Hat, Fedora, Arch, NixOS or Pop!_OS. WSL is excluded. 27.8% of Vim users also used Neovim.

### 4.6 Other signals

- **Vim user survey (2000).** For Vim 6.0, Bram ran a survey: "A long list of features was presented, and people could give points to each feature." The top ten included folding (1st), vertically split windows (2nd), better syntax highlighting (7th, 8th) and "a menu that lists all buffers" (9th). Most shipped in 6.0 ([vimstory.pdf](http://moolenaar.net/vimstory.pdf)). The later vim.org feature vote showed no votes when I checked on 26 Sep 2026 ([vote results](https://www.vim.org/sponsor/vote_results.php)).
- **Neovim.** I found no official user survey with demographics. The closest is the 2022 community options survey in §3.5.
- **Stars for distributions and GUIs** (26 Sep 2026): kickstart 31,512; NvChad 28,492; LazyVim 27,544; Neovide 15,220; AstroNvim 14,442; vscode-neovim 7,743; Firenvim 6,140.

### 4.7 Caveats

- Stack Overflow respondents are Stack Overflow users, not all developers. The number answering the IDE question fell from 86,544 (2023) to 26,143 (2025).
- The question is multi-select and asks what was "used regularly", so it does not identify a main editor.
- "Loved" and "admired" are not guaranteed to be computed the same way.
- The Neovim options survey and Dotfyle cover self-selected enthusiasts who publish their configs.

---

## 5. The pattern

### 5.1 Keys: kept, with a few contested exceptions

- **vi to Vim.** Vim's keys are a superset of vi's. Exact vi behaviour is available only in `'compatible'` mode, which sets `'cpoptions'`, and even there multi-level undo remains available (since 5.0). Changes in normal Vim mode are listed in [vi_diff.txt](https://vimhelp.org/vi_diff.txt.html):
  - `u` gives multi-level undo, with `CTRL-R` to redo
  - `<Esc>` on the command line cancels instead of executing: "This is unexpected for most people; therefore it was changed in Vim"
  - arrow keys move in Insert mode
  - `defaults.vim` maps `Q` to `gq` (8.0)
- **Vim to Neovim.** Neovim keeps Vim's keys, drops `'compatible'`, and changes or adds these default mappings:
  - `Y` = `y$` (0.6), closing a request from issue #416
  - `Q` replays the last macro (0.7)
  - `CTRL-L` also clears search highlighting (0.6)
  - `&` = `:&&` (0.8)
  - new maps: `gc` (0.10); `gr…` and `[q`/`]q` (0.11)

  All of these are mappings you can remove ([default mappings](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/vim_diff.txt)).

### 5.2 Screen: same layout, change through defaults and on-demand elements

- **What stayed.** Both kept vi's screen: `~` rows, a bottom line shared by commands and messages, the same modes, and the mode shown as text on the bottom line.
- **Vim** mostly added elements that appear only when used: status lines on split, a tab line with 2+ tabs, popup menus during completion, a wildmenu while completing commands. For 18 years (1998–2016) it started looking like vi when there was no vimrc.
- **Neovim** was the first of the three to show extra elements at startup (an always-on status line). It then added new surfaces (floats, virtual text, winbar, statuscolumn) and handed parts of the screen to external UIs through the protocol.
- **Defaults follow what users already configure:**
  - `defaults.vim` grew out of `vimrc_example.vim` (patch 7.4.2111: "Move settings from vimrc_example.vim to defaults.vim").
  - Neovim's defaults were modelled on vim-sensible ([newsletter #7](https://neovim.io/news/2016/11/)).
  - In 2022, 95% of surveyed Neovim users had set `termguicolors`; Neovim turned it on automatically in 0.10 (2024).
  - Vim 9.2 (2026) made `ruler`, `showcmd`, `wildmenu` and `backspace=indent,eol,start` built-in defaults and raised `history` to 200. Neovim had had these since 2015–17 (with `history=10000`).

### 5.3 Visible breaks and how users reacted

| When | Change | Reaction | Outcome |
|---|---|---|---|
| Vim 5.0 (1998) | `'compatible'` on by default | Bram expected that "a lot of people switching from Vim 4.x to 5.0 will find this annoying" | `'compatible'` switches off when a vimrc exists ([version5](https://vimhelp.org/version5.txt.html#cp-default)) |
| Vim 8.0 (Sep 2016) | `defaults.vim`: `mouse=a`, filetype indent, and more | Debian bugs in Sep 2016 ([#837880](https://bugs.debian.org/837880), merged with #837761, #837793 and [#839112](https://bugs.debian.org/839112)). #839112 is titled "Please revert to previous default settings": "I can't copy text from one Xterm to vim in another because the paste operation is intercepted", plus unwanted auto-indent. Admins could not disable it system-wide ([#864074](https://bugs.debian.org/864074)) | Debian documented it in NEWS.Debian (2:8.0.0022-1) and pointed admins to `skip_defaults_vim`, which already existed (patch 7.4.2319, before 8.0 shipped). Upstream later switched to `mouse=nvi` outside xterm (8.1.2226, Oct 2019) |
| Neovim 0.1 (2015) | `mouse=a` | [#5938](https://github.com/neovim/neovim/issues/5938) (Jan 2017): "X cut and paste does not work as it does in Vim versions < 8 … This stopped me from adopting neovim for over 12 months". A maintainer replied that `mouse=a` should be the default only "if we are certain the clipboard works" and floated a right-click menu | Removed in 0.2 (May 2017). Returned in 0.8 (Sep 2022) as `mouse=nvi` with a right-click menu; the current menu includes a "How-to disable mouse" item ([`default-mouse`](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/vim_diff.txt)) |
| Neovim 0.10 (May 2024; merged Dec 2023) | New default colour scheme ([#26334](https://github.com/neovim/neovim/pull/26334), after [#14790](https://github.com/neovim/neovim/issues/14790) from 2021) | [#26378](https://github.com/neovim/neovim/issues/26378): it broke older colour schemes that relied on the old default links. [#26385](https://github.com/neovim/neovim/issues/26385) (13 👍): without truecolour it used 256-colour values, "quite jarring and completely deviates from the colors used in the terminal" | Adjusted within two weeks by [#26540](https://github.com/neovim/neovim/pull/26540), which raised contrast and, without truecolour, uses the terminal's own colours 0–6 and 9–15. It resolved #26385 and the competing PR [#26389](https://github.com/neovim/neovim/pull/26389). `:colorscheme vim` restores the old look |
| Neovim 0.11 (2025) | Diagnostic virtual text off by default | Unknown | — |
| Arch Linux (Feb 2026) | `vi` became a plain symlink to full `vim`, so it used the user's vimrc and Vim defaults | A merge request titled "`vi` no longer opens Vim in compatibility mode" (contents not readable: the page is behind a bot wall) | Reverted on 21 Mar 2026 to a script running `vim -C`, which reads `EXINIT`/`.exrc` "as required by POSIX" ([commit log](https://gitlab.archlinux.org/archlinux/packaging/packages/ex-vi-compat/-/commits/main)) |
| Vim 9.2 (2026) | Built-in `ruler`, `showcmd`, `wildmenu` | Unknown | — |

### 5.4 Convergence

Neovim's help has a list of Neovim features "later integrated into Vim": `fillchars` `eob`, `wildoptions=pum`, `<Cmd>`, `WinClosed`/`WinScrolled`, unlimited `%=` sections in the status line, `diffopt` linematch, and vim-tutor mode ([vim_diff.txt, "Upstreamed features"](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/vim_diff.txt)). Vim also shipped its own versions of things Neovim had first:

| Feature | Neovim | Vim |
|---|---|---|
| Terminal window | 0.1, 2015 | 8.1, 2018 |
| Windows drawn over text (Vim popups vs Neovim floats; different APIs) | 0.4, Sep 2019 | 8.2, Dec 2019 |
| Virtual text | 0.3.2, 2018 | 9.1, 2024 |
| Optional commenting, highlight-on-yank and OSC 52 packages, plus `:Tutor` | Built in by 0.10 (2024) | 9.2, 2026 |

Movement also runs the other way: `smoothscroll` was added to Vim first (patch 9.0.0640, 2022; shipped in 9.1) and reached Neovim in 0.10 (2024). Both editors added Insert-mode autocompletion in 2026 (Vim 9.2, Neovim 0.12 `autocomplete`).

### 5.5 What held across both transitions

1. **The key language survived.** Each project changed a handful of keys, and in both the changes can be undone (`'compatible'` or `'cpoptions'` in Vim; unmapping in Neovim).
2. **The vi screen survived.** `~`, the bottom command line, text mode names, and no extra elements until you ask for them. Neovim's always-on status line (2015) is the first break with "nothing until you ask".
3. **Changes to how the screen looks and behaves drew the pushback.** The mouse, colours and auto-indent all did. Each project kept most of its changes and added a way out (`skip_defaults_vim`, `:colorscheme vim`, `set mouse=`, the "How-to disable mouse" menu item). The mouse default was pulled back in both. Where the command is called `vi`, people expect vi. Arch's 2026 revert, and Debian running `vim.tiny` in `compatible` mode, point that way.
4. **In Neovim, new looks happen outside the core.** The core exposes a protocol and drawing APIs, so IDE-style screens live in plugins, distributions and external UIs. The charter says turning Vim into an IDE is a non-goal, and so is limiting IDEs built on Neovim ([charter](https://neovim.io/charter/)).

---

## 6. What this suggests for hn (my reading, not sourced)

- **Keep tmux's key language exact, as both transitions kept vi's.** Each project changed only a handful of keys,
  and every change can be undone. For hn, any key that differs from tmux must be one `.tmux.conf` line away from
  tmux's behaviour.
- **Keep the screen's skeleton, and change the look through defaults and on-demand elements.** Vim's status line,
  tab line and popups appear only when used. Neovim's first always-visible addition was one status line. hn's
  equivalent: tmux's layout (status line at the bottom, window list, borders), with agent state shown in the places
  tmux already has (pane titles, the status line) and new surfaces only on demand.
- **The mouse is where defaults backfire.** Both editors turned the mouse on by default and both pulled it back,
  because it broke copy and paste through the terminal. hn now defaults to `mouse on` (tmux's default is off). hn
  copies through OSC 52 and Shift-drag still selects with the terminal, but the way out (`set -g mouse off`)
  should be as easy to find as Neovim made it (a "How to disable the mouse" item in its right-click menu).
- **New looks belong on top of an exact core.** In Neovim the core stays close to Vim, and distributions (LazyVim,
  NvChad, kickstart) decide what the screen looks like. For hn, an agent-first default look can sit over a
  tmux-exact engine, and a user's `.tmux.conf` styling always wins.
- **Two audiences want different things.** Vim use is flat across ages and rises with experience. Neovim use is
  highest among 18–24-year-olds (24.5%) and falls with age (2025 raw data, §4.5). The tmux crowd that hn needs for
  credibility looks like the Vim group; the people new to terminals because of agents look like the Neovim group.
  An exact core with a modern default look serves both.

---

## Sources

**vi**

- POSIX.1-2024: [vi](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/vi.html), [ex](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/ex.html)
- Joy and Horton, *An Introduction to Display Editing with Vi* (4.4BSD USD:12): [index](https://docs-archive.freebsd.org/44doc/usd/12.vi/paper.html), sections [2](https://docs-archive.freebsd.org/44doc/usd/12.vi/paper-2.html), [5](https://docs-archive.freebsd.org/44doc/usd/12.vi/paper-5.html), [8](https://docs-archive.freebsd.org/44doc/usd/12.vi/paper-8.html)
- Traditional vi: [Heirloom ex-vi manual](https://ex-vi.sourceforge.net/ex.html), [ex_vops2.c](https://github.com/n-t-roff/heirloom-ex-vi/blob/master/ex_vops2.c)
- nvi: [OpenBSD vi(1)](https://man.openbsd.org/vi.1), [FreeBSD 14.3 vi(1)](https://man.freebsd.org/cgi/man.cgi?query=vi&sektion=1&manpath=FreeBSD+14.3-RELEASE)
- BusyBox: [editors/vi.c](https://github.com/mirror/busybox/blob/master/editors/vi.c), [Alpine busyboxconfig](https://gitlab.alpinelinux.org/alpine/aports/-/blob/master/main/busybox/busyboxconfig)
- [Oracle Solaris, "Two Modes of vi"](https://docs.oracle.com/cd/E19253-01/806-7612/editorvi-5/index.html); [Wikipedia: vi](https://en.wikipedia.org/wiki/Vi_(text_editor))

**Distribution defaults**

- Debian: [vim-tiny](https://packages.debian.org/trixie/vim-tiny), [control](https://sources.debian.org/src/vim/2:9.1.1230-2/debian/control), [vimrc.tiny](https://sources.debian.org/src/vim/2:9.1.1230-2/debian/tiny/vimrc.tiny.in), [system vimrc](https://sources.debian.org/src/vim/2:9.1.1230-2/debian/runtime/vimrc), [vim.alternatives](https://sources.debian.org/src/vim/2:9.1.1230-2/debian/vim.alternatives)
- Fedora: [vim-minimal](https://packages.fedoraproject.org/pkgs/vim/vim-minimal/), [virc](https://src.fedoraproject.org/rpms/vim/blob/rawhide/f/virc), [vimrc](https://src.fedoraproject.org/rpms/vim/blob/rawhide/f/vimrc), [vim.spec](https://src.fedoraproject.org/rpms/vim/blob/rawhide/f/vim.spec)
- Arch: [ex-vi-compat](https://archlinux.org/packages/extra/any/ex-vi-compat/), [forum thread](https://bbs.archlinux.org/viewtopic.php?id=311868), [commit mail](https://www.mail-archive.com/arch-commits@lists.archlinux.org/msg970183.html), [vi.sh](https://gitlab.archlinux.org/archlinux/packaging/packages/ex-vi-compat/-/blob/main/vi.sh), [commit log](https://gitlab.archlinux.org/archlinux/packaging/packages/ex-vi-compat/-/commits/main)
- macOS: local check on macOS 26.6.2 (`/usr/bin/vi` → Vim 9.1.1752; `/usr/share/vim/vimrc`)

**Vim**

- Help files: [vi_diff.txt](https://vimhelp.org/vi_diff.txt.html), [options.txt](https://vimhelp.org/options.txt.html), [starting.txt](https://vimhelp.org/starting.txt.html#defaults.vim), [term.txt](https://vimhelp.org/term.txt.html#termcap-cursor-shape)
- Release notes: [version4](https://vimhelp.org/version4.txt.html), [version5](https://vimhelp.org/version5.txt.html), [version6](https://vimhelp.org/version6.txt.html), [version7](https://vimhelp.org/version7.txt.html), [version8](https://vimhelp.org/version8.txt.html), [version9](https://vimhelp.org/version9.txt.html)
- Source: [defaults.vim (current)](https://github.com/vim/vim/blob/master/runtime/defaults.vim), [defaults.vim at v8.0.0000](https://github.com/vim/vim/blob/v8.0.0000/runtime/defaults.vim), [version.c](https://github.com/vim/vim/blob/master/src/version.c), [version.c at 7.0](https://github.com/vim/vim/blob/v7.0/src/version.c), [highlight.c](https://github.com/vim/vim/blob/master/src/highlight.c), [matchparen.vim](https://github.com/vim/vim/blob/master/runtime/plugin/matchparen.vim), [ruler default commit](https://github.com/vim/vim/commit/ba36510920654a52d8b5908f5a61c6969bb31942), [README](https://github.com/vim/vim/blob/master/README.md), [vim/colorschemes](https://github.com/vim/colorschemes)
- History: [Bram Moolenaar, "The continuing story of Vim" (10 Oct 2000)](http://moolenaar.net/vimstory.pdf), [Wikipedia: Vim](https://en.wikipedia.org/wiki/Vim_(text_editor))
- Debian bugs: [#837880](https://bugs.debian.org/837880), [#839112](https://bugs.debian.org/839112), [#864074](https://bugs.debian.org/864074)

**Neovim**

- Docs at 0.12.5: [vim_diff.txt](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/vim_diff.txt), [news (0.12)](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/news.txt), [options.txt](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/options.txt), [options.lua](https://github.com/neovim/neovim/blob/v0.12.5/src/nvim/options.lua), [lua.txt (ui2)](https://github.com/neovim/neovim/blob/v0.12.5/runtime/doc/lua.txt), [version.c](https://github.com/neovim/neovim/blob/v0.12.5/src/nvim/version.c)
- Earlier vim_diff.txt: [v0.1.0](https://github.com/neovim/neovim/blob/v0.1.0/runtime/doc/vim_diff.txt), [v0.1.4](https://github.com/neovim/neovim/blob/v0.1.4/runtime/doc/vim_diff.txt), [v0.2.0](https://github.com/neovim/neovim/blob/v0.2.0/runtime/doc/vim_diff.txt)
- [UI protocol (api-ui-events)](https://neovim.io/doc/user/api-ui-events.html); news files [0.9](https://neovim.io/doc/user/news-0.9.html), [0.10](https://neovim.io/doc/user/news-0.10.html), [0.11](https://neovim.io/doc/user/news-0.11.html)
- Newsletters: [#7 (2016)](https://neovim.io/news/2016/11/), [#8 (2017)](https://neovim.io/news/2017/12/), [#9 (2020)](https://neovim.io/news/2020/04/), [#10 (2020)](https://neovim.io/news/2020/10/), [#11 (0.5)](https://neovim.io/news/2021/07/), [#12 (0.7)](https://neovim.io/news/2022/04/), [2022 review](https://neovim.io/news/2022/12/)
- Release notes: [0.3.0](https://github.com/neovim/neovim/releases/tag/v0.3.0), [0.4.0](https://github.com/neovim/neovim/commit/e2cc5fe09d98ce1ccaaa666a835c896805ccc196), [0.6.0](https://github.com/neovim/neovim/releases/tag/v0.6.0), [0.8.0](https://github.com/neovim/neovim/releases/tag/v0.8.0)
- [Charter](https://neovim.io/charter/), [README](https://github.com/neovim/neovim/blob/master/README.md)
- Issues and PRs: [#5938](https://github.com/neovim/neovim/issues/5938), [#14790](https://github.com/neovim/neovim/issues/14790), [#26334](https://github.com/neovim/neovim/pull/26334), [#26369](https://github.com/neovim/neovim/issues/26369), [#26378](https://github.com/neovim/neovim/issues/26378), [#26385](https://github.com/neovim/neovim/issues/26385), [#26389](https://github.com/neovim/neovim/pull/26389), [#26540](https://github.com/neovim/neovim/pull/26540)
- External UIs: [Neovide](https://neovide.dev/features.html), [vscode-neovim](https://github.com/vscode-neovim/vscode-neovim), [Firenvim](https://github.com/glacambre/firenvim), [noice.nvim](https://github.com/folke/noice.nvim)
- Distributions: [LazyVim UI plugins](https://www.lazyvim.org/plugins/ui), [LazyVim options.lua](https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua), [LazyVim config/init.lua](https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/init.lua), [NvChad features](https://nvchad.com/docs/features), [AstroNvim](https://docs.astronvim.com/), [kickstart.nvim init.lua](https://github.com/nvim-lua/kickstart.nvim/blob/master/init.lua)
- User data: [Neovim options survey 2022](https://gist.github.com/echasnovski/fa70dc75c475369747d2a485a13303fb), [Dotfyle plugins](https://dotfyle.com/neovim/plugins/top), [Dotfyle colour schemes](https://dotfyle.com/neovim/colorscheme/top)

**Audience data**

- Stack Overflow Developer Survey: [2021](https://insights.stackoverflow.com/survey/2021), [2022](https://survey.stackoverflow.co/2022/), [2023](https://survey.stackoverflow.co/2023/), [2024](https://survey.stackoverflow.co/2024/technology), [2025](https://survey.stackoverflow.co/2025/technology)
- Raw survey data: [2024](https://github.com/StackExchange/Survey/tree/main/packages/archive/2024), [2025](https://github.com/StackExchange/Survey/tree/main/packages/archive/2025) (`results.csv` via Git LFS)
- [2026 survey announcement](https://stackoverflow.blog/2026/06/23/the-2026-developer-survey-is-now-open-for-human-developers-only/)
- PDE: [Oliver Davies (Oct 2022)](https://www.oliverdavies.uk/blog/neovim-personalised-development-environment), [Agoda Engineering on Medium](https://medium.com/agoda-engineering/personalized-development-environment-pde-a-different-take-on-editing-code-0ec05b323ae6)
- GitHub star counts: GitHub REST API, 26 Sep 2026
