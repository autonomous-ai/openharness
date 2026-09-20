// Drawer Grid — an editable family of dry-use organizers. Millimetres.
// The checked builder calls this module with the saved design.json values.
// Top-level geometry is a desktop preview only; it is ignored during export.
module part(id, width=180, depth=96, height=40, wall=2.4, floor=2.4, columns=3) {
    assert(id == "tray", "Unknown part");
    assert(columns >= 2 && floor > 0 && height > floor && wall > 0);
    pocket_width = (width - (columns + 1) * wall) / columns;
    assert(pocket_width > 10 && depth > 2 * wall + 10, "Compartments are too small");
    difference() {
        cube([width, depth, height]);
        for (column = [0:columns-1])
            translate([wall + column * (pocket_width + wall), wall, floor])
                cube([pocket_width, depth - 2 * wall, height + 1]);
    }
}
part("tray");
