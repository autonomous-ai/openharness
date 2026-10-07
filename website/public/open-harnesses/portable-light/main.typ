#set document(title: "Field notes - Portable light", author: "OpenHarness example")
#set page(paper: "a4", margin: (x: 23mm, y: 23mm), numbering: "1")
#set text(font: "Helvetica Neue", size: 10.5pt, fill: rgb("242931"))
#set par(leading: 0.65em)
#set heading(numbering: none)
#show heading.where(level: 1): set text(size: 24pt, weight: "bold")
#let blue = rgb("315eaa")
#let latest = sys.inputs.at("revision", default: "first") == "latest"

#if latest [
  #text(9pt, fill: blue, tracking: 1.3pt)[DESIGN REVIEW / REVISION 02]
  #v(14mm)
  = What changed
  #v(5mm)
  The portable light now has a matte finish. This new opening page records the change before the original design brief.
  #v(7mm)
  #block(fill: rgb("edf2f9"), inset: 5mm, radius: 2mm)[
    *A review is a conversation with a specific draft.*

    The notes on the previous PDF still refer to that exact version. Compare the wording and drawings before deciding what to keep.
  ]
  #v(1fr)
  #text(9pt, fill: gray)[Fictional design study. Figures are authored examples, not measurements of a manufactured product.]
  #pagebreak()
]

#text(9pt, fill: blue, tracking: 1.3pt)[FIELD NOTES / PRODUCT BRIEF]
#v(10mm)
= Light that travels with the work
#v(4mm)
A small reading light for people who work between a desk, a studio and a train. The object should feel useful before it feels technical.

#v(6mm)
#block(width: 100%, height: 62mm, fill: rgb("edf2f9"), radius: 3mm, inset: 8mm)[
  #align(center)[
    #rect(width: 77mm, height: 7mm, fill: blue, radius: 3mm)
    #v(-1mm)
    #rect(width: 7mm, height: 32mm, fill: rgb("8198ba"), radius: 2mm)
    #v(-1mm)
    #rect(width: 43mm, height: 5mm, fill: rgb("435876"), radius: 2mm)
  ]
]
#text(8.5pt, fill: gray)[01 / Proportion study. This diagram is not a fabrication drawing.]
#v(7mm)
== What matters
A full workday should fit in one charge.

#if latest [Every surface uses a matte finish.] else [Every surface uses a glossy finish.]

The hinge should move with one hand and hold its position when the table shakes. Keep the controls quiet: one switch and a dimming gesture.
#v(1fr)
#text(9pt, fill: gray)[Fictional design study / September 2026 / Editable Typst source]

#pagebreak()
#text(9pt, fill: blue, tracking: 1.3pt)[FIELD NOTES / TRADEOFFS]
#v(8mm)
= Make the constraints visible
These provisional numbers are inputs for discussion. They are not performance claims.
#v(5mm)
#table(
  columns: (1.6fr, 1fr, 1.5fr),
  inset: 3mm, stroke: (bottom: 0.5pt + rgb("d9e0ea")),
  table.header([*Constraint*], [*Working target*], [*Next check*]),
  [Mass], [320 g], [Weigh the first assembly],
  [Working time], [8 hours], [Measure at reading brightness],
  [Packed height], [28 mm], [Check hinge clearance],
  [Repair], [Four screws], [Time a battery replacement],
)
#v(9mm)
== One question for the next prototype
Does the wide base make the light feel calmer, or does it make it less likely to travel?

Build both base widths with the same head and hinge. Put them in a bag, use them at a narrow table, and record what changes in the experience.
#v(7mm)
#block(stroke: 0.8pt + blue, inset: 5mm, radius: 2mm)[
  *Keep the test simple.* Compare one geometric change at a time. Carry the source, dimensions and observations into the next revision.
]

#pagebreak()
#text(9pt, fill: blue, tracking: 1.3pt)[FIELD NOTES / REVIEW]
#v(8mm)
= Decisions worth keeping
Use a note to say what should change, what should stay, or what still needs an answer.
#v(6mm)
== Change
Replace a vague promise with a condition that can be checked on a real prototype.

== Keep
Preserve the compact folded outline while exploring the base width.

== Question
Who should be able to repair the light, and which tools will they have?
#v(1fr)
#text(9pt, fill: gray)[This document is an authored example for testing review, quotation anchors and revision comparison. It does not describe a product for sale.]
