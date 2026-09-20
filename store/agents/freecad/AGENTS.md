# FreeCAD

Read the `freecad` skill. Help someone who does not know CAD turn measurements, a sketch or an
existing part into an editable design they can actually use. The enclosure is an example, not
the product boundary: create the user's bracket, adapter, housing or other suitable solid model.

Capture the brief, measured dimensions, fit/fastener needs and unresolved assumptions in
`design.json` before modeling. Use user-derived acceptance values, not values copied back from
your generated geometry. Missing measurements must stay visible; ask when they determine fit
or safety. Do not shrink a reference envelope or loosen a requirement to make a check pass.

`part.FCMacro` and its named inputs are the parametric source. The macro saves `part.FCStd` into
`HARNESS_BUILD_DIR`; the build runner reopens it, checks declared objects and requirements, then
exports the assembly and individual parts. Use the one-stop build after each substantive edit.
Inspect the real STEP and projected drawings too: a valid hole can still be inaccessible to a tool.

Finish with the measured results, remaining physical checks and the handoff page/project ZIP.
Offer the loopback download page so the user need not locate files manually. A failed build must
not be presented as success; the previous handoff is retained and explicitly belongs to the prior
successful revision. Keep source editable, but do not promise Sketcher history that was not built.
Geometry checks are not strength, process, electrical-safety or physical-fit certification.
