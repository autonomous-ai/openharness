//! A port of daemons/tools/card.mjs: a daemon's card and a drop's shelf (the box back), as text for a
//! fenced code block and as SVG for places a code block does not travel. Never a live mood: a card
//! is a portrait, not a presence indicator. Checked against daemons/frames.json (`cards`).
//! A filled daemon's card shows its portrait plate at the card's version, idle, frame 0. An
//! individual's card says its name (`pip the tim 2.0  #0042`), its flags wrapped as a long command
//! is, and how rare it is (`1 in 2,130`), on its own portrait plate once harnessd has drawn it, else
//! its species'.

use super::plates::{self, PORTRAIT};
use super::render::{individual_flags, one_in, portrait, sprite, thousands, Opts, Traits};
use super::roster::{Daemon, DropDef, Roster};

pub const W: usize = 42;
pub const INNER: usize = W - 4;

fn regulars<'r>(roster: &'r Roster, drop: &str) -> Vec<&'r Daemon> {
    roster.daemons.iter().filter(|x| x.rarity != "secret" && x.drop == drop).collect()
}

/// `#03/09`, or `#S/09` for a secret: secrets sit outside the numbered set.
pub fn card_number(roster: &Roster, d: &Daemon) -> String {
    let set = regulars(roster, &d.drop);
    let of = format!("{:02}", set.len());
    if d.rarity == "secret" { return format!("#S/{of}") }
    let at = set.iter().position(|x| x.id == d.id).map(|i| i as i64).unwrap_or(-1) + 1;
    format!("#{at:02}/{of}")
}

fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut line = String::new();
    for word in text.split(' ') {
        if format!("{line} {word}").trim().len() > width { out.push(line.trim().to_string()); line = word.to_string() } else { line.push(' '); line.push_str(word) }
    }
    if !line.trim().is_empty() { out.push(line.trim().to_string()) }
    out
}

/// What a card says besides the daemon: its version, whether it is shiny, its serial, its name,
/// the day it hatched and the egg it came from — and, for an individual, its traits and its own
/// portrait plate (`plate`, idle, frame 0, as harnessd draws it; else the species').
#[derive(Clone, Debug, Default)]
pub struct CardOpts {
    pub version: Option<String>,
    pub shiny: bool,
    pub serial: Option<String>,
    pub name: Option<String>,
    pub hatched: Option<String>,
    pub egg: Option<String>,
    pub traits: Option<Traits>,
    pub plate: Option<Vec<String>>,
}

/// card.mjs `flagLines`: an individual's flags as card lines, `width` at most, wrapped at spaces as a
/// long command is — every line but the last ending in ` \`, the lines after the first indented two.
pub fn flag_lines(flags: &str, width: usize) -> Vec<String> {
    let words: Vec<&str> = flags.split(' ').collect();
    let mut out: Vec<String> = Vec::new();
    let mut line = String::new();
    for (i, word) in words.iter().enumerate() {
        let indent = if out.is_empty() { "" } else { "  " };
        let next = format!("{indent}{line} {word}");
        // A line that breaks keeps room for its ` \`; the last line may run to the edge.
        if line.is_empty() { line = word.to_string() }
        else if next.len() + 2 <= width || (i == words.len() - 1 && next.len() <= width) { line.push(' '); line.push_str(word) }
        else { out.push(format!("{indent}{line} \\")); line = word.to_string() }
    }
    let indent = if out.is_empty() { "" } else { "  " };
    out.push(format!("{indent}{line}"));
    out
}

/// `1 in 2,130`.
pub fn one_in_text(n: u64) -> String { format!("1 in {}", thousands(n)) }

fn pad_cut(s: &str, n: usize) -> String {
    let mut out = format!("{s:<n$}");
    out.truncate(n);
    out
}

fn drop_of(roster: &Roster, d: &Daemon) -> DropDef {
    roster.drops.iter().find(|x| x.id == d.drop).cloned().unwrap_or(DropDef { id: d.drop.clone(), n: 1, name: d.drop.clone(), announce: None, release: None, hold: false })
}

/// What a card shows of the daemon: its portrait plate (idle, frame 0) when it is drawn filled, else
/// its line portrait. Never a live mood.
pub fn card_art(roster: &Roster, d: &Daemon, version: &str) -> Vec<String> {
    if d.plate { plates::rows(&d.id, PORTRAIT, version, "idle", 0) } else { portrait(roster, d, version, "idle", Opts::still()) }
}

