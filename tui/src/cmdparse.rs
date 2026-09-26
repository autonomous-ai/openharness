//! tmux 3.5a's command language (cmd-parse.y), ported: the lexer — quoting, escapes (`\t` `\101`
//! `\s` `\u2502`), `$VAR` and `${VAR}`, `~` and `~user`, a backslash-newline joining lines,
//! comments, `#{` after `%if` — and the grammar: commands separated by `;` and newlines, `{ }`
//! blocks as arguments, `%if`/`%elif`/`%else`/`%endif` (whole lines, or inline in a command
//! list), `VAR=value` and `%hidden VAR=value`. Files, command prompts and bindings are all read
//! this way in tmux; a file is parsed whole before any of it runs.

/// What parsing needs from outside: the global environment, formats (for `%if`), home folders.
pub trait Env {
    /// A variable of the global environment (tmux's global_environ).
    fn var(&self, name: &str) -> Option<String>;
    /// `NAME=value` into the global environment (`%hidden`: not given to what panes run).
    fn assign(&mut self, assignment: &str, hidden: bool);
    /// A format, expanded without running #() jobs.
    fn expand(&mut self, format: &str) -> String;
    /// ~user's home folder (`None`: this user's).
    fn home(&self, user: Option<&str>) -> Option<String>;
}

/// A parsed command: its arguments, and the line it ended on (tmux's cmd->line).
#[derive(Clone, Debug, PartialEq)]
pub struct Command { pub line: usize, pub args: Vec<Arg> }

#[derive(Clone, Debug, PartialEq)]
pub enum Arg { Str(String), Block(Vec<Command>) }

#[derive(Clone, Debug, PartialEq)]
enum Tok { Newline, Semi, Open, Close, Token(String), Equals(String), Format(String), If, Elif, Else, Endif, Hidden, Error, End }

struct Lexer<'a> {
    chars: Vec<char>,
    off: usize,
    escapes: u32,
    line: usize,
    eol: bool,
    eof: bool,
    condition: bool,
    error: Option<String>,
    env: &'a mut dyn Env,
}

fn is_var(c: char, first: bool) -> bool {
    if c == '=' { return false }
    if first && c.is_ascii_digit() { return false }
    c.is_ascii_alphanumeric() || c == '_'
}

