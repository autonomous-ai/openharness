import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/session_preview.dart';

import 'agent_index.dart';
import 'phone_prompt_context.dart';

/// What one row is, and so what a tap on it does.
///
/// The desktop distinguishes the same five kinds inside one `SwarmDestination`,
/// through `isProject` / `isMachine` / `isCommand` / `pickerQuery` getters
/// rather than a field. Named here because the phone draws each kind with a
/// different mark and opens each one differently, and a chain of getters at
/// every one of those call sites is how the two drifted apart the first time.
enum PhoneDestinationKind {
  /// A harness. The only kind that opens a terminal.
  agent,

  /// A machine, as `@` lists them. Tapping it scopes the search to its agents.
  machine,

  /// A repository or folder, as `#` lists them. Tapping it scopes the search
  /// to its agents.
  project,

  /// Something the app does, as `>` lists them.
  command,

  /// A `?` row: it rewrites the query in place instead of opening anything.
  mode,
}

/// One row the search can offer, whichever of the catalogs it came from.
///
/// This is the phone's `SwarmDestination`, ported field for field from
/// `desktop/lib/state/swarm_navigation.dart` so both apps rank the same rows on
/// the same strings. [fields] and [titleFieldCount] in particular are the whole
/// ranking contract: see `rankPhoneDestinations`.
///
/// ⚠️ **[fields] keeps empty strings.** Only nulls are dropped. [titleFieldCount]
/// counts positions from the front, so filtering a blank title out would shift
/// every metadata field into a title slot and rank a folder like a name.
class PhoneDestination {
  PhoneDestination({
    required this.id,
    required this.kind,
    required this.title,
    required this.detail,
    this.detailBranchOffset,
    this.promptContext,
    this.machineId,
    this.machineLabel = '',
    this.agentId,
    this.engine,
    this.commandId,
    this.pickerQuery,
    this.shortcut,
    this.projectId,
    this.previewKey,
    this.members = const {},
    this.entry,
    this.machine,
    Iterable<String?> searchFields = const [],
    int titleFields = 1,
  }) : fields = [
         title.toLowerCase(),
         ...searchFields.whereType<String>().map((s) => s.toLowerCase()),
       ],
       titleFieldCount = titleFields;

  final String id;
  final PhoneDestinationKind kind;

  /// The name, as the row draws it and as the query matches it first.
  final String title;

  /// The metadata line: harness · project · branch · machine, or a kind and a
  /// count for a group.
  final String detail;

  /// Where the branch starts inside [detail], so a plain-text rendering can set
  /// its glyph there without the searchable text or the match offsets moving.
  final int? detailBranchOffset;

  /// The same facts as [detail], but as the identity the row actually DRAWS:
  /// engine, machine, project, branch, each its own segment with its own glyph
  /// and colour. See [PhonePromptContextView].
  ///
  /// ⚠️ **Supplied by the catalog, never parsed back out of [detail].** That is
  /// the desktop's rule ("identity supplied by the catalog, never inferred by
  /// parsing display text"), and it is what keeps a machine called `work · 2`
  /// from being split down its separator into two segments.
  ///
  /// Null on every kind but an agent — a project row's "Project · 3 harnesses"
  /// is a count, not a place, and falls back to [detail] as plain text.
  final PhonePromptContext? promptContext;

  final String? machineId, agentId, engine;
  final String machineLabel;

  /// Set on [PhoneDestinationKind.command] — what running it asks the app for.
  final String? commandId;

  /// Set on [PhoneDestinationKind.mode] — the text a tap puts in the field, so
  /// `?` teaches the other modes by taking you into one.
  final String? pickerQuery;

  /// The key that reaches this row directly on the desktop. Drawn faint on the
  /// `?` rows, because somebody searching on the phone is usually somebody who
  /// will be back at the keyboard later.
  final String? shortcut;

  final String? projectId;

  /// What was last asked of this agent and what it answered, for the content
  /// fallback. Null for every kind but [PhoneDestinationKind.agent].
  final SessionPreviewKey? previewKey;

  /// The agent rows this group holds, by [id]. Empty for an agent.
  final Set<String> members;

  /// Set on [PhoneDestinationKind.agent] — what a tap opens.
  final AgentEntry? entry;

  /// Set on [PhoneDestinationKind.machine].
  final MachineState? machine;

  /// Every searchable string, lowercased, names first.
  ///
  /// Not all of it is drawn — an engine id, a project path — which is why
  /// `SearchResultText` re-checks that a matched field is present in the text it
  /// is about to embolden rather than trusting the match alone.
  final List<String> fields;

  /// How many leading [fields] are "the name of the thing" rather than
  /// metadata: the row's title, plus the agent's own title when it has one. A
  /// match there outranks any match in a folder, a machine or a recap.
  final int titleFieldCount;

  bool get isAgent => kind == PhoneDestinationKind.agent;
  bool get isProject => kind == PhoneDestinationKind.project;
  bool get isMachine => kind == PhoneDestinationKind.machine;
  bool get isCommand => kind == PhoneDestinationKind.command;
  bool get isMode => kind == PhoneDestinationKind.mode;

  /// Whether tapping it narrows the search to the agents inside it rather than
  /// opening anything — a project or a machine.
  bool get isGroup => isProject || isMachine;
}
