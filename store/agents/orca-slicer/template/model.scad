// Original Bottle Bench rack, millimetres. Dry indoor craft storage only.
// Regenerate model.stl with OpenSCAD after edits; the slicer does not compile this.
// This geometry matches the Everyday rack in the OpenSCAD harness acceptance case.
bottle_diameter=26;
radial_clearance=0.3;
wall=2;
floor=2.4;
height=18;
columns=3;
rows=2;
bore=bottle_diameter+2*radial_clearance;
$fn=128;
difference() {
    cube([columns*bore+(columns+1)*wall,rows*bore+(rows+1)*wall,height]);
    for(x=[0:columns-1],y=[0:rows-1])
        translate([wall+bore/2+x*(bore+wall),wall+bore/2+y*(bore+wall),floor])
            cylinder(d=bore,h=height+1);
}
