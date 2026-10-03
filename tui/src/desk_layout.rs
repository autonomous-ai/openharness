//! The desktop/hn wire contract: ordered normalized pane rectangles in `sizes["N:manual"]`.
//! Presets are a legacy fallback and the user's label; explicit geometry always wins.
use serde_json::{json, Value};
use crate::layout::{Node, Status};

pub type Tile = [f64; 4];

/// Migration for the unused tail of a legacy desktop lattice row. Matches
/// PaneArrangement.fillRowEnds; no slot is added or reordered.
pub fn fill_row_ends(mut tiles: Vec<Tile>) -> Vec<Tile> {
    let before = tiles.clone();
    for tile in &mut tiles {
        if tile[2] < 1.0 - 0.000001 && !before.iter().any(|other|
            other[0] >= tile[2] - 0.000001 && other[1] < tile[3] - 0.000001 && other[3] > tile[1] + 0.000001) {
            tile[2] = 1.0;
        }
    }
    tiles
}

/// Keep the unrounded source between terminal resizes. `rendered` distinguishes a
/// viewport resize from a tmux command that has just edited the cell tree.
#[derive(Clone, Debug)]
pub struct Geometry {
    pub slots: Vec<(u64, Tile)>,
    rendered: String,
}

impl Geometry {
    pub fn capture(root: &Node) -> Self {
        Self { slots: root.normalized_tiles(), rendered: root.to_tmux() }
    }

    pub fn from_tiles(tiles: Vec<Tile>, ids: &[u64], w: u16, h: u16, status: Status) -> Option<(Node, Self)> {
        let tiles = fill_row_ends(tiles);
        let root = Node::from_tiles(&tiles, ids, w, h, status)?;
        let geometry = Self { slots: ids.iter().copied().zip(tiles).collect(), rendered: root.to_tmux() };
        Some((root, geometry))
    }

    pub fn matches(&self, root: &Node) -> bool { self.rendered == root.to_tmux() }

    pub fn fit(&mut self, root: &mut Node, w: u16, h: u16, status: Status) -> bool {
        if !self.matches(root) { return false }
        let (ids, tiles): (Vec<_>, Vec<_>) = self.slots.iter().copied().unzip();
        let Some(next) = Node::from_tiles(&tiles, &ids, w, h, status) else { return false };
        self.rendered = next.to_tmux();
        *root = next;
        true
    }

    pub fn write(&self, doc: &mut Value) {
        if !doc.is_object() { *doc = json!({}) }
        if !doc.get("sizes").is_some_and(Value::is_object) { doc["sizes"] = json!({}) }
        let count = self.slots.len();
        // One active arrangement per count; stale rendered-preset keys must not
        // compete with it or crowd it out of the server's 16-entry limit.
        let sizes = doc["sizes"].as_object_mut().unwrap();
        sizes.retain(|key, _| !key.starts_with(&format!("{count}:")));
        if count >= 2 {
            while sizes.len() >= 16 { let key = sizes.keys().next().unwrap().clone(); sizes.remove(&key); }
            sizes.insert(format!("{count}:manual"), json!(self.slots.iter().map(|(_, tile)| tile).collect::<Vec<_>>()));
        }
    }
}

pub fn saved_tiles(doc: &Value, count: usize) -> Option<Vec<Tile>> {
    let sizes = doc.get("sizes")?.as_object()?;
    let key = format!("{count}:manual");
    let value = sizes.get(&key).or_else(|| {
        // Desktop builds before the common contract stored a dragged preset under its render key.
        let preset = preset_id(doc, count);
        let prefix = format!("{count}:{preset}:");
        sizes.iter().find(|(key, _)| key.starts_with(&prefix)).map(|(_, value)| value)
    })?;
    let rows = value.as_array().filter(|rows| rows.len() == count)?;
    rows.iter().map(|row| {
        let row = row.as_array().filter(|row| row.len() == 4)?;
        let mut tile = [0.0; 4];
        for (i, value) in row.iter().enumerate() { tile[i] = value.as_f64()?; }
        Some(tile)
    }).collect()
}

pub fn preset_id(doc: &Value, count: usize) -> &str {
    doc.get("presets").and_then(|p| p.get(count.to_string())).and_then(Value::as_str)
        .unwrap_or_else(|| default_preset(count))
}

pub fn default_preset(count: usize) -> &'static str {
    match count { 2 => "splitLong", 3 => "cols3", 4 => "quad", 5 => "middleMain", _ => "auto" }
}

