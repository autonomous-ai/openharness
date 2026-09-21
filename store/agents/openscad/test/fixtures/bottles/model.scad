// Bottle Bench. Original millimetre design; dry craft use only.
module part(id, bottle_diameter=26, clearance=0.3, wall=2, floor=2.4,
            height=18, columns=3, rows=2, gauge_height=4) {
    bore = bottle_diameter + 2 * clearance;
    width = columns * bore + (columns+1) * wall;
    depth = rows * bore + (rows+1) * wall;
    assert(bore > 0 && wall > 0 && floor > 0 && height > floor);
    $fn = 128;
    if (id == "rack")
        difference() {
            cube([width,depth,height]);
            for (x=[0:columns-1], y=[0:rows-1])
                translate([wall+bore/2+x*(bore+wall),
                           wall+bore/2+y*(bore+wall), floor])
                    cylinder(d=bore,h=height+1);
        }
    else if (id == "gauge")
        difference() {
            cylinder(d=bore+2*wall,h=gauge_height);
            translate([0,0,-0.1]) cylinder(d=bore,h=gauge_height+0.2);
        }
    else assert(false,"Unknown part");
}
part("rack");
translate([115,20,0]) part("gauge");
