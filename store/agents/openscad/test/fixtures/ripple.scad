// Ripple — a parametric, open-top desktop vessel. Units: mm.
// Set height, diameter, twist and ribs, then run render-part.sh.
// This is a dry-use object, not a food-safe or watertight container.
height = 76;
diameter = 82;
wall = 2.4;
floor_thickness = 2.8;
ribs = 36;
rib_depth = 2.6;
twist = 28;
resolution = 180;

assert(height > floor_thickness && floor_thickness > 0, "height must exceed a positive floor");
assert(diameter > 2 * (wall + rib_depth) && wall >= 1.2, "keep a useful inner diameter and wall >= 1.2 mm");
assert(ribs >= 3 && ribs <= 100 && rib_depth >= 0, "use 3–100 ribs and nonnegative rib depth");
$fn = resolution;

// Continuous polar outline avoids coincident seams between separate ribs.
module outline() {
    polygon([for (i = [0:resolution-1])
        let(angle = i * 360 / resolution,
            radius = diameter / 2 + rib_depth * (0.5 + 0.5*cos(ribs*angle)))
        [radius*cos(angle), radius*sin(angle)]]);
}
difference() {
    linear_extrude(height=height, twist=twist, slices=ceil(height/2), convexity=10)
        outline();
    translate([0,0,floor_thickness])
        cylinder(h=height+0.1, r=diameter/2-wall);
}