fn lattice(count: usize, columns: usize, balanced: bool, extra_last: bool) -> Vec<Tile> {
    let columns = columns.clamp(1, count);
    let rows = count.div_ceil(columns);
    (0..rows).flat_map(|row| {
        let n = if balanced { count / rows + usize::from(if extra_last { row >= rows - count % rows } else { row < count % rows }) }
            else { columns.min(count - row * columns) };
        let width = if balanced { n } else { columns } as f64;
        (0..n).map(move |col| [col as f64 / width, row as f64 / rows as f64,
            (col + 1) as f64 / width, (row + 1) as f64 / rows as f64])
    }).collect()
}

/// Matches PanePreset.tilesFor. The shared fixtures exercise every offered shape at each count.
pub fn preset_tiles(id: &str, count: usize) -> Option<Vec<Tile>> {
    if !(1..=64).contains(&count) { return None }
    if count == 1 { return Some(vec![[0.0, 0.0, 1.0, 1.0]]) }
    Some(match id {
        // `columns` was used for 3+ panes by older hn builds.
        "columns" | "splitLong" => lattice(count, count, false, false),
        "rows" => lattice(count, 1, false, false),
        "cols2" => lattice(count, 2, false, false),
        "cols3" | "threeColumns" => lattice(count, 3, false, false),
        "cols4" | "fourColumns" => lattice(count, 4, false, false),
        "cols5" => lattice(count, 5, false, false),
        "balanced2" => lattice(count, 2, true, false),
        "balanced3" => lattice(count, 3, true, false),
        "balanced4" => lattice(count, 4, true, false),
        "balanced5" => lattice(count, 5, true, false),
        "auto" => lattice(count, if count <= 6 { 3 } else { 4 }, false, false),
        "twoOverOne" if count == 3 => vec![[0.0,0.0,0.5,0.5], [0.5,0.0,1.0,0.5], [0.0,0.5,1.0,1.0]],
        "oneOverTwo" if count == 3 => vec![[0.0,0.0,1.0,0.5], [0.0,0.5,0.5,1.0], [0.5,0.5,1.0,1.0]],
        "mainLeft" if count == 3 => vec![[0.0,0.0,0.5,1.0], [0.5,0.0,1.0,0.5], [0.5,0.5,1.0,1.0]],
        "mainRight" if count == 3 => vec![[0.0,0.0,0.5,0.5], [0.5,0.0,1.0,1.0], [0.0,0.5,0.5,1.0]],
        "quad" if count == 4 => lattice(count, 2, false, false),
        "mainAndStack" if count == 4 => vec![[0.0,0.0,0.5,1.0], [0.5,0.0,1.0,1.0/3.0], [0.5,1.0/3.0,1.0,2.0/3.0], [0.5,2.0/3.0,1.0,1.0]],
        "middleMain" if count == 5 => vec![[0.0,0.0,1.0/3.0,0.5], [1.0/3.0,0.0,2.0/3.0,1.0], [2.0/3.0,0.0,1.0,0.5], [0.0,0.5,1.0/3.0,1.0], [2.0/3.0,0.5,1.0,1.0]],
        "twoOverThree" if count == 5 => lattice(count, 3, true, true),
        "mainAndGrid" if count >= 5 => {
            let mut tiles = vec![[0.0,0.0,0.5,1.0]];
            tiles.extend(lattice(count - 1, 2, true, false).into_iter().map(|t| [0.5+t[0]/2.0,t[1],0.5+t[2]/2.0,t[3]]));
            tiles
        }
        "mainOverGrid" if count >= 4 => {
            let mut tiles = vec![[0.0,0.0,1.0,0.5]];
            tiles.extend(lattice(count - 1, if count == 4 { 3 } else { (count - 1).div_ceil(2).clamp(2, 5) }, true, false)
                .into_iter().map(|t| [t[0],0.5+t[1]/2.0,t[2],0.5+t[3]/2.0]));
            tiles
        }
        _ => return None,
    })
}

pub fn label(id: &str) -> &str {
    match id {
        "columns" => "Columns", "rows" => "Rows", "cols3" => "3 columns", "cols4" => "4 columns", "cols5" => "5 columns",
        "twoOverOne" => "Main bottom", "oneOverTwo" | "mainOverGrid" => "Main top",
        "mainLeft" | "mainAndStack" | "mainAndGrid" => "Main left", "mainRight" => "Main right",
        "quad" => "Grid", "middleMain" => "Middle + sides", "twoOverThree" => "Two over three",
        "balanced2" => "2 columns", "balanced3" => "3 columns", "balanced4" => "4 columns", "balanced5" => "5 columns", _ => id,
    }
}

