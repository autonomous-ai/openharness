/// What the app says about models on computers that rest to save resources.
///
/// The daemon reads the account's grids without waking them (grid-reads-without-waking, issue 02)
/// and, since issue 03, labels what it read: a section asleep with its last known list, one it
/// could not reach, a wake a person asked for, a row whose computers seem offline, an agent whose
/// model is not answering. The wire contract's table ("How a client reads a section") is the
/// authority for every sentence here.
///
/// Written ONCE, here, for every surface — the pane picker, the Models panel and the pane itself —
/// so one state cannot be worded two ways, and so one test can hold all of them to the rule that no
/// sentence a person reads says "grid". Nothing here decides anything; a surface that gets no new
/// field from its daemon gets nothing from this file, and draws exactly what it drew before.
library;

import '../core/models.dart';

/// Under an asleep section's heading, on hover.
const kRestingTooltip =
    'Resting to save resources. It starts by itself when you send a message.';

/// The row a section with no record offers instead of a list, and the wait it promises.
const kShowModels = 'Show models';
const kShowModelsWait = 'usually 15–40 s';

/// While a wake a person asked for is running.
const kStartingUpWait = 'Starting up… usually 15–40 s';

/// Asleep, with a record that lists nothing.
const kNobodyWasServing = 'Nobody was serving here when it went to sleep';

/// A read that failed some other way, above whatever was last known.
const kNotAnswering = 'Not answering right now';

/// A wake that started the section and found nobody serving.
const kNobodyServing = 'Nobody is serving a model here right now';

/// The pane chip, from a message sent to a resting model until its first output.
const kStartingUp = 'Starting up…';
const kStillStarting = 'Still starting — this can take up to a minute';

/// The pane note's action, which opens that pane's model picker.
const kPickAnother = 'Pick another';

/// The confirmation before moving an agent onto a row whose computers seem offline.
const kSwitchAnyway = 'Switch anyway?';
const kSwitchAnywayAction = 'Switch';

/// The Model Manager's row for a model parked while this computer's models rest.
const kRestingUntilNextMessage = 'Running · resting until your next message';

/// How old the list shown is, in the contract's units: "just now" under a minute, then whole
/// minutes, hours and days — rounded down, so a list is never called younger than it is.
String listAge(int seconds) {
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return '${seconds ~/ 60} min ago';
  if (seconds < 86400) return '${seconds ~/ 3600} h ago';
  return '${seconds ~/ 86400} d ago';
}

/// The asleep section's subtitle. The age is left off when the daemon did not send one — a list
/// with no known age is still a resting section, and "from ? ago" would be a guess.
String restingSubtitle(int? lastKnownAge) => [
  'Asleep',
  'starts when you send a message (about 10–30 s)',
  if (lastKnownAge != null) 'list from ${listAge(lastKnownAge)}',
].join(' · ');

/// A wake that could not start [section]. The account's own section is "your models" — its name is
/// an internal id nobody chose — and a shared one goes by the name it is listed under.
String couldNotStart(GridSection section) =>
    "Couldn't start ${section.own ? 'your models' : section.name} right now — "
    'it will start on your next message';

/// Under a row every serving computer of which seems offline. The row stays: labelled, never
/// removed, and still pickable behind [kSwitchAnyway].
String offlineRowSentence(String machine) =>
    '$machine seems offline — its models come back when it does';

/// [offlineRowSentence] for [model], or null for a row that is fine.
String? offlineRowNote(GridModel model) => switch (model.unavailable) {
  final offline? => offlineRowSentence(offline.machine),
  null => null,
};

/// A row's node as a client that does not draw row state reads it — the daemon's own words for
/// such a client (`<computer> · seems offline`, with the computer as the Machines list names it).
/// New Harness lists rows as text, so it asks for row state like every surface and puts this back.
String offlineNodeLabel(String machine) => '$machine · seems offline';

/// The pane note for an agent whose model's computers all seem offline.
String offlineNoteSentence(String machine, String model) =>
    "$machine seems offline — $model won't answer until it's back";

/// The pane note for an agent whose model the latest list no longer has, up to its action — the
/// pane draws [kPickAnother] after it as the button that opens its picker.
String notServedNoteSentence(String model) =>
    "$model isn't being served right now";

/// What one section says about itself beside its list.
///
/// [subtitle] and [tooltip] go under the heading; [sentence] above the rows (or alone, when there
/// are none); [offerWake] is the "Show models" row. All empty for a daemon that sent no state,
/// which is what keeps an older daemon's menu byte for byte what it was.
class SectionWords {
  final String? subtitle;
  final String? tooltip;
  final String? sentence;
  final bool offerWake;

  const SectionWords({
    this.subtitle,
    this.tooltip,
    this.sentence,
    this.offerWake = false,
  });

  static const none = SectionWords();

  /// Whether a section with no models still has something to show: a shared section is drawn only
  /// while it serves something OR has this to say.
  bool get speaks => subtitle != null || sentence != null || offerWake;

  @override
  bool operator ==(Object other) =>
      other is SectionWords &&
      other.subtitle == subtitle &&
      other.tooltip == tooltip &&
      other.sentence == sentence &&
      other.offerWake == offerWake;

  @override
  int get hashCode => Object.hash(subtitle, tooltip, sentence, offerWake);
}

/// Read [section] the way the contract's table does.
///
/// One sentence at most, in this order — the most recent thing a person did first: a wake that is
/// running; the outcome of one that showed nothing; then what the section's own state says. The
/// asleep subtitle is independent of all of them: it describes the list, and a list can be there
/// under any of them.
///
/// [asking] is a wake this surface has sent and not yet heard back about. The daemon answers one
/// at once with `waking`, so this only covers that round trip — and an answer that does not say
/// `waking` (a daemon that predates the wake) puts the "Show models" row back rather than leaving a
/// promise nothing will keep.
SectionWords sectionWords(GridSection section, {bool asking = false}) {
  final state = section.state;
  final hasModels = section.models.isNotEmpty;
  final noRecord = section.lastKnownAge == null;
  final subtitle = state == GridSectionState.asleep && hasModels
      ? restingSubtitle(section.lastKnownAge)
      : null;
  final wakeable = state == GridSectionState.asleep && !hasModels && noRecord;
  final String? sentence;
  var offerWake = false;
  if (state == GridSectionState.waking) {
    sentence = kStartingUpWait;
  } else if (section.wakeOutcome case final outcome?) {
    sentence = switch (outcome) {
      GridWakeOutcome.notStarted => couldNotStart(section),
      GridWakeOutcome.nobodyServing => kNobodyServing,
    };
  } else if (wakeable) {
    sentence = asking ? kStartingUpWait : null;
    offerWake = !asking;
  } else if (state == GridSectionState.asleep && !hasModels) {
    sentence = kNobodyWasServing;
  } else if (state == GridSectionState.unknown &&
      (hasModels || section.seenAt != null || !noRecord)) {
    sentence = kNotAnswering;
  } else {
    sentence = null;
  }
  if (subtitle == null && sentence == null && !offerWake) {
    return SectionWords.none;
  }
  return SectionWords(
    subtitle: subtitle,
    tooltip: subtitle == null ? null : kRestingTooltip,
    sentence: sentence,
    offerWake: offerWake,
  );
}

/// The note for [note], up to the picker action when it has one — see [notServedNoteSentence].
String noteSentence(GridNote note) => switch (note) {
  GridNoteOffline(:final machine) => offlineNoteSentence(machine, note.model),
  GridNoteNotServed() => notServedNoteSentence(note.model),
};
