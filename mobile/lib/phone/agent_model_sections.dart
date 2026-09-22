/// What the model sheet draws, decided away from any widget so the shape of the
/// answer can be read — and tested — without pumping a sheet.
///
/// The desktop's `grid_model_picker.dart` makes the same three decisions inline
/// in its menu builder. They are pulled out here because a phone sheet rebuilds
/// on every refresh that lands under it, and a rule buried in a builder is one
/// nothing can assert on.
library;

import 'package:harness_mobile/core/models.dart';

/// The engines whose agents are OFFERED the switch.
///
/// Named here rather than derived from the daemon's `localModelEngines`,
/// because the two answer different questions. That list is which engines a
/// Local model *can* be handed to — a launch contract exists for seven of them.
/// This is the narrower question of which ones a person is offered the switch
/// on, and it is the three whose switching has been driven end to end: Claude
/// Code and Codex move by environment, and OpenCode by a config file plus its
/// own `/models` picker.
///
/// The rest keep the model they have. A row that looks like a choice and may
/// not be one costs an agent answering on a model nobody asked for.
const Set<String> kModelSheetEngines = {'claude', 'codex', 'opencode'};

/// Whether [engine] gets the sheet at all. Unknown or absent is NO — a menu
/// offers nothing it cannot back.
bool modelSheetSupports(String? engine) =>
    kModelSheetEngines.contains(engine?.trim().toLowerCase());

/// The sections worth a heading: the own grid always (so its empty-state
/// sentence has a place to be), and a shared grid only while it serves
/// something.
///
/// A team grid with nothing running is not a choice this sheet can offer, and a
/// heading over "nothing here" is a line to read for no gain — the sheet is for
/// picking a model, not for surveying grids.
List<GridSection> modelSheetSections(GridModels answer) {
  final sections = answer.sections
      .where((s) => s.own || s.models.isNotEmpty)
      .toList();
  if (sections.any((s) => s.own)) return sections;
  return [
    GridSection(name: answer.gridName ?? '', own: true, models: answer.models),
    ...sections,
  ];
}

/// What a section with nothing in it says, or null when it says nothing.
///
/// Three situations, three sentences, because they send a person to three
/// different places. Folding them together is what once put "sign in again" in
/// front of a signed-in user whose daemon happened to be offline — advice that
/// was wrong, and that would not have helped even if the diagnosis had been
/// right.
///
/// A shared grid is never drawn empty (see [modelSheetSections]), so the last
/// branch only ever fires for the own grid.
String? modelSheetEmptySentence(GridModels answer, GridSection section) {
  if (!answer.reachable) return 'Could not reach this machine.';
  // The machine's gap before the account's: with no `grid` on that computer
  // there is nothing a sign-in could set up there, and the feature's name is
  // the only word for it a person knows.
  if (answer.gridCli == GridCli.missing) {
    return "Harness Compute isn't installed on this machine.";
  }
  // ⚠️ **It names the desktop, where the desktop's own picker offers a button.**
  // That button opens Grid — the harness that serves models on a machine — as a
  // new agent, which needs the Store, and the phone has none: no `probeDsh`, no
  // `openStore`, and `createAgent` here cannot name a harness. A door that is
  // not there must not be drawn, but the answer to an empty section still has
  // to be somewhere, so the sentence carries it.
  if (section.own) {
    return 'No local models on this account yet. Grid, on your computer, is '
        'where models are started.';
  }
  return null;
}

/// The heading over a section, and the quieter line under it.
///
/// Own: one plain sentence, nothing under it — "your machines" is the second
/// half of the same fact and reads oddly split onto its own clause. Shared: the
/// general fact as the heading, the specific grid as the name under it. The two
/// are different kinds of information — why the rows are here, versus which
/// fleet they are — not one sentence.
({String caption, String? detail}) modelSheetHeading(GridSection section) =>
    section.own
    ? (caption: 'Local models on your machines', detail: null)
    : (caption: 'Models shared with you', detail: section.name);