/// The card as lines of printable ASCII, 42 columns wide.
pub fn card_lines(roster: &Roster, d: &Daemon, o: &CardOpts) -> Vec<String> {
    let version = o.version.clone().unwrap_or_else(|| roster.rules.versions[0].clone());
    let drop = drop_of(roster, d);
    let l = |s: &str| format!("| {} |", pad_cut(s, INNER));
    let head = format!("{}  DROP {}: {}", card_number(roster, d), drop.n, drop.name.to_uppercase());
    let rarity = format!("{}{}", if o.shiny { "SHINY " } else { "" }, d.rarity.to_uppercase());
    let serial = o.serial.as_ref().map(|s| format!("  #{s:0>4}")).unwrap_or_default();
    let name = format!("{}{} {version}{serial}", o.name.as_ref().map(|n| format!("{n} the ")).unwrap_or_default(), d.id);
    let art = o.plate.clone().unwrap_or_else(|| card_art(roster, d, &version));
    let width = art.iter().map(String::len).max().unwrap_or(0);
    let pad = INNER.saturating_sub(width) / 2;
    let mut out = vec![format!(".{}.", "-".repeat(W - 2))];
    out.push(l(&format!("{head}{}{rarity}", " ".repeat(INNER.saturating_sub(head.len() + rarity.len()).max(1)))));
    out.push(l(""));
    for line in &art { out.push(l(&format!("{}{line}", " ".repeat(pad)))) }
    out.push(l(""));
    out.push(l(&format!("  {name}")));
    if let Some(t) = &o.traits {
        for line in flag_lines(&individual_flags(roster, &d.id, t), INNER - 2) { out.push(l(&format!("  {line}"))) }
        out.push(l(&format!("  {}", one_in_text(one_in(roster, &d.id, t)))));
    }
    out.push(l(&format!("  {}", d.lineage())));
    out.push(l(""));
    for line in wrap(&format!("\"{}\"", d.first), INNER - 2) { out.push(l(&format!("  {line}"))) }
    if o.hatched.is_some() || o.egg.is_some() {
        out.push(l(""));
        let text = format!("  hatched {}{}", o.hatched.clone().unwrap_or_default(), o.egg.as_ref().map(|e| format!(", {e} egg")).unwrap_or_default());
        // `.replace(/\s+,/, ',')`: a missing date leaves `hatched , first egg`.
        let text = match text.find(',') { Some(i) if text[..i].ends_with(' ') => format!("{}{}", text[..i].trim_end(), &text[i..]), _ => text };
        out.push(l(&text));
    }
    out.push(format!("'{}'", "-".repeat(W - 2)));
    out
}

/// Days since 1970-01-01 of a `YYYY-MM-DD` (UTC midnight).
pub fn day_number(day: &str) -> Option<i64> {
    let mut it = day.split('-');
    let (y, m, d): (i64, i64, i64) = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

/// A drop's state `now_ms` (ms since the epoch): `released`, `announced` (silhouettes) or `hidden`.
/// A drop on hold is hidden whatever its dates (it has none): never drawn, hatched or shown.
pub fn drop_state(drop: Option<&DropDef>, now_ms: i64) -> &'static str {
    let at = |day: &str| day_number(day).map(|n| n * 86_400_000);
    let Some(drop) = drop else { return "released" };
    if drop.hold { return "hidden" }
    match drop.release.as_deref().and_then(at) {
        None => "released",
        Some(r) if r <= now_ms => "released",
        _ => if drop.announce.as_deref().and_then(at).map(|a| a <= now_ms).unwrap_or(false) { "announced" } else { "hidden" },
    }
}

/// The hatchling before it has colour: every drawn cell becomes `#`.
pub fn silhouette(s: &str) -> String { s.chars().map(|c| if c == ' ' { ' ' } else { '#' }).collect() }

/// A daemon on the shelf, and how many duplicates were merged into it.
#[derive(Clone, Debug, Default)]
pub struct Shelved { pub id: String, pub dupes: u32 }

