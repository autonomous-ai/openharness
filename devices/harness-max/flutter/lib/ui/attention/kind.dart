// What Attention, its edge light and Inbox say and paint for why an agent needs the person (the mockup's KIND).
import 'package:flutter/widgets.dart';

import '../../model/types.dart';
import '../tokens.dart';

/// The kind's ink for words: the name on Attention and on an Inbox card, the card's ring and dot. The mockup's
/// `[data-s=failed]` is the soft red (#FF6B6B), not the rail's.
Color kindInk(AttnKind kind) => switch (kind) {
      AttnKind.ask => Ink.ask,
      AttnKind.done => Ink.done,
      AttnKind.failed => Ink.failText,
    };

/// The edge light's colour: the rails' own, so a failure lights the glass in the failed rail's red.
Color edgeInk(AttnKind kind) => switch (kind) {
      AttnKind.ask => Ink.ask,
      AttnKind.done => Ink.done,
      AttnKind.failed => Ink.fail,
    };

/// The word after the name: "landing-hero asks", "flaky-e2e is done".
String kindWord(AttnKind kind) => switch (kind) {
      AttnKind.ask => 'asks',
      AttnKind.done => 'is done',
      AttnKind.failed => 'failed',
    };

/// The small pet a notice or Attention plays, as the mockup's smallScene: Codex waits on a question and reviews a
/// finished turn; every other pet rests.
String smallPetScene(String engine, AttnKind kind) {
  if (petEngineOf(engine) != 'codex') return 'rest';
  return switch (kind) { AttnKind.ask => 'waiting', AttnKind.done => 'review', AttnKind.failed => 'idle' };
}
