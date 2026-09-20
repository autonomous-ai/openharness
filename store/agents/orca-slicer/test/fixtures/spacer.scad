// Original dimensional trial for a 24 mm OD, 8.4 mm bore, 6 mm spacer.
// No load rating, material or physical fit claim. Millimetres.
$fn=96;
difference() {
    cylinder(d=24,h=6);
    translate([0,0,-0.1]) cylinder(d=8.4,h=6.2);
}
