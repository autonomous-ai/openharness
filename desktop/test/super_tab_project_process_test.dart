import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';

/// A project's process preset (task #3897, the contract of #3896): `process`
/// and `columns` in the head, nothing from an older server.
Map<String, dynamic> _project([Map<String, dynamic> extra = const {}]) => {
  'id': 'scout',
  'name': 'scout',
  'ownerId': 'owner',
  'leadConversationId': 'scout-lead',
  ...extra,
};

void main() {
  group('the model reads a project\'s process', () {
    test('no process, from an older server, is Full with the six columns', () {
      final project = SuperTabProject.fromJson(_project());
      expect(project.process, SuperTabProcess.full);
      expect(project.isSimple, isFalse);
      expect(project.columnTitle('nextUp'), isNull);
    });

    test('simple reads with the server\'s three columns and their titles', () {
      final project = SuperTabProject.fromJson(
        _project({
          'process': 'simple',
          'columns': [
            {'id': 'todo', 'title': 'To do'},
            {'id': 'doing', 'title': 'Doing'},
            {'id': 'done', 'title': 'Done'},
          ],
        }),
      );
      expect(project.process, SuperTabProcess.simple);
      expect(project.isSimple, isTrue);
      expect(project.columnIds, ['todo', 'doing', 'done']);
      expect(project.columnTitle('doing'), 'Doing');
    });

    test('an unknown value, or a column without an id, is Full', () {
      expect(
        SuperTabProject.fromJson(_project({'process': 'custom'})).process,
        SuperTabProcess.full,
      );
      final project = SuperTabProject.fromJson(
        _project({
          'process': 'full',
          'columns': [
            {'title': 'No id'},
            'junk',
            {'id': 'working', 'title': 'Working'},
          ],
        }),
      );
      expect(project.columnIds, ['working']);
    });
  });
}
