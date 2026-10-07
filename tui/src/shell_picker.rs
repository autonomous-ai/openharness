//! A height-limited finder running in the shell's own PTY, like fzf --height.
//! No alternate screen, application modal, shell evaluation, or extra executable.
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use base64::{Engine, engine::general_purpose::STANDARD};
use crossterm::{cursor, event::{self, Event, KeyCode, KeyModifiers}, terminal};
use serde::{Deserialize, Serialize};
use ratatui::{backend::{Backend, CrosstermBackend}, buffer::Buffer, layout::{Position, Rect}, text::Line};
use crate::theme;
use crate::picker::{Picker, Row};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Item {
    pub id: String, pub label: String, pub detail: String, pub extra: String, pub right: String,
    pub disabled: bool, pub tier: u8, pub volatile_detail: bool, pub volatile_right: usize,
    pub lead: String, pub group: Option<String>, pub boost: u32, pub label_dim: usize,
    pub right_narrow: Option<String>, pub line_first: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Items {
    pub rows: Vec<Item>, pub notice: String,
    pub total_rows: Option<usize>,
    pub live: bool, pub search_extra: bool,
    pub said: Vec<String>, pub said_query: String,
    pub catalog_ids: std::collections::HashSet<String>, pub said_text: std::collections::HashMap<String,String>,
    pub preview: Vec<String>, pub preview_bottom: bool, pub revision: String, pub unchanged: bool,
    pub preview_id: Option<String>,
    /// Directory whose children are being browsed, on the selected computer.
    pub folder: Option<String>,
    /// Canonical computer for the draft, including an implicit current computer.
    pub machine: Option<String>,
}
impl Items {
    pub fn from_picker(picker: &Picker) -> Self {
        Self {
            rows: picker.rows.iter().map(|r| Item {
                id:r.id.clone(), label:r.label.clone(), detail:r.detail.iter().map(|s| s.content.as_ref()).collect(),
                extra:r.extra.clone(), right:r.right.clone(), disabled:r.disabled, tier:r.tier,
                volatile_detail:r.volatile_detail, volatile_right:r.volatile_right,
                lead:r.lead.iter().map(|s|s.content.as_ref()).collect(), group:r.group.clone(), boost:r.boost,
                label_dim:r.label_dim, right_narrow:r.right_narrow.clone(), line_first:r.line_first,
            }).collect(),
            notice:picker.status.clone(), live:picker.live, search_extra:picker.search_extra,
            said:picker.said.clone(), said_query:picker.said_query.clone(), catalog_ids:picker.catalog_ids.clone(), said_text:picker.said_text.clone(),
            ..Self::default()
        }
    }
    fn apply(&self, picker: &mut Picker) {
        picker.live=self.live; picker.search_extra=self.search_extra;
        picker.said=self.said.clone(); picker.said_query=self.said_query.clone(); picker.catalog_ids=self.catalog_ids.clone(); picker.said_text=self.said_text.clone();
        picker.status=self.notice.clone();
        picker.total_rows=self.total_rows;
        picker.set_rows(self.rows.iter().map(|r| {
            let mut row=Row::new(&r.id,clean(&r.label)).extra(clean(&r.extra)).right(clean(&r.right))
                .detail(vec![ratatui::text::Span::raw(clean(&r.detail))]).tier(r.tier).volatile(r.volatile_detail,r.volatile_right);
            row.disabled=r.disabled; row.group=r.group.clone(); row.boost=r.boost;
            row.lead=vec![ratatui::text::Span::raw(clean(&r.lead))];
            row.label_dim=r.label_dim; row.right_narrow=r.right_narrow.as_deref().map(clean); row.line_first=r.line_first;
            row
        }).collect());
    }
    fn same_catalog(&self, other:&Self)->bool {
        self.rows==other.rows && self.total_rows==other.total_rows && self.live==other.live && self.search_extra==other.search_extra
            && self.said==other.said && self.said_query==other.said_query
            && self.catalog_ids==other.catalog_ids && self.said_text==other.said_text
    }
    fn apply_catalog(&self, picker: &mut Picker, folder: bool) {
        // A growing folder scan must keep the result position, like a typed
        // query. Otherwise a weak early match stays selected when the directory
        // whose name matches arrives (October 6 ARM shell-composer incident).
        // Explicit fzf tracking still follows the selected item.
        let selected=if folder && !picker.tracking() {None} else {picker.selected_id.clone()};
        let cursor=picker.cursor;
        self.apply(picker);
        picker.selected_id=selected;
        picker.cursor=cursor;
        folder_filter(picker,folder);
    }
}
const MAX_DATA: u64 = 8 * 1024 * 1024;

struct Request {
    fifo: File,
    path: PathBuf,
    token: String,
    id: String,
    verb: String,
    query: String,
    input: Vec<u8>,
    sent: Instant,
    started: Instant,
}
impl Request {
    fn new(out: &mut File, kind: &str, query: &str) -> io::Result<Self> {
        let token = std::env::var("_HN_CONTEXT").unwrap_or_default();
        if uuid::Uuid::parse_str(&token).is_err() { return Err(io::Error::other("Open this picker from a Harness shell.")) }
        let base = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".harness/shell-requests");
        let dir = base.join(&token);
        for path in [&base, &dir] {
            if !path.exists() {
                std::fs::create_dir_all(path)?;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
            }
            let m = std::fs::symlink_metadata(path)?;
            if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 { return Err(io::Error::other("The shell request folder is not private.")) }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let path = dir.join(&id);
        let cpath = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())?;
        if unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) } != 0 { return Err(io::Error::last_os_error()) }
        let fifo = match OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW).open(&path) {
            Ok(file) => file,
            Err(e) => { let _ = std::fs::remove_file(&path); return Err(e) }
        };
        let mut request = Self { fifo, path, token, id, verb:kind.into(), query:STANDARD.encode(query), input: Vec::new(), sent:Instant::now(), started:Instant::now() };
        request.send(out)?;
        Ok(request)
    }
    fn send(&mut self, out: &mut File) -> io::Result<()> {
        write!(out, "\x1b]633;hn;{};{};{};{}\x07", self.token, self.id, self.verb, self.query)?;
        out.flush()?;
        self.sent = Instant::now();
        Ok(())
    }
    fn poll_value(&mut self, out: &mut File) -> io::Result<Option<serde_json::Value>> {
        let timeout=if self.verb=="compose-launch" {180}else{100};
        if self.started.elapsed() > Duration::from_secs(timeout) { return Err(io::Error::other("Harness did not answer. Try the command again.")) }
        let mut bytes = [0u8;4096];
        match self.fifo.read(&mut bytes) {
            Ok(n) => self.input.extend_from_slice(&bytes[..n]),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
            Err(e) => return Err(e),
        }
        if self.input.len() > 8192 { return Err(io::Error::other("Invalid picker response.")) }
        if let Some(end) = self.input.iter().position(|b| *b == b'\n') {
            let line = String::from_utf8_lossy(&self.input[..end]);
            let prefix = format!("HN:{}:",self.id);
            let Some(reply) = line.strip_prefix(&prefix) else { return Err(io::Error::other("Invalid picker response.")) };
            let Some((code, data)) = reply.split_once(':') else { return Err(io::Error::other("Invalid picker response.")) };
            if code != "0" {
                let message = STANDARD.decode(data).ok().and_then(|v| String::from_utf8(v).ok()).unwrap_or_default();
                return Err(io::Error::other(if message.is_empty() { "Picker unavailable.".into() } else { message }));
            }
            let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(self.path.with_extension("json"))?;
            let m = file.metadata()?;
            if !m.is_file() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 || m.len() > MAX_DATA { return Err(io::Error::other("Invalid picker catalog.")) }
            return Ok(Some(serde_json::from_reader(file.take(MAX_DATA + 1))?));
        }
        if self.sent.elapsed() >= Duration::from_secs(1) { self.send(out)? }
        Ok(None)
    }
    fn poll(&mut self, out: &mut File) -> io::Result<Option<Items>> {
        self.poll_value(out)?.map(|v| {
            let items: Items=serde_json::from_value(v)?;
            if items.rows.iter().any(|r| r.id.len() > 6000 || r.id.chars().any(char::is_control)) { return Err(io::Error::other("Invalid picker item.")) }
            Ok(items)
        }).transpose()
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        if self.verb=="compose-launch" {if let Ok(mut out)=OpenOptions::new().write(true).open("/dev/tty") {
            let _=write!(out,"\x1b]633;hn;{};{};cancel;\x07",self.token,self.id);
        }}
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("json"));
        if let Some(dir) = self.path.parent() { let _ = std::fs::remove_dir(dir); }
    }
}

