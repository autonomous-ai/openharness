import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/app_type.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/tasks/personal_task_card.dart';
import 'package:harness/super_tabs/tasks/personal_tasks.dart';
import 'package:harness/terminal/terminal_typography.dart';

/// The Swarm elements gallery (desktop-design-system.md, Swarm elements): every
/// element drawn in light and dark against its checked-in image. A new or
/// changed element updates the doc and this gallery in the same pull request.
///
/// Update the images with
/// `flutter test --no-pub --update-goldens test/swarm_elements_gallery_test.dart`
/// and look at them before committing.
void main() {
  late GoldenFileComparator previous;
  setUpAll(() async {
    // One font file on every host, so the images match on macOS, Linux and
    // Windows; text is set in the bundled Roboto Mono, icons in Lucide.
    final mono = rootBundle.load('assets/fonts/roboto-mono/RobotoMono.ttf');
    for (final family in {AppType.sansFamily, terminalFontFamily, 'Roboto'}) {
      await (FontLoader(family)..addFont(mono)).load();
    }
    // The activity marks' symbols (◌ ✓ ■ ⊘ and the spinner) come from the
    // host's symbol font, as in the app; they are a few dozen pixels, inside
    // the comparator's tolerance where hosts differ.
    for (final (family, paths) in [
      ('Apple Symbols', ['/System/Library/Fonts/Apple Symbols.ttf']),
      (
        'DejaVu Sans',
        [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          // macOS has no DejaVu; this face carries the same marks (✓).
          '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
        ],
      ),
    ]) {
      final file = paths.map(File.new).where((f) => f.existsSync()).firstOrNull;
      if (file == null) continue;
      final bytes = ByteData.sublistView(file.readAsBytesSync());
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
    previous = goldenFileComparator;
    goldenFileComparator = _NearlyComparator(
      (previous as LocalFileComparator).basedir.resolve(
        'swarm_elements_gallery_test.dart',
      ),
    );
  });
  tearDownAll(() => goldenFileComparator = previous);

  for (final brightness in Brightness.values) {
    testWidgets('every Swarm element matches its image in ${brightness.name}', (
      tester,
    ) async {
      final old = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = old);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(760, 500);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          // A still spinner, so the image holds one frame.
          home: MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: _Gallery(brightness),
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
      await expectLater(
        find.byKey(_Gallery.boundary),
        matchesGoldenFile('goldens/swarm-elements-${brightness.name}.png'),
      );
    });
  }
}

/// Agent names that pick each of the face's eight colours, in palette order.
const _faces = [
  'Kai',
  'River',
  'Quinn',
  'Buddy',
  'Atlas',
  'Ivy',
  'Milo',
  'Nova',
];

const _statuses = [
  'proposal',
  'planned',
  'working',
  'needs_human',
  'review',
  'blocked',
  'done',
  'stopped',
  'lost',
  'rejected',
];

SuperTabAgent _agent(String name, {String? kind}) => SuperTabAgent.fromJson({
  'id': 'id-$name',
  'name': name,
  'machineId': 'm',
  'harnessId': 'h',
  'contributorId': 'p',
  'configuration': {'engine': 'claude'},
  'kind': ?kind,
});

final _person = SuperTabPerson.fromJson({
  'id': 'p1',
  'email': 'dee@example.com',
  'role': 'owner',
});

class _Gallery extends StatelessWidget {
  const _Gallery(this.brightness);
  final Brightness brightness;
  static const boundary = ValueKey('swarm-elements-gallery');

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget title(String text) => Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 8),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
    Widget gap() => const SizedBox(width: 16);
    return RepaintBoundary(
      key: boundary,
      child: Material(
        color: Theme.of(context).colorScheme.surface,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Swarm elements / ${brightness.name}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              title('Agent face: eight colours'),
              Row(
                children: [
                  for (final name in _faces) ...[
                    SuperTabAvatar.agent(
                      _agent(name),
                      size: 40,
                      engineBadge: false,
                    ),
                    gap(),
                  ],
                ],
              ),
              title('Agent face, Lead ring and person at 20, 24, 30'),
              Row(
                children: [
                  for (final size in [20.0, 24.0, 30.0]) ...[
                    SuperTabAvatar.agent(
                      _agent('Kai'),
                      size: size,
                      engineBadge: false,
                    ),
                    gap(),
                    SuperTabAvatar.agent(
                      _agent('River'),
                      size: size,
                      engineBadge: false,
                      lead: true,
                    ),
                    gap(),
                    SuperTabAvatar.person(_person, size: size),
                    gap(),
                    gap(),
                  ],
                ],
              ),
              title('Task status marks'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final status in _statuses)
                    SizedBox(
                      width: 72,
                      child: Column(
                        children: [
                          SuperTabTaskStatusMark(status),
                          const SizedBox(height: 4),
                          Text(
                            superTabTaskStatusLabel(status),
                            textAlign: TextAlign.center,
                            maxLines: 2,
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        ],
                      ),
                    ),
                ],
              ),
              title('Row and task card'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 280,
                    child: Column(
                      children: [
                        SuperTabBuddyRow(
                          agentId: 'id-River',
                          agent: _agent('River', kind: 'pm'),
                          name: 'River',
                          note: 'harness',
                          tooltip: 'River',
                          lead: true,
                          onTap: () {},
                        ),
                        SuperTabBuddyRow(
                          agentId: 'id-Quinn',
                          agent: _agent('Quinn'),
                          name: 'Quinn',
                          tooltip: 'Quinn',
                          selected: true,
                          onTap: () {},
                        ),
                      ],
                    ),
                  ),
                  gap(),
                  SizedBox(
                    width: 340,
                    child: SuperTabPersonalTaskCard(
                      task: SuperTabPersonalTask({
                        'id': 't1',
                        'version': 1,
                        'at': 0,
                        'projectId': 'harness',
                        'projectName': 'harness',
                        'title': 'Friendly agent faces and a gold Lead ring',
                        'status': 'proposal',
                      }),
                      project: 'harness',
                      selected: false,
                      onOpen: () {},
                      requester: SuperTabAvatar.person(_person, size: 20),
                      agent: SuperTabAvatar.agent(
                        _agent('Quinn'),
                        size: 20,
                        engineBadge: false,
                      ),
                      waiting: true,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Matches when at most 0.5% of pixels differ by more than a quarter of a
/// channel: hosts anti-alias the same font slightly differently, while a
/// changed element moves far more. Anything else fails as the stock
/// comparator does, writing its diff images.
class _NearlyComparator extends LocalFileComparator {
  _NearlyComparator(super.testFile);

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final file = File.fromUri(basedir.resolveUri(golden));
    if (file.existsSync()) {
      final (a, b) = (
        await _pixels(imageBytes),
        await _pixels(file.readAsBytesSync()),
      );
      if (a.size == b.size) {
        var off = 0;
        for (var i = 0; i < a.bytes.length; i += 4) {
          for (var c = 0; c < 4; c++) {
            if ((a.bytes[i + c] - b.bytes[i + c]).abs() > 64) {
              off++;
              break;
            }
          }
        }
        if (off <= a.bytes.length / 4 * .005) return true;
      }
    }
    return super.compare(imageBytes, golden);
  }

  Future<({Size size, Uint8List bytes})> _pixels(Uint8List png) async {
    final codec = await ui.instantiateImageCodec(png);
    final image = (await codec.getNextFrame()).image;
    final data = await image.toByteData();
    final size = Size(image.width.toDouble(), image.height.toDouble());
    image.dispose();
    codec.dispose();
    return (size: size, bytes: data!.buffer.asUint8List());
  }
}
