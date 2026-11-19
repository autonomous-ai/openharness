// What the model's tests share: a BarModel on a fake clock with a recording link (NullLink.sent), the rings and the
// questions of the C model's tests (devices/harness-max/firmware/test/test_max_*.c).
import 'package:harness_max_bar/link/bar_link.dart';
import 'package:harness_max_bar/link/chime.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';

final DateTime t0 = DateTime(2026, 11, 18, 14);

/// `ms` after [t0].
DateTime at(int ms) => t0.add(Duration(milliseconds: ms));

/// The chimes the model asks for, in order.
class RecordingChime implements Chime {
  final List<ChimeSound> sounds = [];

  int get plays => sounds.length;

  @override
  Future<void> play(ChimeSound sound) async => sounds.add(sound);
}

class TestBar {
  TestBar() {
    model = BarModel(link: link, clock: () => now, chime: chime);
    model.addListener(() => notes++);
  }

  final NullLink link = NullLink();
  final RecordingChime chime = RecordingChime();
  DateTime now = t0;
  late final BarModel model;

  /// How many times the model told its pages something changed.
  int notes = 0;

  /// The clock at `ms` after [t0].
  void at(int ms) => now = t0.add(Duration(milliseconds: ms));

  /// What the model asked of the link since the last look; forgets it.
  List<String> sent() {
    final s = List.of(link.sent);
    link.sent.clear();
    return s;
  }
}

/// Agents named after their ids, of Claude, every cap.
List<AgentRow> rows(List<String> ids) => [for (final id in ids) AgentRow(id: id, name: id, engine: 'claude')];

/// A computer on the cable and this ring, Overview up, nothing sent yet.
TestBar linked(List<String> ids) {
  final b = TestBar();
  b.model.onLink(true, computer: 'MacBook Pro');
  b.model.onAgents(rows(ids));
  return b;
}

const abc = ['a', 'b', 'c'];
const abcde = ['a', 'b', 'c', 'd', 'e'];

/// More agents than two pages of cells hold.
final List<String> xs = [for (var i = 0; i < 12; i++) 'x$i'];

const db = AskItem(key: 'db', q: 'Which database?', options: ['Dev', 'Staging']);
const deploy = AskItem(key: 'perm', q: 'Approve Bash command: npm run deploy:staging', options: ['Yes', 'No']);
const two = [
  AskItem(key: 'db', q: 'Which database?', options: ['Dev', 'Staging']),
  AskItem(key: 'checks', q: 'Which checks?', options: ['Lint', 'Types', 'Tests'], multi: true),
];

/// The reviewed path up to its card: asked as toolu_1, read by the clock, and the state back with token "tok".
void reviewed(TestBar b, String id, List<AskItem> items) {
  b.model.onQuestion(id, 'toolu_1', items[0].q, items: items, review: true);
  b.model.tick();
  b.model.onQuestionState(id, b.model.asks[id]!.fetch,
      ok: true, requestId: 'toolu_1', token: 'tok', items: items);
  b.sent();
}

/// The newest notice of this agent and kind.
Notice noteOf(BarModel m, String id, AttnKind kind) => m.inbox.firstWhere((n) => n.agentId == id && n.kind == kind);