impl Lexer<'_> {
    fn getc1(&mut self) -> Option<char> {
        let c = self.chars.get(self.off).copied();
        if c.is_some() { self.off += 1 }
        c
    }

    fn ungetc(&mut self, c: Option<char>) { if c.is_some() && self.off > 0 { self.off -= 1 } }

    /// yylex_getc: backslashes counted and given back one at a time; one before a newline joins
    /// the lines.
    fn getc(&mut self) -> Option<char> {
        if self.escapes != 0 { self.escapes -= 1; return Some('\\') }
        loop {
            let ch = self.getc1();
            if ch == Some('\\') { self.escapes += 1; continue }
            if ch == Some('\n') && self.escapes % 2 == 1 { self.line += 1; self.escapes -= 1; continue }
            if self.escapes != 0 { self.ungetc(ch); self.escapes -= 1; return Some('\\') }
            return ch;
        }
    }

    fn fail(&mut self, e: &str) { if self.error.is_none() { self.error = Some(e.to_string()) } }

    fn get_word(&mut self, first: char) -> String {
        let mut s = String::from(first);
        loop {
            let ch = self.getc();
            match ch { Some(c) if !" \t\n".contains(c) => s.push(c), _ => { self.ungetc(ch); break } }
        }
        s
    }

    fn next(&mut self) -> Tok {
        if self.eol { self.line += 1 }
        self.eol = false;
        let condition = self.condition;
        self.condition = false;
        loop {
            let Some(mut ch) = self.getc() else {
                // Every file or string ends with a newline.
                if self.eof { return Tok::End }
                self.eof = true;
                return Tok::Newline;
            };
            if ch == ' ' || ch == '\t' { continue }
            if ch == '\r' {
                let n = self.getc();
                if n == Some('\n') { ch = '\n' } else { self.ungetc(n) }
            }
            if ch == '\n' { self.eol = true; return Tok::Newline }
            if ch == ';' { return Tok::Semi }
            if ch == '{' { return Tok::Open }
            if ch == '}' { return Tok::Close }
            if ch == '#' {
                // #{ after a condition opens a format; anything else is a comment.
                let mut next = self.getc();
                if condition && next == Some('{') { return match self.format() { Some(f) => Tok::Format(f), None => Tok::Error } }
                while next.is_some() && next != Some('\n') { next = self.getc() }
                if next == Some('\n') { self.line += 1; return Tok::Newline }
                continue;
            }
            if ch == '%' {
                // % is a condition unless it is all % or all digits, then it is a token.
                let word = self.get_word('%');
                if word.chars().all(|c| c == '%' || c.is_ascii_digit()) { return Tok::Token(word) }
                self.condition = true;
                return match word.as_str() { "%hidden" => Tok::Hidden, "%if" => Tok::If, "%else" => Tok::Else, "%elif" => Tok::Elif, "%endif" => Tok::Endif, _ => Tok::Error };
            }
            let Some(token) = self.token(ch) else { return Tok::Error };
            if let Some(eq) = token.find('=') {
                let name = &token[..eq];
                if token.chars().next().map(|c| is_var(c, true)).unwrap_or(false) && name.chars().skip(1).all(|c| is_var(c, false)) { return Tok::Equals(token) }
            }
            return Tok::Token(token);
        }
    }

    /// yylex_format: `#{…}` to its closing brace (nested ones counted), on one line.
    fn format(&mut self) -> Option<String> {
        let mut s = String::from("#{");
        let mut brackets = 1;
        loop {
            let ch = self.getc()?;
            if ch == '\n' { return None }
            if ch == '#' {
                let c = self.getc()?;
                if c == '\n' { return None }
                if c == '{' { brackets += 1 }
                s.push('#');
                s.push(c);
                continue;
            }
            if ch == '}' && brackets != 0 {
                brackets -= 1;
                if brackets == 0 { s.push('}'); break }
            }
            s.push(ch);
        }
        Some(s)
    }

    /// yylex_token_escape: the character after a backslash.
    fn escape(&mut self, s: &mut String) -> bool {
        let Some(ch) = self.getc() else { return false };
        if ('4'..='7').contains(&ch) { self.fail("invalid octal escape"); return false }
        if ('0'..='3').contains(&ch) {
            let o2 = self.getc();
            if let Some(o2 @ '0'..='7') = o2 {
                let o3 = self.getc();
                if let Some(o3 @ '0'..='7') = o3 {
                    let v = 64 * (ch as u32 - '0' as u32) + 8 * (o2 as u32 - '0' as u32) + (o3 as u32 - '0' as u32);
                    s.push(char::from_u32(v).unwrap_or('?'));
                    return true;
                }
            }
            self.fail("invalid octal escape");
            return false;
        }
        let c = match ch {
            'a' => '\x07', 'b' => '\x08', 'e' => '\x1b', 'f' => '\x0c', 's' => ' ', 'v' => '\x0b', 'r' => '\r', 'n' => '\n', 't' => '\t',
            'u' | 'U' => {
                let size = if ch == 'u' { 4 } else { 8 };
                let mut hex = String::new();
                for _ in 0..size {
                    match self.getc() {
                        None | Some('\n') => return false,
                        Some(h) if h.is_ascii_hexdigit() => hex.push(h),
                        Some(_) => { self.fail(&format!("invalid \\{ch} argument")); return false }
                    }
                }
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(c) => c,
                    None => { self.fail(&format!("invalid \\{ch} argument")); return false }
                }
            }
            c => c,
        };
        s.push(c);
        true
    }

    /// yylex_token_variable: `$NAME` or `${NAME}` from the global environment (a lone `$` stays).
    fn variable(&mut self, s: &mut String) -> bool {
        let Some(ch) = self.getc() else { return false };
        let brackets = ch == '{';
        let mut name = String::new();
        if !brackets {
            if !is_var(ch, true) { s.push('$'); self.ungetc(Some(ch)); return true }
            name.push(ch);
        }
        loop {
            let ch = self.getc();
            if brackets && ch == Some('}') { break }
            match ch {
                Some(c) if is_var(c, false) => {
                    if name.len() >= 1022 { self.fail("environment variable is too long"); return false }
                    name.push(c)
                }
                _ if !brackets => { self.ungetc(ch); break }
                _ => { self.fail("invalid environment variable"); return false }
            }
        }
        if let Some(v) = self.env.var(&name) { s.push_str(&v) }
        true
    }

    /// yylex_token_tilde: `~` (this user's home) or `~user`.
    fn tilde(&mut self, s: &mut String) -> bool {
        let mut name = String::new();
        loop {
            let ch = self.getc();
            match ch {
                Some(c) if !"/ \t\n\"'".contains(c) => name.push(c),
                _ => { self.ungetc(ch); break }
            }
        }
        match self.env.home(if name.is_empty() { None } else { Some(&name) }) {
            Some(h) => { s.push_str(&h); true }
            None => false,
        }
    }

    /// yylex_token: a word — quotes, escapes, `~` and `$` as tmux reads them.
    fn token(&mut self, first: char) -> Option<String> {
        #[derive(PartialEq, Clone, Copy)]
        enum Q { Start, None, Double, Single }
        let (mut state, mut last) = (Q::None, Q::Start);
        let mut s = String::new();
        let mut ch = Some(first);
        loop {
            let Some(mut c) = ch else { break };
            if state == Q::None && c == '\r' {
                let n = self.getc();
                if n == Some('\n') { c = '\n' } else { self.ungetc(n) }
            }
            if state == Q::None && (c == '\n' || c == ' ' || c == '\t' || c == ';' || c == '}') { break }
            // A newline in quotes stays; the blanks and a comment after it go.
            if c == '\n' && state != Q::None {
                s.push('\n');
                let mut n = self.getc();
                while n == Some(' ') || n == Some('\t') { n = self.getc() }
                if n != Some('#') { ch = n; continue }
                let n2 = self.getc();
                if n2.map(|x| ",#{}:".contains(x)).unwrap_or(false) { self.ungetc(n2); ch = Some('#'); continue }
                let mut k = n2;
                while k.is_some() && k != Some('\n') { k = self.getc() }
                ch = k;
                continue;
            }
            let mut skip = false;
            if c == '\\' && state != Q::Single { if !self.escape(&mut s) { return None } skip = true }
            else if c == '~' && last != state && state != Q::Single { if !self.tilde(&mut s) { return None } skip = true }
            else if c == '$' && state != Q::Single { if !self.variable(&mut s) { return None } skip = true }
            if !skip {
                if c == '\'' && state == Q::None { state = Q::Single; ch = self.getc(); continue }
                if c == '\'' && state == Q::Single { state = Q::None; ch = self.getc(); continue }
                if c == '"' && state == Q::None { state = Q::Double; ch = self.getc(); continue }
                if c == '"' && state == Q::Double { state = Q::None; ch = self.getc(); continue }
                s.push(c);
            }
            last = state;
            ch = self.getc();
        }
        self.ungetc(ch);
        Some(s)
    }
}