fn clean(s: &str) -> String { s.chars().filter(|c| !c.is_control()).collect() }
pub fn exchange(verb:&str,value:&serde_json::Value)->io::Result<serde_json::Value> {
    use std::sync::atomic::{AtomicBool,Ordering};
    static INTERRUPTED:AtomicBool=AtomicBool::new(false);
    extern "C" fn interrupted(_:libc::c_int) {INTERRUPTED.store(true,Ordering::Relaxed);}
    struct Signal(libc::sighandler_t);
    impl Drop for Signal {fn drop(&mut self){unsafe{libc::signal(libc::SIGINT,self.0);}}}
    INTERRUPTED.store(false,Ordering::Relaxed);
    let _signal=Signal(unsafe{libc::signal(libc::SIGINT,interrupted as *const () as libc::sighandler_t)});
    let mut out=OpenOptions::new().read(true).write(true).open("/dev/tty")?;
    let mut request=Request::new(&mut out,verb,&value.to_string())?;
    loop {
        if INTERRUPTED.load(Ordering::Relaxed) {
            write!(out,"\x1b]633;hn;{};{};cancel;\x07",request.token,request.id)?;out.flush()?;
            return Err(io::Error::new(io::ErrorKind::Interrupted,"Launch cancelled."))
        }
        if let Some(value)=request.poll_value(&mut out)? { return Ok(value) }
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn dimensions(rows: u16, origin: u16, picker: &Picker) -> (u16, u16) {
    let height = crate::ui::fzf_rows(rows, theme::fzf_opts().height.unwrap_or(theme::Height {
        size: theme::Size { size: 45.0, percent: true }, inverse: false, auto: false,
    }), picker).max(1).min(rows.max(1));
    (origin.min(rows.saturating_sub(height)), height)
}

fn configure(picker: &mut Picker, sessions: bool) {
    let opts = theme::default_opts();
    let has = |names: &[&str]| opts.iter().any(|v| names.contains(&v.split('=').next().unwrap_or(v)));
    if !has(&["--layout", "--reverse", "+r"]) { theme::fzf_change(|f| f.reverse = true); }
    theme::opts_change(|o| {
        if !has(&["--layout", "--reverse", "+r"]) { o.prompt_top = true; }
        if !has(&["--border", "--no-border", "--style"]) { o.border = Some("rounded".into()); }
        if !has(&["--info", "--inline-info", "--no-info", "--style"]) { o.info_mode = "inline".into(); }
        // A shell finder never runs a global file-preview/info command on session data.
        o.info_command = None;
    });
    picker.preview = sessions;
    picker.multi_override = Some(0);
    // At laptop split widths, keep a useful list. A configured adaptive preview wins.
    let mut pw = theme::fzf_opts().preview_window.clone();
    if matches!(pw.position, 'l'|'r') && pw.alternative.is_none() {
        pw.threshold = 30;
        let mut hidden = pw.clone(); hidden.hidden = true; hidden.threshold = 0;
        pw.alternative = Some(Box::new(hidden));
    }
    picker.preview_window = Some(pw);
}
// crossterm's DSR query writes stdout. During command substitution stdout is the
// selected-id pipe, so redirect only that query to the controlling TTY. Its event
// reader preserves keys typed while waiting for the cursor-position response.
fn tty_position(out: &File) -> io::Result<(u16,u16)> {
    use std::os::fd::{AsRawFd, FromRawFd};
    struct Restore(File);
    impl Drop for Restore { fn drop(&mut self) { unsafe { libc::dup2(self.0.as_raw_fd(),libc::STDOUT_FILENO); } } }
    io::stdout().flush()?;
    let fd=unsafe {libc::dup(libc::STDOUT_FILENO)};
    if fd<0 {return Err(io::Error::last_os_error())}
    let _restore=Restore(unsafe {File::from_raw_fd(fd)});
    if unsafe {libc::dup2(out.as_raw_fd(),libc::STDOUT_FILENO)}<0 {return Err(io::Error::last_os_error())}
    cursor::position()
}
struct Screen {
    out: File, top: u16, height: u16, cols: u16, raw: bool,
    widget: bool, anchor_x: u16, previous: Option<Buffer>,
}
impl Screen {
    fn new(out: File, picker: &Picker) -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let mut screen=Self {out,top:0,height:0,cols:0,raw:true,widget:false,anchor_x:0,previous:None};
        let (cols, rows)=terminal::size().unwrap_or((80,24));
        // cursor::position retries reader errors indefinitely. Initialize the
        // event source first so an unusable input descriptor returns to the shell.
        event::poll(Duration::ZERO)?;
        let (x,y)=tty_position(&screen.out)?;
        screen.widget=x>0 || std::env::var_os("_HN_PICKER_WIDGET").is_some();
        screen.anchor_x=x;
        let (top,height)=dimensions(rows,y.saturating_add(u16::from(screen.widget)),picker);
        screen.top=top;screen.height=height;screen.cols=cols;
        // Widgets are called while Readline/ZLE still owns a draft on this line.
        // Reserve BELOW that line. The shell redraws the draft after we return.
        let reserve=height.saturating_sub(1)+u16::from(screen.widget);
        write!(screen.out,"\r{}\x1b[?2004h", "\r\n".repeat(reserve as usize))?;
        screen.clear()?;
        screen.out.flush()?;
        Ok(screen)
    }
    fn area(&self)->Rect { Rect::new(0,self.top,self.cols,self.height) }
    fn clear(&mut self) -> io::Result<()> {
        self.previous=None;
        // Like fzf's height renderer, clear from our origin to the screen's end.
        // Resizing can bring old rows back from the terminal's reflow buffer,
        // beyond today's picker height. Clearing only the current rectangle
        // leaves those old borders behind (especially with Bash/Readline).
        if self.height>0 {write!(self.out,"\x1b[{};1H\x1b[J",self.top+1)?;}
        Ok(())
    }
    fn resize(&mut self,cols:u16,rows:u16,picker:&Picker)->io::Result<()> {
        self.height=self.height.min(rows.saturating_sub(self.top)); self.clear()?;
        (self.top,self.height)=dimensions(rows,self.top,picker);self.cols=cols;
        self.clear()
    }
    fn draw(&mut self,picker:&mut Picker,items:Option<&Items>,preview_id:Option<&str>)->io::Result<()> {
        let area=self.area();
        let mut next=Buffer::empty(area);
        let valid=items.filter(|v| v.preview_id.as_deref()==preview_id && preview_id.is_some());
        let lines=valid.map(|v|v.preview.iter().map(|s|Line::raw(clean(s))).collect()).unwrap_or_default();
        let bottom=valid.is_some_and(|v|v.preview_bottom);
        let loading=items.is_none() || picker.status.ends_with('…');
        // Loading uses the usual spinner. A failed directory read or catalog
        // warning must remain visible instead of looking like an endless load.
        let previous_empty=std::mem::take(&mut picker.empty);
        if !loading && !picker.status.is_empty() {picker.empty=picker.status.clone();}
        let cursor=crate::ui::inline_fzf(&mut next,area,picker,loading,lines,bottom);
        picker.empty=previous_empty;
        let bytes=render_diff(self.previous.as_ref(),&next,cursor)?;
        self.out.write_all(&bytes)?;
        self.out.flush()?;
        self.previous=Some(next);
        Ok(())
    }
}

fn render_diff(previous:Option<&Buffer>,next:&Buffer,at:Position)->io::Result<Vec<u8>> {
    let blank=Buffer::empty(next.area);
    let previous=previous.filter(|p|p.area==next.area).unwrap_or(&blank);
    let mut bytes=b"\x1b[?2026h\x1b[?7l\x1b[?25l".to_vec();
    let mut backend=CrosstermBackend::new(&mut bytes);
    backend.draw(previous.diff(next).into_iter())?;
    backend.set_cursor_position(at)?;
    write!(bytes,"\x1b[0m\x1b[?25h\x1b[?7h\x1b[?2026l")?;
    Ok(bytes)
}
impl Drop for Screen {
    fn drop(&mut self) {
        if let Ok(token)=std::env::var("_HN_CONTEXT") {
            let _=write!(self.out,"\x1b]633;hn;{};{};close-picker;\x07",token,uuid::Uuid::new_v4());
        }
        let _=self.clear();
        let y=if self.widget {self.top.saturating_sub(1)} else {self.top};
        let x=if self.widget {self.anchor_x.min(self.cols.saturating_sub(1))} else {0};
        if self.height>0 {let _=write!(self.out,"\x1b[0m\x1b[?2004l\x1b[{};{}H\x1b[?25h",y+1,x+1);}
        let _=self.out.flush();
        if self.raw {let _=terminal::disable_raw_mode();}
    }
}

fn edit(picker:&mut Picker,key:event::KeyEvent)->crate::input::End {
    use crate::input::End;
    let ctrl=key.modifiers.contains(KeyModifiers::CONTROL);
    let alt=key.modifiers.contains(KeyModifiers::ALT);
    let shift=key.modifiers.contains(KeyModifiers::SHIFT);
    let up=if theme::fzf().reverse {-1} else {1};
    let name=crate::input::fzf_key_name(&key);
    if let Some(end)=crate::input::finder_binding(picker,&name,up) { return end }
    match key.code {
        KeyCode::Esc=>return End::Abort,
        KeyCode::Char('c'|'g'|'q') if ctrl=>return End::Abort,
        KeyCode::Char('d') if ctrl && picker.query.is_empty()=>return End::Abort,
        KeyCode::Enter=>return End::Accept,
        KeyCode::Up if (shift||alt)=>picker.preview_by(-1),
        KeyCode::Down if (shift||alt)=>picker.preview_by(1),
        KeyCode::PageUp if shift||alt=>picker.preview_by(-(picker.preview_rows.get() as i64)),
        KeyCode::PageDown if shift||alt=>picker.preview_by(picker.preview_rows.get() as i64),
        KeyCode::Up=>picker.move_by(up), KeyCode::Down=>picker.move_by(-up),
        KeyCode::Char('p') if ctrl && theme::fzf_opts().history.is_some()=>picker.history_step(true),
        KeyCode::Char('n') if ctrl && theme::fzf_opts().history.is_some()=>picker.history_step(false),
        KeyCode::Char('p'|'k') if ctrl=>picker.move_by(up),
        KeyCode::Char('n'|'j') if ctrl=>picker.move_by(-up),
        KeyCode::PageUp=>crate::ui::page(picker,up,false),
        KeyCode::PageDown=>crate::ui::page(picker,-up,false),
        KeyCode::Tab=>picker.move_by(-up), KeyCode::BackTab=>picker.move_by(up),
        KeyCode::Left if shift=>picker.qmove(-1,true), KeyCode::Right if shift=>picker.qmove(1,true),
        KeyCode::Left|KeyCode::Right if ctrl||alt=>{},
        KeyCode::Left=>picker.qmove(-1,false), KeyCode::Right=>picker.qmove(1,false),
        KeyCode::Home=>picker.qhome(), KeyCode::End=>picker.qend(),
        KeyCode::Char('a') if ctrl=>picker.qhome(), KeyCode::Char('e') if ctrl=>picker.qend(),
        KeyCode::Char('b') if ctrl=>picker.qmove(-1,false), KeyCode::Char('f') if ctrl=>picker.qmove(1,false),
        KeyCode::Char('u') if ctrl=>picker.clear_query(), KeyCode::Char('w') if ctrl=>picker.backspace(true),
        KeyCode::Char('y') if ctrl=>picker.yank(), KeyCode::Char('h') if ctrl=>picker.backspace(false),
        KeyCode::Char('b') if alt=>picker.qmove(-1,true), KeyCode::Char('f') if alt=>picker.qmove(1,true),
        KeyCode::Char('d') if alt=>picker.kill_word(true),
        KeyCode::Char('/'|'_'|'7') if ctrl=>picker.show_preview(None),
        KeyCode::Char('/') if alt=>picker.toggle_wrap(),
        KeyCode::Backspace=>if alt {picker.kill_word(false)} else {picker.backspace(false)},
        KeyCode::Delete=>picker.delete_forward(), KeyCode::Char('d') if ctrl=>picker.delete_forward(),
        KeyCode::Char(c) if !ctrl && !alt && picker.query.len()+c.len_utf8()<=512=>picker.type_char(c),
        _=>{},
    }
    End::Stay
}

fn completion(kind:&str,row:&Row,rows:&[Row])->io::Result<String> {
    match kind {
        "host"=>Ok(if rows.iter().filter(|r|r.label==row.label).count()==1 {row.label.clone()} else {row.id.clone()}),
        "model" if row.id=="default"=>Ok("default".into()),
        "model"=>{
            let value=STANDARD.decode(row.id.strip_prefix("model:").unwrap_or(""))
                .ok().and_then(|v|serde_json::from_slice::<serde_json::Value>(&v).ok())
                .ok_or_else(||io::Error::other("That model is no longer available."))?;
            let (Some(grid),Some(model))=(value["grid"].as_str(),value["model"].as_str()) else {return Err(io::Error::other("Invalid model route."))};
            Ok(format!("{grid} :: {model}"))
        },
        _=>Ok(row.id.clone()),
    }
}

// Scope characters belong to this picker, never to the shell's command line.
// Quoting a leading character keeps fzf's literal search (for example ':todo).
fn choice_kind(query:&str)->&'static str {
    if query.starts_with('@') {"host"} else if query.starts_with([':', '%']) {"model"} else {"sessions"}
}
fn choice_query<'a>(query:&'a str,unified:bool,kind:&str)->&'a str {
    if unified && kind!="sessions" && query.starts_with(['&','@',':','%']) {&query[1..]} else {query}
}
fn scope_picker(picker:&mut Picker,kind:&str,unified:bool) {
    picker.title=match kind {"host"=>"Computers","model"=>"Models",_=>"Sessions"}.into();
    picker.placeholder=if unified && kind=="sessions" {"sessions   @ computers   : models"} else {"Search"}.into();
    picker.prefixed=unified && kind!="sessions";
}