/// A shelf: the drop's sprites in order, `[ ? ]` for missing regulars, `[ ! ]` for a missing secret,
/// `x2` beside a daemon with a duplicate merged into it.
pub fn shelf_lines(roster: &Roster, owned: &[Shelved], drop: Option<&str>, now_ms: i64) -> Vec<String> {
    let drop = drop.unwrap_or(&roster.drops[0].id).to_string();
    let have = |id: &str| owned.iter().find(|o| o.id == id);
    let set: Vec<&Daemon> = roster.daemons.iter().filter(|d| d.drop == drop).collect();
    let drop1 = roster.drops.iter().find(|x| x.id == drop);
    let state = drop_state(drop1, now_ms);
    if state == "hidden" { return Vec::new() }
    let last = roster.rules.versions.len() - 1;
    let cells: Vec<(String, String)> = set.iter().map(|d| {
        let number = if d.rarity == "secret" { "secret".to_string() } else { card_number(roster, d).chars().take(3).collect() };
        if state == "announced" {
            return (if d.rarity == "secret" { "[ ! ]".into() } else { silhouette(&sprite(roster, d, 0, "idle", Opts::still())) }, number);
        }
        match have(&d.id) {
            None => (if d.rarity == "secret" { "[ ! ]".into() } else { "[ ? ]".into() }, number),
            Some(mine) => (sprite(roster, d, last, "idle", Opts::still()), if mine.dupes > 0 { format!("{} x{}", d.id, mine.dupes + 1) } else { d.id.clone() }),
        }
    }).collect();
    let mut rows = Vec::new();
    for chunk in cells.chunks(5) {
        rows.push(chunk.iter().map(|c| format!("{:<10}", c.0)).collect::<String>().trim_end().to_string());
        rows.push(chunk.iter().map(|c| format!("{:<10}", c.1)).collect::<String>().trim_end().to_string());
        rows.push(String::new());
    }
    let count = set.iter().filter(|d| have(&d.id).is_some() && d.rarity != "secret").count();
    let of = set.iter().filter(|d| d.rarity != "secret").count();
    let secret = set.iter().any(|d| d.rarity == "secret" && have(&d.id).is_some());
    let head = format!("zoo: drop {} {}  {}", drop1.map(|d| d.n).unwrap_or(1), drop1.map(|d| d.name.clone()).unwrap_or(drop.clone()),
        if state == "announced" { format!("out {}", drop1.and_then(|d| d.release.clone()).unwrap_or_default()) } else { format!("{count}/{of}{}", if secret { "  +secret" } else { "" }) });
    let mut out = vec![head, String::new()];
    out.extend(rows);
    out.pop();
    out
}

fn esc(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;") }

/// Lines of text as an SVG terminal (card.mjs svgFor), monospace system fonts only.
pub fn svg_for(lines: &[String], colors: &std::collections::HashMap<usize, String>, title: &str) -> String {
    let (cw, lh, pad_x, pad_y) = (8.4f64, 17usize, 18usize, 22usize);
    let cols = lines.iter().map(String::len).max().unwrap_or(0);
    let w = (cols as f64 * cw + (pad_x * 2) as f64).ceil() as i64;
    let h = ((lines.len() * lh + pad_y * 2) as f64 - 4.0).ceil() as i64;
    let text = lines.iter().enumerate().map(|(i, l)| {
        let fill = colors.get(&i).map(String::as_str).unwrap_or("#d0d0d0");
        format!("<text x=\"{pad_x}\" y=\"{}\" fill=\"{fill}\" xml:space=\"preserve\">{}</text>", pad_y + i * lh + 12, esc(l))
    }).collect::<Vec<_>>().join("\n  ");
    format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\" role=\"img\" aria-label=\"{}\">\n  <rect x=\"0.5\" y=\"0.5\" width=\"{}\" height=\"{}\" rx=\"6\" fill=\"#121212\" stroke=\"#3a3a3a\"/>\n  <g font-family=\"ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace\" font-size=\"14\" font-variant-ligatures=\"none\">\n  {text}\n  </g>\n</svg>\n",
        esc(title), w - 1, h - 1)
}