/// The parser: yacc's grammar read top-down, with its scope stack (the `%if` flags).
struct Parser<'a> {
    lx: Lexer<'a>,
    peeked: Option<Tok>,
    scope: Option<bool>,
    stack: Vec<bool>,
    parse_only: bool,
}

type Res<T> = Result<T, String>;

impl<'a> Parser<'a> {
    fn peek(&mut self) -> &Tok {
        if self.peeked.is_none() { let t = self.lx.next(); self.peeked = Some(t) }
        self.peeked.as_ref().unwrap()
    }
    fn take(&mut self) -> Tok { self.peek(); self.peeked.take().unwrap() }
    fn live(&self) -> bool { self.scope.unwrap_or(true) }
    fn error(&mut self) -> String { self.lx.error.clone().unwrap_or_else(|| "syntax error".into()) }

    fn expect(&mut self, t: Tok) -> Res<()> { if self.take() == t { Ok(()) } else { Err(self.error()) } }

    /// statements up to (not including) a token in `stop`, each ended by a newline.
    fn statements(&mut self, stop: &[Tok]) -> Res<Vec<Command>> {
        let mut out = Vec::new();
        loop {
            if stop.contains(self.peek()) { return Ok(out) }
            if *self.peek() == Tok::End { return if stop.is_empty() { Ok(out) } else { Err(self.error()) } }
            out.extend(self.statement()?);
            match self.take() { Tok::Newline => {}, _ => return Err(self.error()) }
        }
    }

