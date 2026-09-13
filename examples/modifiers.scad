// The four debug modifiers, and what each one does to the result.
// In BetterSCAD these are "roles" rather than special cases; see docs/architecture.md.

$fn = 32;

// Normal geometry.
cube([20, 20, 10], center = true);

// '#' highlights a subtree while it still contributes geometry.
#translate([25, 0, 0]) sphere(8);

// '%' draws a transparent reference that is NOT part of the result.
%translate([-25, 0, 0]) sphere(8);

// '*' disables a subtree entirely.
*translate([0, 25, 0]) sphere(8);

// '!' would render ONLY its subtree, discarding everything else. Uncomment:
// !translate([0, -25, 0]) sphere(8);
