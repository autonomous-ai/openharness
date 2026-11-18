// The size a pet's canvas takes in the mockup: its art scaled to fit a box, keeping its shape.
import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// The art's own size per engine and scene (assets/pets/pets.json `w` and `h`, the mockup's PET_ART).
const Map<String, Size> _art = {
  'claude/rest': Size(145, 99),
  'claude/work': Size(199, 146),
  'claude/listen': Size(161, 129),
  'claude/relax': Size(120, 164),
  'codex/idle': Size(145, 170),
  'codex/review': Size(151, 192),
  'codex/waiting': Size(148, 170),
  'codex/work': Size(166, 170),
  'codex/listen': Size(151, 170),
  'muse/rest': Size(143, 133),
  'muse/work': Size(123, 166),
  'muse/listen': Size(127, 160),
  'muse/relax': Size(121, 233),
};

/// The fitted size of [engine]'s [scene] in [box], as the mockup's petInit sizes its canvas. PetView fills the box it
/// is given and stands the art on the box's foot; a page that centres the pet (Attention) or spaces pets by their
/// width (Ambient) gives it this size so the art lands where the mockup's canvas does. An unknown scene keeps the box.
Size petFit(String engine, String scene, Size box) {
  final art = _art['$engine/$scene'];
  if (art == null) return box;
  final z = math.min(box.width / art.width, box.height / art.height);
  return Size(art.width * z, art.height * z);
}