    /// One statement (without its newline): nothing, a hidden assignment, a condition, commands.
    fn statement(&mut self) -> Res<Vec<Command>> {
        match self.peek().clone() {
            Tok::Newline | Tok::Close => Ok(Vec::new()),
            Tok::Hidden => {
                self.take();
                let Tok::Equals(a) = self.take() else { return Err(self.error()) };
                if !self.parse_only && self.live() { self.lx.env.assign(&a, true) }
                Ok(Vec::new())
            }
            Tok::If => {
                // `%if X` then a newline: the lines up to %endif; else inline, in a command list.
                self.take();
                let flag = self.if_open()?;
                if *self.peek() == Tok::Newline { self.take(); let c = self.condition(flag)?; return Ok(if self.live() { c } else { Vec::new() }) }
                let c = self.condition1(flag)?;
                self.commands_rest(c)
            }
            _ => { let c = self.commands()?; Ok(if self.live() { c } else { Vec::new() }) }
        }
    }

    /// if_open: the condition's value, a new scope pushed.
    fn if_open(&mut self) -> Res<bool> {
        let f = match self.take() { Tok::Format(f) | Tok::Token(f) => f, _ => return Err(self.error()) };
        let v = self.lx.env.expand(&f);
        let flag = !v.is_empty() && v != "0";
        if let Some(s) = self.scope { self.stack.push(s) }
        self.scope = Some(flag);
        Ok(flag)
    }
    fn if_close(&mut self) { self.scope = self.stack.pop() }

    /// A condition over whole lines, after `%if X` and its newline.
    fn condition(&mut self, flag: bool) -> Res<Vec<Command>> {
        let stops = [Tok::Elif, Tok::Else, Tok::Endif];
        let first = self.statements(&stops)?;
        let mut chosen = if flag { Some(first) } else { None };
        loop {
            match self.take() {
                Tok::Endif => { self.if_close(); return Ok(chosen.unwrap_or_default()) }
                Tok::Elif => {
                    let f = match self.take() { Tok::Format(f) | Tok::Token(f) => f, _ => return Err(self.error()) };
                    let v = self.lx.env.expand(&f);
                    let flag = !v.is_empty() && v != "0";
                    self.scope = Some(flag);
                    self.expect(Tok::Newline)?;
                    let body = self.statements(&stops)?;
                    if chosen.is_none() && flag { chosen = Some(body) }
                }
                Tok::Else => {
                    self.scope = Some(!self.live());
                    self.expect(Tok::Newline)?;
                    let body = self.statements(&[Tok::Endif])?;
                    self.expect(Tok::Endif)?;
                    self.if_close();
                    return Ok(chosen.unwrap_or(body));
                }
                _ => return Err(self.error()),
            }
        }
    }

    /// condition1: `%if X cmds [%elif Y cmds] [%else cmds] %endif` within one command list.
    fn condition1(&mut self, flag: bool) -> Res<Vec<Command>> {
        let first = self.commands_until(&[Tok::Elif, Tok::Else, Tok::Endif])?;
        let mut chosen = if flag { Some(first) } else { None };
        loop {
            match self.take() {
                Tok::Endif => { self.if_close(); return Ok(chosen.unwrap_or_default()) }
                Tok::Elif => {
                    let f = match self.take() { Tok::Format(f) | Tok::Token(f) => f, _ => return Err(self.error()) };
                    let v = self.lx.env.expand(&f);
                    let flag = !v.is_empty() && v != "0";
                    self.scope = Some(flag);
                    let body = self.commands_until(&[Tok::Elif, Tok::Else, Tok::Endif])?;
                    if chosen.is_none() && flag { chosen = Some(body) }
                }
                Tok::Else => {
                    self.scope = Some(!self.live());
                    let body = self.commands_until(&[Tok::Endif])?;
                    self.expect(Tok::Endif)?;
                    self.if_close();
                    return Ok(chosen.unwrap_or(body));
                }
                _ => return Err(self.error()),
            }
        }
    }

    /// A command list that must end at one of `stop` (inside an inline condition).
    fn commands_until(&mut self, stop: &[Tok]) -> Res<Vec<Command>> {
        if stop.contains(self.peek()) { return Err(self.error()) }
        let c = self.commands()?;
        if !stop.contains(self.peek()) { return Err(self.error()) }
        Ok(c)
    }

