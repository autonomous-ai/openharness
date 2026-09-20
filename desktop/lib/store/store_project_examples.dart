// Exact prompts for the bundled artwork in assets/store/projects/.
// Sources and upstream attribution are recorded in assets/store/README.md.
// These appear only on browsing pages; package detail pages use their own examples.
const storeProjectExamples = <String, ({String title, String prompt})>{
  'autonomous/blender': (
    title: "A little world, down to the last detail.",
    prompt: "Make a cozy isometric reading nook: a cut-away corner of a room with an armchair, a floor lamp glowing warm, a bookshelf full of colourful books, a round rug and a monstera, with evening sun through the window and a cat asleep on the rug.",
  ),
  'autonomous/text-to-cad': (
    title: "Design parts that fit together.",
    prompt: "Design a 3D-printable planetary gear set: a 12-tooth sun, three 18-tooth planets and a 48-tooth ring gear with mounting lugs, module 1.5 and 8 mm thick, plus a carrier on steel pins. Give each part its own colour.",
  ),
  'autonomous/autonomous-circuit': (
    title: "A macropad of your own.",
    prompt: "Design a six-key USB macropad. Start with the schematic.",
  ),
  'autonomous/mujoco': (
    title: "Teach a robot to say hello.",
    prompt: "Make the Unitree G1 humanoid say hello: stand, raise its right hand and wave three times, then lower it and take a small bow. Record it.",
  ),
  'autonomous/godogen': (
    title: "Make a world you can play.",
    prompt: "Make a synthwave hoverbike racer: ride down a neon grid canyon toward a striped setting sun, weave between glowing pylons, hop barriers and collect energy cores, with a boost and three shields.",
  ),
  'autonomous/score': (
    title: "Compose without an instrument.",
    prompt: "I don't play an instrument. Make a gentle, hopeful piece with a flute melody, clarinet reply and warm cello. Let me hear each voice and save an audio sketch.",
  ),
  'autonomous/marimo': (
    title: "Find the order inside chaos.",
    prompt: "Build a notebook that explores the Lorenz attractor: sliders for σ, ρ and β, the butterfly drawn in two projections coloured by time, and two runs started a hair apart to show how fast they diverge.",
  ),
  'autonomous/remotion': (
    title: "Make your launch move.",
    prompt: "Make a 12 second launch video for the Harness Store with three beats: the store opens, a card flips to Get, and a spinning 3D cube lands in a pane. Bold type, smooth motion. Render it to MP4.",
  ),
  'autonomous/roundtable': (
    title: "Explore both sides of a decision.",
    prompt: "Should our Windows port be native, or should we ship the daemon inside WSL2? One engineer on it. Evidence: the cli/ folder.",
  ),
  'autonomous/marp': (
    title: "Take an audience to the deep sea.",
    prompt: "Make a ten-minute keynote for a science festival about the deep ocean: how deep it goes, how little of the seafloor we have mapped, and the global push to finish the map by 2030.",
  ),
  'autonomous/circuitjs': (
    title: "Make a light blink. Understand why.",
    prompt: "Build a 555 astable LED flasher with a potentiometer that sets the rate, and scopes on the capacitor and the output.",
  ),
  'autonomous/yosys': (
    title: "Build a tiny CPU.",
    prompt: "Build a tiny 8-bit CPU for the iCEBreaker that runs a Fibonacci program from ROM and prints every number over the USB serial port at 115200 baud; the button runs it again. Simulate it, check the serial output in the testbench and build the bitstream.",
  ),
  'autonomous/orca-slicer': (
    title: "From a model to a print plan.",
    prompt: "Prepare this 24 mm spacer with my exported profiles, then revise the Everyday plan to four walls at 0.16 mm. Reopen the native export and show the time/material change.",
  ),
};