pub fn card_svg(roster: &Roster, d: &Daemon, o: &CardOpts) -> String {
    let lines = card_lines(roster, d, o);
    let version = o.version.clone().unwrap_or_else(|| roster.rules.versions[0].clone());
    let rows = o.plate.as_ref().map(Vec::len).unwrap_or_else(|| card_art(roster, d, &version).len());
    let color = if o.shiny { d.shiny.as_ref().map(|s| s.hex.clone()).unwrap_or(d.color.hex.clone()) } else { d.color.hex.clone() };
    let mut colors = std::collections::HashMap::new();
    // A plate runs down its gradient, a row at a time: an individual's own colour family (a shiny
    // one's, the shiny gradient).
    let family = o.traits.as_ref().filter(|_| !o.shiny).and_then(|t| d.family(&t.colour)).map(|f| super::roster::Gradient {
        top: super::roster::Colour { xterm: 0, hex: f.top.clone() }, bottom: super::roster::Colour { xterm: 0, hex: f.bottom.clone() } });
    let gradient = family.as_ref().or(d.gradient(o.shiny)).filter(|_| d.plate);
    for i in 3..3 + rows { colors.insert(i, gradient.map(|g| plates::hex(plates::row_rgb(g, rows, i - 3))).unwrap_or(color.clone())); }
    colors.insert(1, match d.rarity.as_str() { "rare" => "#5fafaf", "legendary" => "#d7af5f", "secret" => "#af87af", _ => "#d0d0d0" }.to_string());
    svg_for(&lines, &colors, &format!("{}, a {} daemon", d.id, d.rarity))
}

#[cfg(test)]
mod tests {
    use super::super::render::tests::frames;
    use super::super::roster::roster;
    use super::*;