    /// commands: `command` or `condition1`, then `; command` / `; condition1` / a trailing `;`.
    fn commands(&mut self) -> Res<Vec<Command>> {
        let list = if *self.peek() == Tok::If {
            self.take();
            let flag = self.if_open()?;
            self.condition1(flag)?
        } else {
            let c = self.command()?;
            if !c.args.is_empty() && self.live() { vec![c] } else { Vec::new() }
        };
        self.commands_rest(list)
    }

    fn commands_rest(&mut self, mut list: Vec<Command>) -> Res<Vec<Command>> {
        while *self.peek() == Tok::Semi {
            self.take();
            match self.peek().clone() {
                Tok::If => { self.take(); let flag = self.if_open()?; list.extend(self.condition1(flag)?) }
                Tok::Token(_) | Tok::Equals(_) => {
                    let c = self.command()?;
                    // tmux keeps the list only when this command has arguments and its scope is on.
                    if !c.args.is_empty() && self.live() { list.push(c) } else { list = Vec::new() }
                }
                _ => {}
            }
        }
        Ok(list)
    }

    /// command: [NAME=value] name [arguments], or an assignment alone.
    fn command(&mut self) -> Res<Command> {
        if let Tok::Equals(a) = self.peek().clone() {
            self.take();
            if !self.parse_only && self.live() { self.lx.env.assign(&a, false) }
            if !matches!(self.peek(), Tok::Token(_)) { return Ok(Command { line: self.lx.line, args: Vec::new() }) }
        }
        let Tok::Token(name) = self.take() else { return Err(self.error()) };
        let mut args = vec![Arg::Str(name)];
        loop {
            match self.peek().clone() {
                Tok::Token(t) | Tok::Equals(t) => { self.take(); args.push(Arg::Str(t)) }
                Tok::Open => { self.take(); args.push(Arg::Block(self.block()?)) }
                _ => break,
            }
        }
        Ok(Command { line: self.lx.line, args })
    }

    /// argument_statements: statements up to the `}` that closes the block.
    fn block(&mut self) -> Res<Vec<Command>> {
        let mut out = Vec::new();
        loop {
            if *self.peek() == Tok::Close { self.take(); return Ok(out) }
            if *self.peek() == Tok::End { return Err(self.error()) }
            out.extend(self.statement()?);
            match self.take() { Tok::Newline => {}, Tok::Close => return Ok(out), _ => return Err(self.error()) }
        }
    }
}

/// Parse a file's (or a string's) text into its commands; the error is tmux's, with its line.
pub fn parse(text: &str, env: &mut dyn Env, parse_only: bool) -> Result<Vec<Command>, (usize, String)> {
    let lx = Lexer { chars: text.chars().collect(), off: 0, escapes: 0, line: 1, eol: false, eof: false, condition: false, error: None, env };
    let mut p = Parser { lx, peeked: None, scope: None, stack: Vec::new(), parse_only };
    match p.statements(&[]) {
        Ok(c) if p.scope.is_none() && p.stack.is_empty() => Ok(c),
        Ok(_) => Err((p.lx.line, "syntax error".into())),
        Err(e) => Err((p.lx.line, e)),
    }
}

/// cmd_parse_from_arguments: a command given as arguments (a binding's, a shell's `hn …`)
/// split into commands where an argument ends with `;` (`\;` at its end is a `;` it keeps).
pub fn from_arguments(words: &[String]) -> Vec<Vec<String>> {
    let (mut out, mut cmd): (Vec<Vec<String>>, Vec<String>) = (Vec::new(), Vec::new());
    for w in words {
        if w.starts_with(crate::tmuxconf::BLOCK) { cmd.push(w.clone()); continue }
        match w.strip_suffix(';') {
            Some(rest) if rest.ends_with('\\') => cmd.push(format!("{};", &rest[..rest.len() - 1])),
            Some(rest) => {
                if !rest.is_empty() { cmd.push(rest.to_string()) }
                if !cmd.is_empty() { out.push(std::mem::take(&mut cmd)) }
            }
            None => cmd.push(w.clone()),
        }
    }
    if !cmd.is_empty() { out.push(cmd) }
    out
}