/// Keep the literal path separate from the fuzzy pattern for its children.
/// `code/` means browse code, `code/api` means fuzzy-find api inside code.
pub fn folder_parts(query:&str)->(Option<&str>, &str) {
    match query.rsplit_once('/') {
        Some(("", leaf)) => (Some("/"), leaf),
        Some((parent, leaf)) => (Some(parent), leaf),
        None => (None, query),
    }
}
pub(crate) fn folder_filter(picker:&mut Picker, folder:bool) {
    let query=folder_parts(picker.query.strip_prefix(':').unwrap_or(&picker.query)).1;
    if folder {
        let opts=theme::fzf_opts();
        let case=match opts.case {Some(true)=>crate::fzf::Case::Respect,Some(false)=>crate::fzf::Case::Ignore,None=>crate::fzf::Case::Smart};
        let pattern=if opts.no_extended {crate::fzf::Query::plain(query,case,!opts.exact,!opts.literal)}
            else {crate::fzf::Query::parse(query,case,!opts.exact,!opts.literal)};
        for row in &mut picker.rows {
            let name=row.id.trim_end_matches('/').rsplit('/').next().unwrap_or(&row.id);
            row.tier=u8::from(pattern.matches(&name.chars().collect::<Vec<_>>()).is_none());
        }
    }
    let search=folder.then(|| format!(":{query}"));
    // Editing keeps the result position, not the intermediate match selected
    // before basename ranking.
    if folder && picker.search!=search && !picker.tracking() {picker.selected_id=None;}
    picker.search=search;
    picker.refilter();
}
fn folder_key(picker:&mut Picker, items:Option<&Items>, key:event::KeyEvent)->bool {
    let next=match (key.code,key.modifiers) {
        (KeyCode::Tab|KeyCode::Right,KeyModifiers::NONE)=>picker.current().filter(|r|!r.disabled).map(|r|r.id.clone()),
        (KeyCode::Up,KeyModifiers::ALT)=>{
            items.and_then(|i|i.folder.as_deref())
                .or_else(||folder_parts(picker.query.strip_prefix(':').unwrap_or(&picker.query)).0)
                .map(|path| {
                let path=path.trim_end_matches('/');
                // fs_list_dir is fenced at the account's home. Stay at ~ there.
                if path.is_empty() {"/".into()}
                else if path=="~" {"~".into()}
                else {path.rsplit_once('/').map(|(parent,_)|if parent.is_empty(){"/"}else{parent}).unwrap_or("~").into()}
            })
        },
        _=>return false,
    };
    if let Some(path)=next {
        picker.query=format!(":{}/",path.trim_end_matches('/'));
        picker.qend();
    }
    true
}

