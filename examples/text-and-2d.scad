// 2D geometry, text() and extrusion. Export as SVG or DXF for laser cutting,
// or wrap in linear_extrude for a 3D part.

/* [Tag] */
label = "BetterSCAD";  // [20]
tag_height = 18;       // [10:40]
padding = 6;           // [2:0.5:15]
// Extrude to 3D, or leave flat for SVG/DXF export
extrude = true;

$fn = 64;

module tag_outline(w, h, r) {
  offset(r = r) square([w - 2 * r, h - 2 * r], center = true);
}

module tag_2d() {
  difference() {
    tag_outline(len(label) * tag_height * 0.62 + padding * 2, tag_height + padding * 2, 3);
    text(label, size = tag_height * 0.62, halign = "center", valign = "center");
    // Hanging hole.
    translate([-(len(label) * tag_height * 0.62 + padding * 2) / 2 + padding, 0])
      circle(r = 2);
  }
}

if (extrude) linear_extrude(height = 2) tag_2d();
else tag_2d();