/// A command as tmux prints it (cmd_print): its name, then each argument escaped, a block as
/// `{ … }`.
pub fn print(cmd: &Command) -> String {
    cmd.args.iter().enumerate().map(|(i, a)| match a {
        Arg::Str(s) if i == 0 => s.clone(),
        Arg::Str(s) => crate::options::escape(s),
        Arg::Block(b) => format!("{{ {} }}", print_list(b)),
    }).collect::<Vec<_>>().join(" ")
}

/// Commands as cmd_list_print prints them: ` ; ` between those of one line, ` ;; ` where a new
/// line starts.
pub fn print_list(cmds: &[Command]) -> String {
    let mut out = String::new();
    for (i, c) in cmds.iter().enumerate() {
        out.push_str(&print(c));
        if let Some(next) = cmds.get(i + 1) { out.push_str(if next.line != c.line { " ;; " } else { " ; " }) }
    }
    out
}

/// A command as the words hn's queue runs: a block kept as one word, marked, holding its text.
pub fn words(cmd: &Command) -> Vec<String> {
    cmd.args.iter().map(|a| match a {
        Arg::Str(s) => s.clone(),
        Arg::Block(b) => format!("{}{}", crate::tmuxconf::BLOCK, print_list(b)),
    }).collect()
}

/// What building a parse leaves: the commands (their names found, aliases expanded) with their
/// lines, and — for source-file -v — each line's commands as tmux prints them.
#[derive(Default)]
pub struct Built { pub commands: Vec<Command>, pub verbose: Vec<String> }

/// cmd_parse_build_commands: each command's alias expanded (command-alias) and the command
/// checked as tmux checks it — found by name, its flags and arguments read — its blocks too. The
/// first that fails is the error, `file:line: why`. The -v lines carry tmux's line numbers (a
/// line with a block is numbered as the block's last line).
pub fn build(cmds: &[Command], env: &mut dyn Env, file: Option<&str>, verbose: bool, aliases: &dyn Fn(&str) -> Option<String>) -> Result<Built, (Built, String)> {
    let mut b = Built::default();
    let mut at = 0usize;
    match build_into(cmds, env, file, verbose, aliases, false, &mut b, &mut at) { Ok(()) => Ok(b), Err(e) => Err((b, e)) }
}

