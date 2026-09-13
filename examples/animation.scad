// Animation using $t (spec feature 20).
// In the app: Command palette -> "Toggle animation bar", then press Play.
// From the CLI:  bscad animation.scad --frames 60 -o frames/

$fn = 48;

arms = 6;
radius = 30;

for (i = [0 : arms - 1]) {
  angle = i * 360 / arms + $t * 360;
  // Each arm bobs vertically, offset in phase around the ring.
  z = sin(($t * 360) + i * 360 / arms) * 8;
  rotate([0, 0, angle])
    translate([radius, 0, z])
      color([0.9, 0.55 + 0.4 * i / arms, 0.2])
        sphere(r = 6);
}

// Hub.
cylinder(h = 4, r = 10, center = true);