    #[test]
    fn every_card_in_frames_json() {
        let r = roster();
        let (mut n, mut seeded) = (0, 0);
        for c in frames()["cards"].as_array().unwrap() {
            let d = r.daemon(c["id"].as_str().unwrap()).unwrap();
            let o = CardOpts {
                version: c["version"].as_str().map(str::to_string),
                shiny: c["shiny"].as_bool().unwrap_or(false),
                serial: c["serial"].as_u64().map(|s| s.to_string()),
                name: c["name"].as_str().or(c["nickname"].as_str()).map(str::to_string),
                hatched: c["hatched"].as_str().map(str::to_string),
                egg: c["egg"].as_str().map(str::to_string),
                // An individual's card, on its species' plate until harnessd has drawn its own.
                traits: c["seed"].as_u64().and_then(|seed| super::super::render::roll_traits(r, &d.id, seed)),
                plate: None,
            };
            let want: Vec<String> = c["out"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            assert_eq!(card_lines(r, d, &o), want, "card {} {}", c["id"], c["version"]);
            if o.traits.is_some() { seeded += 1 }
            n += 1;
        }
        assert_eq!((n, seeded), (190, 10));
    }

    #[test]
    fn an_individuals_card_on_its_own_plate() {
        let r = roster();
        let tim = r.daemon("tim").unwrap();
        let traits = super::super::render::roll_traits(r, "tim", 826).unwrap();
        let plate = vec!["  .,;x,  ".to_string(), " x@@##%; ".to_string(), "  :%%:   ".to_string()];
        let o = CardOpts { version: Some("2.0".into()), serial: Some("42".into()), name: Some("pip".into()), traits: Some(traits), plate: Some(plate.clone()), ..Default::default() };
        let lines = card_lines(r, tim, &o);
        for (i, row) in plate.iter().enumerate() { assert!(lines[3 + i].contains(row.as_str()), "{:?}", lines[3 + i]) }
        assert_eq!(lines[3 + plate.len() + 1], "|   pip the tim 2.0  #0042               |");
        assert_eq!(lines[3 + plate.len() + 2], "|   tim -c lilac --freckles --big-head \\ |");
        assert!(lines.contains(&"|   1 in 34                              |".to_string()) && lines.iter().all(|l| l.len() == 42));
        // As SVG the plate runs down its colour family (lilac), a row at a time.
        let svg = card_svg(r, tim, &o);
        assert!(svg.contains("fill=\"#d7afff\"") && svg.contains("fill=\"#8787d7\""), "{svg}");
        assert_eq!(flag_lines("tim -c coral", 38), vec!["tim -c coral"]);
        assert_eq!(one_in_text(2130), "1 in 2,130");
    }

    #[test]
    fn a_filled_daemons_card_is_its_portrait_plate() {
        let r = roster();
        let tim = r.daemon("tim").unwrap();
        let o = CardOpts { version: Some("2.0".into()), serial: Some("42".into()), ..Default::default() };
        let lines = card_lines(r, tim, &o);
        assert_eq!(lines[1], "| #01/09  DROP 1: INIT            COMMON |");
        let plate = plates::rows("tim", PORTRAIT, "2.0", "idle", 0);
        for (i, row) in plate.iter().enumerate() { assert!(lines[3 + i].contains(row.as_str()), "{row:?} in {:?}", lines[3 + i]) }
        assert!(lines.iter().any(|l| l.contains("tim 2.0  #0042")) && lines.iter().all(|l| l.len() == 42));
        // As SVG, the plate runs down tim's gradient; shiny, down the gold one.
        let g = tim.gradient.as_ref().unwrap();
        let svg = card_svg(r, tim, &o);
        assert!(svg.contains(&format!("fill=\"{}\"", g.top.hex)) && svg.contains(&format!("fill=\"{}\"", g.bottom.hex)), "{svg}");
        let gold = card_svg(r, tim, &CardOpts { shiny: true, ..o });
        assert!(gold.contains(&format!("fill=\"{}\"", tim.shiny_gradient.as_ref().unwrap().top.hex)));
        assert_eq!(card_number(r, r.daemon("auk").unwrap()), "#09/09");
        assert_eq!(card_number(r, r.daemon("beastie").unwrap()), "#S/09");
    }

    #[test]
    fn a_shelf_as_card_mjs_draws_it() {
        // node daemons/tools/card.mjs --shelf 'tim*x2,yak,beastie'
        let r = roster();
        let owned = [Shelved { id: "tim".into(), dupes: 1 }, Shelved { id: "yak".into(), ..Default::default() }, Shelved { id: "beastie".into(), ..Default::default() }];
        let now = day_number("2026-09-27").unwrap() * 86_400_000;
        let got = shelf_lines(r, &owned, None, now);
        assert_eq!(got, [
            "zoo: drop 1 init  2/9  +secret", "",
            "~(o o)~   [ ? ]     [ ? ]     [ ? ]     ~\"o\"o\"~", "tim x2    #02       #03       #04       yak", "",
            "[ ? ]     [ ? ]     [ ? ]     [ ? ]     }oWo{ -E", "#06       #07       #08       #09       beastie",
        ]);
        // Before release the regulars are silhouettes and the date shows.
        let early = day_number("2026-09-20").unwrap() * 86_400_000;
        let before = shelf_lines(r, &owned, None, early);
        assert_eq!(before[0], "zoo: drop 1 init  out 2026-09-27");
        assert_eq!(before[2], "## ##     #####     #####     ######    #####");
        assert!(shelf_lines(r, &owned, None, day_number("2026-09-01").unwrap() * 86_400_000).is_empty());
    }

    #[test]
    fn a_drop_on_hold_shows_nowhere_ever() {
        let r = roster();
        let init = r.drops.iter().find(|x| x.id == "init");
        let at = |day: &str| day_number(day).unwrap() * 86_400_000 + 43_200_000;
        assert_eq!(["2026-09-12", "2026-09-13", "2026-09-26", "2026-09-27"].map(|d| drop_state(init, at(d))), ["hidden", "announced", "announced", "released"]);
        for id in ["unix", "tty"] {
            let drop = r.drops.iter().find(|x| x.id == id).unwrap();
            assert!(drop.hold && drop.announce.is_none() && drop.release.is_none());
            for day in ["2026-09-27", "2027-09-27", "2036-01-01"] { assert_eq!(drop_state(Some(drop), at(day)), "hidden", "{id} {day}") }
            // Even with dates, hold comes first.
            let dated = DropDef { announce: Some("2026-01-01".into()), release: Some("2026-01-15".into()), ..drop.clone() };
            assert_eq!(drop_state(Some(&dated), at("2030-01-01")), "hidden");
            let owned = [Shelved { id: "tmux".into(), ..Default::default() }, Shelved { id: "vim".into(), ..Default::default() }];
            assert!(shelf_lines(r, &owned, Some(id), at("2030-01-01")).is_empty());
        }
        // The old tim is tmux now, kept on hold; hn shows neither it nor any of its drop.
        assert!(r.held(r.daemon("tmux").unwrap()) && r.shown("tmux").is_none() && r.shown("grue").is_none());
        assert!(!r.held(r.daemon("tim").unwrap()) && r.shown("tim").is_some());
    }

    #[test]
    fn dates_and_wrapping() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2026-09-26"), Some(20722));
        assert_eq!(wrap("\"oh hi. i'm tim.\"", 10), vec!["\"oh hi.", "i'm tim.\""]);
    }
}