pub fn run(args:&[String])->io::Result<i32> {
    let source=args.first().map(String::as_str).unwrap_or("");
    if !matches!(source,"host"|"model"|"sessions"|"choose"|"compose") {return Err(io::Error::other("Unknown shell picker."))}
    let agents=source=="compose" && args.iter().skip(3).any(|a|a=="--agents");
    let line=args.get(1).map(String::as_str).unwrap_or("");
    let mut cursor=args.get(2).and_then(|c|c.parse::<usize>().ok()).unwrap_or(line.chars().count());
    if args.iter().skip(3).any(|a|a=="--bytes") { cursor=line.get(..cursor).map(|s|s.chars().count()).unwrap_or(line.chars().count()); }
    let mut draft=if source=="compose" {crate::shell_composer::Draft::new(line,cursor)} else {None};
    // A machine choice is committed even if its follow-up folder picker is
    // cancelled. The old computer's folder must never come back with Escape.
    let mut committed:Option<(String,usize)>=None;
    let automatic=source=="compose" && args.iter().skip(3).any(|a|a=="--auto");
    if automatic && !draft.as_ref().is_some_and(|d|d.automatic()) { return Ok(130) }
    if agents && draft.is_none() {return Err(io::Error::other("Clear this command before choosing an agent."))}
    // The shortcut scopes never depend on what the shell draft contains.
    // Non-agent drafts retain the context switcher and literal path insertion.
    let composing=source=="compose";
    let unified=source=="choose";
    if uuid::Uuid::parse_str(&std::env::var("_HN_CONTEXT").unwrap_or_default()).is_err() {return Err(io::Error::other("Open this picker from a Harness shell."))}
    let mut picker=Picker::new("","");
    picker.query=if automatic {draft.as_ref().unwrap().initial()} else if source=="compose" {String::new()} else {clean(args.get(1).map(String::as_str).unwrap_or("")).chars().take(128).collect()};picker.qend();
    let unified=unified || source=="compose";
    let compose_kind=|query:&str| if !composing {choice_kind(query)} else {
        composer_kind(query,agents)
    };
    let mut kind=if unified {compose_kind(&picker.query)} else {source};
    configure(&mut picker,kind=="sessions");
    scope_picker(&mut picker,kind,unified);
    if composing {compose_scope(&mut picker,kind);}
    folder_filter(&mut picker,composing && kind=="folder");
    let out=OpenOptions::new().read(true).write(true).open("/dev/tty")?;
    let mut screen=Screen::new(out,&picker)?;
    let mut items:Option<Items>=None;
    let mut request:Option<Request>=None;
    let mut requested_preview=None;
    let mut last_query=String::new();
    let mut due=Instant::now();
    let mut last_id=None;
    let mut dirty=true;
    loop {
        let current=picker.current_id();
        if current!=last_id {
            last_id=current;picker.preview_scroll.set(0);picker.preview_fresh.set(true);
            // Local navigation paints immediately; fetch the selected tail after a
            // brief settle, so a held arrow doesn't launch a preview for every row.
            if picker.preview {due=Instant::now()+Duration::from_millis(35);}
        }
        if dirty {
            theme::begin_animation_frame(true);
            screen.draw(&mut picker,items.as_ref(),last_id.as_deref())?;dirty=false;
        }
        if request.is_none() && Instant::now()>=due {
            requested_preview=if picker.preview {picker.current_id()} else {None};
            let mut data=serde_json::json!({"query":if kind=="part" {picker.query.as_str()} else {choice_query(&picker.query,unified,kind)},"revision":items.as_ref().map(|i|i.revision.as_str()).unwrap_or(""),"width":picker.text_w.max(1),"preview":requested_preview});
            let catalog=composing && kind!="sessions" && (draft.is_some() || matches!(kind,"folder"|"agent"));
            if catalog {
                data["compose"]=draft.as_ref().map(|d|d.metadata()).unwrap_or_else(||serde_json::json!({"cwd":std::env::current_dir().ok().map(|p|p.to_string_lossy().into_owned())}));
                data["kind"]=serde_json::json!(kind);
            }
            let verb=if catalog {"list-compose".to_string()} else {format!("list-{kind}")};
            request=Some(Request::new(&mut screen.out,&verb,&data.to_string())?);
            last_query=picker.query.clone();
        }
        if let Some(r)=&mut request {
            if let Some(mut value)=r.poll(&mut screen.out)? {
                if !value.unchanged {
                    // Older preview servers omit this optional field. The request
                    // still supplies the exact id; never associate it with today's cursor.
                    if value.preview_id.is_none() {value.preview_id=requested_preview.clone();}
                    if items.as_ref().is_none_or(|old|!value.same_catalog(old)) {
                        value.apply_catalog(&mut picker,composing && kind=="folder");
                    }
                    picker.status=value.notice.clone();
                    items=Some(value);dirty=true;
                }
                request=None;
                due=Instant::now()+if last_query!=picker.query || (picker.preview&&requested_preview!=picker.current_id()) {Duration::ZERO} else {Duration::from_millis(600)};
            }
        }
        if !event::poll(Duration::from_millis(16))? {continue}
        let old_query=picker.query.clone();
        let old_preview=picker.preview;
        let mut end=crate::input::End::Stay;
        match event::read()? {
            Event::Resize(w,h)=>{screen.resize(w,h,&picker)?;due=Instant::now();dirty=true;},
            Event::Paste(text)=>{
                let mut remaining=512usize.saturating_sub(picker.query.len());
                let text:String=text.replace(['\n','\r']," ").chars().filter(|c|!c.is_control())
                    .take_while(|c|if c.len_utf8()<=remaining {remaining-=c.len_utf8();true}else{false}).collect();
                picker.type_text(&text);dirty=true;
            },
            Event::Key(key) if key.kind!=event::KeyEventKind::Release=>{
                picker.flash=None;
                if key.code==KeyCode::Char('l')&&key.modifiers.contains(KeyModifiers::CONTROL) {screen.clear()?;}
                if !(composing && kind=="folder" && folder_key(&mut picker,items.as_ref(),key)) {
                    end=edit(&mut picker,key);
                }
                dirty=true;
            },_=>{},
        }
        if (automatic || committed.is_some()) && old_query != picker.query && picker.query.is_empty() {
            // An automatically opened picker is completing the current token,
            // not starting a fresh Ctrl-P search when that token is erased.
            if let Some((line, cursor)) = committed.clone().or_else(|| draft.as_ref().and_then(|d| d.erase_automatic_trigger())) {
                drop(request); drop(screen);
                println!("edit\n{cursor}\n{line}");
                return Ok(0);
            }
        }
        if old_query!=picker.query {
            due=Instant::now()+Duration::from_millis(150);
            if let Some(action)=crate::input::finder_binding(&mut picker,"change",if theme::fzf().reverse {-1}else{1}) {end=action;}
            if composing && kind=="folder" && folder_parts(old_query.strip_prefix(':').unwrap_or(&old_query)).0!=folder_parts(picker.query.strip_prefix(':').unwrap_or(&picker.query)).0 {
                // A late reply from the old folder must never be selectable in
                // the new one, even though both requests use the same scope.
                request=None;items=None;last_id=None;
                Items::default().apply(&mut picker);due=Instant::now();
            }
        }
        if old_query!=picker.query {
            let next=compose_kind(&picker.query);
            if composing {compose_scope(&mut picker,next);}
            folder_filter(&mut picker,composing && next=="folder");
        }
        if unified {
            let next=compose_kind(&picker.query);
            if next!=kind {
                // A delayed session/model response must never supply selectable
                // rows after the user has switched to a different kind of action.
                request=None;items=None;requested_preview=None;last_id=None;
                kind=next;scope_picker(&mut picker,kind,true);
                if composing {compose_scope(&mut picker,kind);}
                Items::default().apply(&mut picker);
                picker.preview=kind=="sessions";
                due=Instant::now();dirty=true;
            }
        }
        if old_preview!=picker.preview {due=Instant::now();}
        match end {
            crate::input::End::Abort=>{
                if let Some((line,cursor))=committed {
                    drop(request);drop(screen);println!("edit\n{cursor}\n{line}");return Ok(0)
                }
                return Ok(130)
            },
            crate::input::End::Accept=>{
                if composing && kind=="part" {
                    if let Some(id)=picker.current_id() {picker.query=id;picker.qend();kind=compose_kind(&picker.query);compose_scope(&mut picker,kind);folder_filter(&mut picker,kind=="folder");request=None;items=None;Items::default().apply(&mut picker);due=Instant::now();dirty=true;}
                    continue
                }
                if let Some(current)=&draft { if kind!="sessions" {
                    if let Some(row)=picker.current().filter(|r|!r.disabled) {
                        if kind=="host" && host_changed(current,row,items.as_ref()) {
                            let (line,cursor)=current.change_host(&row.id).map_err(io::Error::other)?;
                            draft=Some(crate::shell_composer::Draft::new(&line,cursor)
                                .ok_or_else(||io::Error::other("This command cannot be completed."))?);
                            committed=Some((line,cursor));
                            // Drop the old catalog before drawing or accepting
                            // another key. A stale local row cannot be selected
                            // while the chosen computer's folders load.
                            request=None;items=None;requested_preview=None;last_id=None;
                            picker.query=":".into();picker.qend();kind="folder";
                            scope_picker(&mut picker,kind,true);compose_scope(&mut picker,kind);
                            Items::default().apply(&mut picker);folder_filter(&mut picker,true);
                            due=Instant::now();dirty=true;
                            continue
                        }
                        let (line,cursor)=current.apply(kind,&row.id).map_err(io::Error::other)?;
                        drop(request);drop(screen);println!("edit\n{cursor}\n{line}");return Ok(0)
                    }
                    continue
                } }
                if composing && kind=="folder" {
                    if let Some(row)=picker.current().filter(|r|!r.disabled) {
                        let (line,cursor)=crate::shell_composer::insert_folder(line,cursor,&row.id).map_err(io::Error::other)?;
                        drop(request);drop(screen);println!("edit\n{cursor}\n{line}");return Ok(0)
                    }
                    continue
                }
                if composing && kind=="agent" {return Err(io::Error::other("Clear this command before choosing an agent."))}
                let id=picker.current().filter(|r|!r.disabled).map(|r|
                    if args.iter().skip(2).any(|a|a=="--completion") {completion(kind,r,&picker.rows)} else {Ok(r.id.clone())}
                ).transpose()?;
                picker.history_add();
                drop(request);drop(screen);
                if let Some(id)=id {
                    if unified {println!("{kind}");}
                    println!("{id}");return Ok(0)
                } else {return Ok(1)}
            },
            crate::input::End::Stay=>{},
        }
    }
}

