// A parametric project box with a lid — the kind of thing OpenSCAD is used for.
// Renders in stock OpenSCAD unchanged.

/* [Box] */
// Internal width
width = 60;      // [20:120]
// Internal depth
depth = 40;      // [20:120]
// Internal height
height = 25;     // [10:80]
// Wall thickness
wall = 2;        // [1:0.5:5]
// Corner radius
corner = 4;      // [0:0.5:12]

/* [Lid] */
show_lid = true;
// Clearance between lid and box
clearance = 0.2; // [0:0.05:1]

/* [Quality] */
$fn = 48;

module rounded_slab(size, r) {
  // linear_extrude of an offset square is cheaper than hulling spheres and
  // keeps the vertical walls perfectly straight.
  linear_extrude(height = size[2])
    offset(r = r)
      square([size[0] - 2 * r, size[1] - 2 * r], center = true);
}

module box() {
  difference() {
    rounded_slab([width + 2 * wall, depth + 2 * wall, height + wall], corner + wall);
    translate([0, 0, wall]) rounded_slab([width, depth, height + 1], corner);
  }
}

module lid() {
  union() {
    rounded_slab([width + 2 * wall, depth + 2 * wall, wall], corner + wall);
    // Lip that drops into the box.
    translate([0, 0, -wall])
      rounded_slab([width - clearance * 2, depth - clearance * 2, wall], corner);
  }
}

box();

if (show_lid) {
  translate([0, depth + 4 * wall + 10, wall]) lid();
}

echo("outer size", width + 2 * wall, depth + 2 * wall, height + wall);
