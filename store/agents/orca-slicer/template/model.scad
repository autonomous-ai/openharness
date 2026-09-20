// Original small fluted vessel, for slicer exploration. Millimetres, dry use only.
height=48; diameter=55; wall=2; base=2.4; ribs=18; twist=22; resolution=72;
difference(){
  linear_extrude(height=height,twist=twist,slices=24,convexity=10)
    polygon([for(i=[0:resolution-1])let(a=i*360/resolution,r=diameter/2+1.5*(1+cos(ribs*a))/2)[r*cos(a),r*sin(a)]]);
  translate([0,0,base])cylinder(h=height+0.1,r=diameter/2-wall,$fn=resolution);
}