fn build_into(cmds: &[Command], env: &mut dyn Env, file: Option<&str>, verbose: bool, aliases: &dyn Fn(&str) -> Option<String>, noalias: bool, out: &mut Built, at: &mut usize) -> Result<(), String> {
    let error = |line: usize, e: String| match file { Some(f) => format!("{f}:{line}: {e}"), None => e };
    let mut group: Vec<Command> = Vec::new();
    let mut group_line = None;
    let flush = |group: &mut Vec<Command>, at: usize, out: &mut Built| {
        if group.is_empty() { return }
        if verbose { out.verbose.push(match file { Some(f) => format!("{f}:{at}: {}", print_list(group)), None => format!("{at}: {}", print_list(group)) }) }
        out.commands.append(group);
    };
    for cmd in cmds {
        if group_line != Some(cmd.line) { flush(&mut group, *at, out); group_line = Some(cmd.line) }
        *at = cmd.line;
        let Some(Arg::Str(name)) = cmd.args.first() else { continue };
        // command-alias: the alias's commands, the last taking this one's arguments.
        if !noalias {
            if let Some(alias) = aliases(name) {
                let mut expanded = parse(&alias, env, true).map_err(|(_, e)| error(cmd.line, e))?;
                let Some(last) = expanded.last_mut() else { continue };
                last.args.extend(cmd.args[1..].iter().cloned());
                for c in expanded.iter_mut() { c.line = cmd.line }
                // Built as tmux builds them (-v prints them here, and again with this line's group).
                let mut sub = Built { commands: Vec::new(), verbose: std::mem::take(&mut out.verbose) };
                let result = build_into(&expanded, env, file, verbose, aliases, true, &mut sub, at);
                out.verbose = sub.verbose;
                result?;
                group.extend(sub.commands);
                continue;
            }
        }
        let mut checked = cmd.clone();
        for a in checked.args.iter_mut() {
            if let Arg::Block(inner) = a {
                let mut sub = Built { commands: Vec::new(), verbose: std::mem::take(&mut out.verbose) };
                build_into(inner, env, file, verbose, aliases, noalias, &mut sub, at)?;
                out.verbose = sub.verbose;
                *inner = sub.commands;
            }
        }
        // hn's own commands (new-harness …) are its to read; tmux's are read as tmux reads them.
        if !crate::commands::hn_owned(name) {
            let entry = crate::cmd::find(name).map_err(|e| error(cmd.line, e))?;
            let list: Vec<String> = words(&checked).into_iter().map(|w| w.trim_start_matches(crate::tmuxconf::BLOCK).to_string()).collect();
            crate::cmd::parse(entry, &list).map_err(|e| error(cmd.line, e))?;
            checked.args[0] = Arg::Str(entry.name.to_string());
        } else if !crate::commands::is_command_name(name) {
            return Err(error(cmd.line, format!("unknown command: {name}")));
        }
        group.push(checked);
    }
    flush(&mut group, *at, out);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct TestEnv { vars: HashMap<String, String>, hidden: Vec<String> }
    impl Env for TestEnv {
        fn var(&self, name: &str) -> Option<String> { self.vars.get(name).cloned() }
        fn assign(&mut self, a: &str, hidden: bool) { let (k, v) = a.split_once('=').unwrap(); self.vars.insert(k.into(), v.into()); if hidden { self.hidden.push(k.into()) } }
        fn expand(&mut self, f: &str) -> String { match f { "#{version}" => "3.5a".into(), "#{==:#{host_short},mac}" | "1" => "1".into(), _ => String::new() } }
        fn home(&self, user: Option<&str>) -> Option<String> { Some(format!("/home/{}", user.unwrap_or("me"))) }
    }

    fn lines(text: &str, env: &mut TestEnv) -> Vec<String> {
        parse(text, env, false).unwrap().iter().map(print).collect()
    }

    #[test]
    fn reads_quotes_escapes_and_variables_as_tmux() {
        let mut env = TestEnv::default();
        env.vars.insert("HOME".into(), "/home/me".into());
        assert_eq!(lines("set -g @h \"$HOME/x\"", &mut env), vec!["set -g @h /home/me/x"]);
        assert_eq!(lines("set -g @h '$HOME/x'", &mut env), vec!["set -g @h \"\\$HOME/x\""]);
        assert_eq!(lines("source-file ~/a.conf", &mut env), vec!["source-file /home/me/a.conf"]);
        assert_eq!(lines("set -g @u ~bob/x", &mut env), vec!["set -g @u /home/bob/x"]);
        assert_eq!(lines("set -g @t a\\tb\\101\\sc", &mut env), vec!["set -g @t \"a\\tbA c\""]);
        assert_eq!(lines("set -g @l \"a \\\nb\"", &mut env), vec!["set -g @l \"a b\""]);
        assert_eq!(lines("set -g @x ${HOME}y$ z", &mut env), vec!["set -g @x \"/home/mey$\" z"]);
    }

    #[test]
    fn conditions_and_assignments() {
        let mut env = TestEnv::default();
        let text = "A=1\n%hidden B=2\n%if \"#{==:#{host_short},mac}\"\nset -g @a $A\n%elif 1\nset -g @b x\n%else\nset -g @c y\n%endif\nset -g @d $B\n";
        assert_eq!(lines(text, &mut env), vec!["set -g @a 1", "set -g @d 2"]);
        assert_eq!(env.hidden, vec!["B"]);
        assert_eq!(lines("%if #{version} set -g @v yes %else set -g @v no %endif", &mut env), vec!["set -g @v yes"]);
        assert_eq!(parse("%if 1\nset -g x y\n", &mut env, false).unwrap_err().1, "syntax error");
    }

    #[test]
    fn blocks_and_separators() {
        let mut env = TestEnv::default();
        assert_eq!(lines("bind x { display a ; display b }", &mut env), vec!["bind x { display a ; display b }"]);
        assert_eq!(lines("bind x {\n  display a\n  # a comment\n  display b\n}\nset -g @z 1", &mut env), vec!["bind x { display a ;; display b }", "set -g @z 1"]);
        assert_eq!(lines("bind x display a \\; display b", &mut env), vec!["bind x display a \\; display b"]);
        assert_eq!(lines("display a ; display b", &mut env), vec!["display a", "display b"]);
        assert_eq!(lines("display 100%", &mut env), vec!["display \"100%\""]);
    }
}