pub fn choices(count: usize) -> Vec<&'static str> {
    let candidates: &[&str] = match count {
        0 | 1 => &[], 2 => &["columns", "rows"],
        3 => &["cols3", "twoOverOne", "oneOverTwo", "mainLeft", "mainRight", "rows"],
        4 => &["quad", "mainAndStack", "mainOverGrid", "cols4", "rows"],
        5 => &["middleMain", "balanced3", "twoOverThree", "mainAndGrid", "mainOverGrid", "cols5"],
        6..=9 => &["balanced2", "balanced3", "balanced4", "balanced5", "mainAndGrid", "mainOverGrid"],
        _ => &["balanced2", "balanced3", "balanced4", "balanced5"],
    };
    let mut shapes = Vec::new();
    candidates.iter().copied().filter(|id| {
        let Some(tiles) = preset_tiles(id, count) else { return false };
        if shapes.contains(&tiles) { false } else { shapes.push(tiles); true }
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> Vec<Value> {
        serde_json::from_str(include_str!("../../tests/fixtures/shared-pane-layouts.json")).unwrap()
    }

    #[test]
    fn desktop_catalogue_and_every_slot_render_identically_in_cells() {
        let fixtures = fixtures();
        for count in 2..=9 {
            let offered: Vec<_> = fixtures.iter().filter(|f| f["count"] == count && f["offered"] == true)
                .map(|f| f["preset"].as_str().unwrap()).collect();
            assert_eq!(choices(count as usize), offered);
        }
        for case in fixtures {
            let count = case["count"].as_u64().unwrap() as usize;
            let id = case["preset"].as_str().unwrap();
            if case["offered"] == true { assert_eq!(label(id), case["label"]); }
            let expected: Vec<Tile> = serde_json::from_value(case["tiles"].clone()).unwrap();
            assert_eq!(fill_row_ends(preset_tiles(id, count).unwrap()), expected, "{count} {id}");
            // Pane IDs deliberately differ from both spatial and tree traversal order.
            let ids: Vec<_> = (0..count).map(|i| (100 - i * 3) as u64).collect();
            for (w, h) in [(80, 24), (161, 51), (320, 90)] {
                let (root, _) = Geometry::from_tiles(expected.clone(), &ids, w, h, Status::Top)
                    .unwrap_or_else(|| panic!("{count} {id}"));
                let actual = root.normalized_tiles();
                for (pane, tile) in ids.iter().zip(&expected) {
                    let got = actual.iter().find(|t| t.0 == *pane).unwrap().1;
                    for axis in 0..4 {
                        let tolerance = 1.0 / if axis % 2 == 0 { w as f64 } else { h as f64 };
                        assert!((tile[axis] - got[axis]).abs() <= tolerance, "{count} {id} pane {pane}, axis {axis}: {tile:?} != {got:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn repeated_resizing_does_not_accumulate_rounding_or_overwrite_source() {
        let tiles = vec![[0.0, 0.0, 0.23, 1.0], [0.23, 0.0, 1.0, 0.71], [0.23, 0.71, 1.0, 1.0]];
        let (mut root, mut geometry) = Geometry::from_tiles(tiles.clone(), &[9, 6, 3], 137, 43, Status::Top).unwrap();
        let original = root.to_tmux();
        for (w, h) in [(80, 20), (1, 1), (300, 100), (37, 9), (137, 43)] {
            assert!(geometry.fit(&mut root, w, h, Status::Top));
        }
        assert_eq!(root.to_tmux(), original);
        let mut doc = json!({});
        geometry.write(&mut doc);
        assert_eq!(saved_tiles(&doc, 3), Some(tiles));
    }

    #[test]
    fn fitting_never_overwrites_a_native_edit_waiting_for_publication() {
        let (mut root, mut geometry) = Geometry::from_tiles(preset_tiles("mainRight", 3).unwrap(), &[1, 2, 3], 120, 40, Status::Top).unwrap();
        root.swap(1, 2);
        let edited = root.to_tmux();
        assert!(!geometry.fit(&mut root, 180, 60, Status::Top));
        assert_eq!(root.to_tmux(), edited);
    }
}
