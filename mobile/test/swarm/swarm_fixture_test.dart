import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';

import 'swarm_fixture.dart';

/// The Keychain item, held until [open] completes: a save parked mid-way.
class _HeldKey extends MemorySwarmHomeKey {
  final open = Completer<void>();

  @override
  Future<String?> read() async {
    await open.future;
    return super.read();
  }
}

void main() {
  // An inbox keeps its Home in the background, so a test can end with a save
  // still under way: deleting its folder then raced it ('Directory not empty'
  // in CI, task #2759), or the save put the folder back after it.
  test('a Home goes only after the saves its cache has under way', () async {
    final folder = Directory.systemTemp.createTempSync('swarm-home');
    addTearDown(() {
      if (folder.existsSync()) folder.deleteSync(recursive: true);
    });
    final key = _HeldKey();
    final cache = SwarmHomeCache(
      key: key,
      file: File('${folder.path}/home.bin'),
    );
    final saving = cache.write(me, const []);
    await settle();

    final removing = removeHome(cache);
    key.open.complete();
    await removing;
    await saving;

    expect(folder.existsSync(), isFalse, reason: 'the save landed after it');
  });
}
