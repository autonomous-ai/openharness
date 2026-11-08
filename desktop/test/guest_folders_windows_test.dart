import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/guest_folders.dart';

void main() {
  test(
    'a Windows machine keeps its workspace and folders, not only POSIX paths',
    () {
      final places = GuestFolders.fromJson({
        'workspace': r'C:\Users\hg_0123456789ab\work',
        'folders': [
          {'path': r'C:\Users\DELL\project', 'write': true},
          {'path': r'D:\docs', 'write': false},
          {'path': '/Users/owner/mac-project', 'write': false},
          {'path': 'relative', 'write': false},
        ],
      });
      expect(places.workspace, r'C:\Users\hg_0123456789ab\work');
      expect(places.folders.map((folder) => (folder.path, folder.write)), [
        (r'C:\Users\DELL\project', true),
        (r'D:\docs', false),
        ('/Users/owner/mac-project', false),
      ]);
    },
  );

  test('the shared form accepts either absolute shape', () {
    expect(isAbsoluteGuestPath(r'C:\Users\owner\project'), isTrue);
    expect(isAbsoluteGuestPath('D:/work'), isTrue);
    expect(isAbsoluteGuestPath('/Users/owner/project'), isTrue);
    expect(isAbsoluteGuestPath(r'Users\owner'), isFalse);
    expect(isAbsoluteGuestPath('project'), isFalse);
  });
}