fn host_changed(draft:&crate::shell_composer::Draft,row:&Row,items:Option<&Items>)->bool {
    if let Some(machine)=items.and_then(|i|i.machine.as_deref()) {
        return machine!=row.extra;
    }
    // Compatibility with an older catalog: preserve an exact known host, and
    // otherwise ask for a new folder rather than reuse one on an unknown host.
    !draft.launch.host.as_deref().is_some_and(|host|host.eq_ignore_ascii_case(&row.id))
}

fn composer_kind(query:&str,agents:bool)->&'static str {
    match query.chars().next() {
        Some('&')=>"agent", Some('@')=>"host", Some(':')=>"folder", Some('%')=>"model",
        _=>if agents {"agent"} else {"sessions"},
    }
}
fn compose_scope(picker:&mut Picker,kind:&str) {
    picker.title=match kind {"agent"=>"Agent","host"=>"Computer","folder"=>"Project","model"=>"Model",_=>"Compose"}.into();
    picker.placeholder=match kind {"sessions"=>"Search sessions","agent"=>"Search agents","part"=>"@ computer   : project   % model",_=>"Search"}.into();
    picker.prefixed=!["part","sessions"].contains(&kind) && picker.query.starts_with(['&','@',':','%']);
    picker.scope_prefix=match kind {"agent"=>Some('&'),"model"=>Some('%'),_=>None};
    picker.preview=kind=="sessions";
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn machine_identity_preserves_folders_for_current_computer_and_aliases() {
        let row=Row::new("M2","M2").extra("local-id");
        let items=Items{machine:Some("local-id".into()),..Items::default()};
        for line in ["codex :~/repo", "codex @local:~/repo", "codex @m2 :~/repo", "codex @local-id:~/repo"] {
            let draft=crate::shell_composer::Draft::new(line,line.chars().count()).unwrap();
            assert!(!host_changed(&draft,&row,Some(&items)),"{line}");
            let (line,cursor)=draft.apply("host",&row.id).unwrap();
            assert_eq!(crate::shell_composer::Draft::new(&line,cursor).unwrap().launch.path.as_deref(),Some("~/repo"));
            let other=Row::new("Office","Office").extra("remote-id");
            assert!(host_changed(&draft,&other,Some(&items)),"{line}");
        }
        let old:Items=serde_json::from_str("{\"rows\":[]}").unwrap();
        assert!(old.machine.is_none(),"optional identity must accept older catalogs");
    }
    #[test]
    fn ctrl_n_and_ctrl_p_share_scopes_with_different_blank_defaults() {
        for agents in [false,true] {
            for (query,kind) in [("",if agents {"agent"} else {"sessions"}),("cla",if agents {"agent"} else {"sessions"}),("@office","host"),(":code","folder"),("%llama","model")] {
                assert_eq!(composer_kind(query,agents),kind);
            }
        }
        let mut picker=Picker::new("","");
        picker.query="clau".into();compose_scope(&mut picker,"agent");picker.qend();
        picker.set_rows(vec![Row::new("claude","Claude Code"),Row::new("codex","Codex")]);
        assert_eq!(picker.current_id().as_deref(),Some("claude"));
        assert_eq!(choice_query("clau",true,"agent"),"clau");
        assert_eq!(choice_query("",true,"agent"),"");
        picker.clear_query();assert_eq!(picker.query,"");
    }
    #[test]
    fn folder_names_rank_ahead_of_their_children_on_exact_and_fuzzy_search() {
        let mut picker=Picker::new("","");
        picker.set_rows(["~/code/work/autonomous-harness/src", "~/code/work/autonomous-harness", "~/code/work/autonomous-harness/src/日本"].into_iter().map(|p|Row::new(p,p)).collect());
        for query in [":autonomous-harness",":atnmhrns"] {
            picker.query=query.into();compose_scope(&mut picker,"folder");folder_filter(&mut picker,true);
            assert_eq!(picker.rows[picker.visible[0].0].id,"~/code/work/autonomous-harness");
            assert_eq!(picker.current_id().as_deref(),Some("~/code/work/autonomous-harness"));
        }
    }
    #[test]
    fn folder_scan_keeps_result_position_when_better_matches_arrive() {
        theme::fzf_reset();
        let mut picker=Picker::new("","");
        picker.query=":cd".into();compose_scope(&mut picker,"folder");
        let root=Item{id:"~/project".into(),label:"~/project".into(),right:"this folder".into(),..Item::default()};
        let first=Items{rows:vec![root.clone()],..Items::default()};
        first.apply_catalog(&mut picker,true);
        assert_eq!(picker.current_id().as_deref(),Some("~/project"));
        let scanned=Items{rows:vec![root,Item{id:"~/project/code".into(),label:"~/project/code".into(),..Item::default()}],..Items::default()};
        scanned.apply_catalog(&mut picker,true);
        assert_eq!(picker.current_id().as_deref(),Some("~/project/code"));
        assert!(folder_key(&mut picker,None,event::KeyEvent::new(KeyCode::Tab,KeyModifiers::NONE)));
        assert_eq!(picker.query,":~/project/code/");
    }
    #[test]
    fn folder_scan_respects_tracking_and_nonfolder_catalogs_keep_the_item() {
        theme::fzf_reset();
        for folder in [false,true] {
            let mut picker=Picker::new("","");
            picker.query=":cd".into();compose_scope(&mut picker,"folder");
            let root=Item{id:"~/project".into(),label:"~/project".into(),right:"this folder".into(),..Item::default()};
            Items{rows:vec![root.clone()],..Items::default()}.apply_catalog(&mut picker,true);
            if folder {picker.track_current=picker.current_id();}
            Items{rows:vec![root,Item{id:"~/project/code".into(),label:"~/project/code".into(),..Item::default()}],..Items::default()}.apply_catalog(&mut picker,folder);
            assert_eq!(picker.current_id().as_deref(),Some("~/project"));
        }
    }
    #[test]
    fn folder_browsing_filters_only_the_leaf_and_preserves_paths() {
        let mut picker=Picker::new("","");
        picker.query=":~/code/cl日".into();picker.qend();compose_scope(&mut picker,"folder");
        folder_filter(&mut picker,true);
        picker.set_rows(vec![Row::new("~/code/client 日本","client 日本/"),Row::new("~/code/other","other/")]);
        assert_eq!(picker.current_id().as_deref(),Some("~/code/client 日本"));
        assert!(folder_key(&mut picker,None,event::KeyEvent::new(KeyCode::Tab,KeyModifiers::NONE)));
        assert_eq!(picker.query,":~/code/client 日本/");
        // Going back immediately also works before the first directory reply.
        assert!(folder_key(&mut picker,None,event::KeyEvent::new(KeyCode::Up,KeyModifiers::ALT)));
        assert_eq!(picker.query,":~/code/");
        folder_filter(&mut picker,true);assert_eq!(picker.visible.len(),2);
        picker.query=":~/code/code".into();folder_filter(&mut picker,true);
        assert!(picker.visible.is_empty(),"the shared parent matched every child");
        for (path, expected) in [("/","/"),("~","~"),("~/code","~"),("/home/code","/home")] {
            let items=Items{folder:Some(path.into()),..Items::default()};
            folder_key(&mut picker,Some(&items),event::KeyEvent::new(KeyCode::Up,KeyModifiers::ALT));
            assert_eq!(picker.query,format!(":{}/",expected.trim_end_matches('/')));
        }
        assert!(!folder_key(&mut picker,None,event::KeyEvent::new(KeyCode::Enter,KeyModifiers::NONE)));
        assert!(!folder_key(&mut picker,None,event::KeyEvent::new(KeyCode::Right,KeyModifiers::SHIFT)));
        folder_filter(&mut picker,false);assert!(picker.search.is_none());
    }
    #[test]
    fn composer_scopes_filter_and_edit_without_becoming_literal_terms() {
        for (kind,prefix,query,label) in [("agent",'&',"clau","Claude Code"),("model",'%',"son","sonnet"),("host",'@',"off","Office"),("folder",':',"repo","~/repo")] {
            let mut picker=Picker::new("","");picker.query=format!("{prefix}{query}");picker.qend();compose_scope(&mut picker,kind);
            picker.set_rows(vec![Row::new("chosen",label)]);assert_eq!(picker.current_id().as_deref(),Some("chosen"),"{kind}");
            picker.clear_query();assert_eq!(picker.query,prefix.to_string());picker.backspace(false);assert!(picker.query.is_empty());
        }
    }
    #[test]
    fn scope_characters_filter_only_the_unified_picker_and_can_be_removed() {
        let mut picker=Picker::new("","");
        picker.query="@office".into();picker.qend();
        let kind=choice_kind(&picker.query);
        scope_picker(&mut picker,kind,true);
        picker.set_rows(vec![Row::new("remote","Office"),Row::new("local","M2")]);
        assert_eq!(picker.current_id().as_deref(),Some("remote"));
        assert_eq!(choice_query(&picker.query,true,"host"),"office");
        assert_eq!(choice_query(&picker.query,false,"host"),"@office");
        picker.clear_query();assert_eq!(picker.query,"@");
        picker.backspace(false);assert_eq!(picker.query,"");
        assert_eq!(choice_kind(&picker.query),"sessions");
        // fzf's quoted exact search still finds session titles beginning with a
        // scope character; unimplemented desktop scopes are ordinary searches.
        for query in ["'@office", "':todo", "#project", "&agent"] {assert_eq!(choice_kind(query),"sessions");}
        picker.query=":qwen".into();picker.qend();scope_picker(&mut picker,"model",true);
        Items::default().apply(&mut picker);
        assert!(picker.current_id().is_none(),"a previous scope's row remained selectable");
        picker.set_rows(vec![Row::new("route","qwen3")]);
        assert_eq!(picker.current_id().as_deref(),Some("route"));
        theme::fzf_reset();
    }
    #[test]
    fn geometry_stays_inside_short_and_resized_terminals() {
        let picker=Picker::new("","");
        for rows in 1..90 {for origin in 0..100 {let (top,height)=dimensions(rows,origin,&picker);assert!(height>0&&top+height<=rows);}}
    }
    #[test]
    fn wire_roundtrip_uses_the_same_picker_filter_and_ranking() {
        let mut source=Picker::new("","");
        source.set_rows(vec![Row::new("a","Fix workspace navigation").extra("codex"),Row::new("b","Old terminal")]);
        let data=serde_json::to_vec(&Items::from_picker(&source)).unwrap();
        let wire:Items=serde_json::from_slice(&data).unwrap();
        let mut inline=Picker::new("","");wire.apply(&mut inline);
        for query in ["fxwsp","'workspace","!terminal","codex | old","^Fix","missing"] {
            source.query=query.into();source.refilter();inline.query=query.into();inline.refilter();
            assert_eq!(inline.visible,source.visible,"{query}");
        }
    }
    #[test]
    fn inline_renderer_survives_tiny_resizes_and_preserves_its_query() {
        let mut picker=Picker::new("","");
        configure(&mut picker,true);
        picker.set_rows(vec![Row::new("1","日本語 café 👩‍💻").right("M2")]);
        picker.type_text("日本");
        for w in [1,2,3,5,10,12,20,40,80,140] { for h in 1..24 {
            let area=Rect::new(0,0,w,h);
            let mut buf=Buffer::empty(area);
            let at=crate::ui::inline_fzf(&mut buf,area,&mut picker,false,vec![Line::raw("日本語 transcript")],false);
            assert!(area.contains(at),"{w}x{h}: {at:?}");
            assert_eq!(picker.query,"日本");
        } }
        theme::fzf_reset();
    }
    #[test]
    fn repainting_the_same_frame_does_not_erase_or_retransmit_the_list() {
        let mut picker=Picker::new("","");
        configure(&mut picker,false);
        picker.set_rows((0..100).map(|n|Row::new(n.to_string(),format!("Session {n}: useful title"))).collect());
        let area=Rect::new(0,4,120,18);
        let mut first=Buffer::empty(area);
        let at=crate::ui::inline_fzf(&mut first,area,&mut picker,false,vec![],false);
        let full=render_diff(None,&first,at).unwrap();
        let idle=render_diff(Some(&first),&first,at).unwrap();
        assert!(idle.len()<100&&idle.len()*10<full.len(),"full={} idle={}",full.len(),idle.len());
        picker.move_by(1);
        let mut next=Buffer::empty(area);
        let at=crate::ui::inline_fzf(&mut next,area,&mut picker,false,vec![],false);
        let moved=render_diff(Some(&first),&next,at).unwrap();
        assert!(!moved.windows(4).any(|w|w==b"\x1b[2K"),"navigation erased a row");
        assert!(moved.len()<full.len()/2,"full={} move={}",full.len(),moved.len());
        theme::fzf_reset();
    }
    #[test]
    fn paste_is_inserted_at_the_query_cursor_and_fzf_editing_keys_work() {
        let mut picker=Picker::new("","");
        picker.set_rows(vec![Row::new("1","日本 café suffix")]);
        picker.type_text(" suffix");picker.qhome();picker.type_text("日本 café");
        assert_eq!(picker.query,"日本 café suffix");assert_eq!(picker.qcursor,7);
        edit(&mut picker,event::KeyEvent::new(KeyCode::Char('a'),KeyModifiers::CONTROL));
        edit(&mut picker,event::KeyEvent::new(KeyCode::Char('f'),KeyModifiers::CONTROL));
        edit(&mut picker,event::KeyEvent::new(KeyCode::Char('d'),KeyModifiers::CONTROL));
        assert_eq!(picker.query,"日 café suffix");
        assert_eq!(picker.qcursor,1);
        assert!(matches!(edit(&mut picker,event::KeyEvent::new(KeyCode::Esc,KeyModifiers::NONE)),crate::input::End::Abort));
    }
    #[test]
    fn preview_updates_do_not_rebuild_an_unchanged_catalog() {
        let mut picker=Picker::new("","");picker.set_rows(vec![Row::new("1","First"),Row::new("2","Second")]);
        let first=Items::from_picker(&picker);
        let mut second=first.clone();second.preview=vec!["A later tail".into()];second.preview_id=Some("2".into());
        assert!(first.same_catalog(&second));
        second.rows[0].label="Renamed".into();assert!(!first.same_catalog(&second));
    }
}
