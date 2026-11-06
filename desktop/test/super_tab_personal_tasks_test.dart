import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/parts.dart';
import 'super_tab_parts_test.dart' show recorded;

Map<String, dynamic> task(String id, int version, int at) => {
  'id': id, 'version': version, 'at': at, 'projectId': 'lead5701',
  'projectName': 'Old project', 'title': 'Task $id', 'status': 'proposal',
  'suggested': true, 'agent': {'id': '0540', 'name': 'Old name'},
};
Map<String, dynamic> feed(List<Map<String, dynamic>> rows, {bool reset = false,
  List<String> removed = const [], String mode = 'autoApprove'}) => {
  'approvalMode': mode, 'reset': reset, 'upserts': rows, 'removed': removed,
};
void main() {
  test('old backend has no capability; first load sorts newest then id', () {
    expect(SuperTabParts.firstLoad(recorded('first_load')).personalTasks.supported, isFalse);
    final parts = SuperTabParts.firstLoad(recorded('first_load')..['personalTasks'] =
      feed([task('b', 2, 10), task('a', 1, 20), task('c', 1, 10)], reset: true));
    expect(parts.personalTasks.supported, isTrue);
    expect(parts.personalTasks.mode, 'autoApprove');
    expect(parts.personalTasks.rows.map((r) => r.id), ['a', 'b', 'c']);
  });
  test('overlap keeps newest version and marks feed changes as content', () {
    final parts = SuperTabParts.firstLoad(recorded('first_load')..['personalTasks'] =
      feed([task('a', 3, 20)], reset: true));
    final changed = parts.apply(recorded('changes')..['personalTasks'] =
      feed([task('a', 2, 5), task('b', 1, 30)], mode: 'review'));
    expect(parts.personalTasks.rows.map((r) => r.id), ['b', 'a']);
    expect(parts.personalTasks.rows.last.version, 3);
    expect(parts.personalTasks.mode, 'review');
    expect(changed.changed, isTrue);
    expect(changed.machinesOnly, isFalse);
    expect(changed.readMarksOnly, isFalse);
  });
  test('removals and visibility reset discard old rows', () {
    final parts = SuperTabParts.firstLoad(recorded('first_load')..['personalTasks'] =
      feed([task('a', 3, 20), task('b', 1, 30)], reset: true));
    parts.apply(recorded('changes')..['personalTasks'] = feed([], removed: ['a']));
    expect(parts.personalTasks.rows.map((r) => r.id), ['b']);
    parts.apply(recorded('changes')..['personalTasks'] = feed([task('c', 1, 40)], reset: true));
    expect(parts.personalTasks.rows.single.id, 'c');
  });
  test('cache round trip keeps mode and summaries; omitted delta keeps capability', () {
    final parts = SuperTabParts.firstLoad(recorded('first_load')..['personalTasks'] =
      feed([task('a', 3, 20)], reset: true, mode: 'review'));
    final restored = SuperTabParts.fromJson(parts.toJson());
    restored.apply(recorded('changes'));
    expect(restored.personalTasks.supported, isTrue);
    expect(restored.personalTasks.mode, 'review');
    expect(restored.personalTasks.rows.single.title, 'Task a');
  });
  test('tenfold feed merges one changed summary without losing others', () {
    final parts = SuperTabParts.firstLoad(recorded('first_load')..['personalTasks'] =
      feed([for(var i = 0; i < 1000; i++) task('$i', 1, i)], reset: true));
    parts.apply(recorded('changes')..['personalTasks'] = feed([task('3', 2, 2000)]));
    expect(parts.personalTasks.rows.length, 1000);
    expect(parts.personalTasks.rows.first.id, '3');
    expect(parts.personalTasks.rows.first.version, 2);
  });
}
