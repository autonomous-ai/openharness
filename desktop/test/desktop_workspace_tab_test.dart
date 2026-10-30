import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_workspace_tab.dart';

import 'support/real_fonts.dart';

typedef _Tab = ({String name, bool working});

const _eightTabs = <_Tab>[
  (name: 'New Tab', working: false),
  (name: 'Desktop', working: true),
  (name: 'Docs', working: false),
  (name: 'Web', working: false),
  (name: 'Notes', working: false),
  (name: 'API', working: false),
  (name: 'Tests', working: false),
  (name: 'Release', working: false),
];

Widget _host({
  List<_Tab> tabs = _eightTabs,
  Brightness brightness = Brightness.dark,
  double scale = 1,
  double? tabWidth,
  GlobalKey? boundary,
  VoidCallback? onSelect,
  VoidCallback? onClose,
  VoidCallback? onRename,
  bool enabled = true,
  ValueListenable<bool> showShortcuts = const AlwaysStoppedAnimation(false),
  Map<String, String?> shortcuts = const {},
}) => RepaintBoundary(
  key: boundary,
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: brightness),
    themeAnimationDuration: Duration.zero,
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: TextScaler.linear(scale)),
      child: child!,
    ),
    home: Scaffold(
      backgroundColor: grid.AppPalette.windowBg,
      body: Align(
        alignment: Alignment.topLeft,
        child: ColoredBox(
          color: grid.AppPalette.swarmTabBar,
          child: SizedBox(
            height: scale == 1 ? 40 : 54,
            child: Row(
              children: [
                const SizedBox(width: 8),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, constraints) => SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          for (final (index, tab) in tabs.indexed)
                            Builder(
                              builder: (context) => SizedBox(
                                width:
                                    tabWidth ??
                                    DesktopWorkspaceTab.widthForStrip(
                                      constraints.maxWidth,
                                      tabs.length,
                                    ),
                                child: DesktopWorkspaceTab(
                                  id: tab.name,
                                  label: tab.name,
                                  selected: tab.name == 'Desktop',
                                  showShortcuts: showShortcuts,
                                  shortcutHint: shortcuts.containsKey(tab.name)
                                      ? shortcuts[tab.name]
                                      : index < 9
                                      ? '⌘${index + 1}'
                                      : null,
                                  onSelect: enabled
                                      ? (onSelect ?? () {})
                                      : null,
                                  onClose: enabled ? (onClose ?? () {}) : null,
                                  onRename: onRename,
                                  activityLabel: tab.working ? 'Working' : null,
                                  activity: tab.working
                                      ? SizedBox(
                                          key: ValueKey('status:${tab.name}'),
                                          width: 16,
                                          child: Text(
                                            '⠋',
                                            textAlign: TextAlign.center,
                                            textScaler: TextScaler.noScaling,
                                            style:
                                                grid.AppType.mono(
                                                  color: const Color(
                                                    0xff64d2ff,
                                                  ),
                                                ).copyWith(
                                                  fontFamilyFallback: const [
                                                    'Apple Symbols',
                                                  ],
                                                ),
                                          ),
                                        )
                                      : null,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 152),
              ],
            ),
          ),
        ),
      ),
    ),
  ),
);

Future<void> _capture(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  final directory = Platform.environment['HARNESS_WORKSPACE_TAB_CAPTURE_DIR'];
  if (directory == null) return;
  await tester.runAsync(() async {
    final image =
        await (boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(directory).create(recursive: true);
    await File('$directory/$name.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

/// One tab, alone in a strip [width] wide.
Widget _single(DesktopWorkspaceTab tab, {double? width}) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: grid.buildAppTheme(brightness: Brightness.dark),
  home: Scaffold(
    backgroundColor: grid.AppPalette.windowBg,
    body: Align(
      alignment: Alignment.topLeft,
      child: ColoredBox(
        color: grid.AppPalette.swarmTabBar,
        child: SizedBox(
          key: const ValueKey('tab-slot'),
          width: width ?? grid.AppDesktop.tabMaxWidth,
          height: 40,
          child: tab,
        ),
      ),
    ),
  ),
);

DesktopWorkspaceTab _sharedTab({
  String label = 'app',
  int? sharedCount,
  VoidCallback? onInvitePeople,
  VoidCallback? onShowAgentMessages,
  VoidCallback? onStopSharing,
  VoidCallback? onMoveHere,
  VoidCallback? onLeave,
}) => DesktopWorkspaceTab(
  id: 'app',
  label: label,
  selected: true,
  showShortcuts: const AlwaysStoppedAnimation(false),
  onSelect: () {},
  onClose: () {},
  sharedCount: sharedCount,
  onInvitePeople: onInvitePeople,
  onShowAgentMessages: onShowAgentMessages,
  onStopSharing: onStopSharing,
  onMoveHere: onMoveHere,
  onLeave: onLeave,
);

Finder _label(String name) => find.byKey(ValueKey('tab-label:$name'));
Finder _close(String name) => find.byKey(ValueKey('tab-close:$name'));
Finder _tab(String name) => find.byWidgetPredicate(
  (widget) => widget is DesktopWorkspaceTab && widget.id == name,
);

void main() {
  setUpAll(() async {
    await loadRealFonts();
    if (Platform.isMacOS) {
      final sans = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in [grid.AppType.sansFamily, 'Roboto']) {
        await (FontLoader(family)..addFont(Future.value(sans))).load();
      }
      await (FontLoader('Apple Symbols')..addFont(
            Future.value(
              ByteData.sublistView(
                await File('/System/Library/Fonts/Apple Symbols.ttf')
                    .readAsBytes(),
              ),
            ),
          ))
          .load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });

  tearDown(() => grid.AppTheme.brightness.value = Brightness.dark);

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('centered ${brightness.name} tabs at $scale text scale', (
        tester,
      ) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1280, 100);
        addTearDown(tester.view.reset);
        grid.AppTheme.brightness.value = brightness;
        final boundary = GlobalKey();
        final showShortcuts = ValueNotifier(false);
        addTearDown(showShortcuts.dispose);
        await tester.pumpWidget(
          _host(
            brightness: brightness,
            scale: scale,
            boundary: boundary,
            showShortcuts: showShortcuts,
          ),
        );
        expect(tester.takeException(), isNull);
        if (scale == 1) {
          final scroll = tester.state<ScrollableState>(find.byType(Scrollable));
          expect(scroll.position.maxScrollExtent, 0);
        }
        expect(
          tester.getCenter(_label('New Tab')).dx,
          closeTo(tester.getCenter(_tab('New Tab')).dx, .01),
        );
        final title = tester.getRect(_label('Desktop'));
        final tabBounds = tester.getRect(_tab('Desktop'));
        final mark = find.byKey(const ValueKey('status:Desktop'));
        expect(mark, findsOneWidget);
        final slot = tester.getRect(
          find.ancestor(of: mark, matching: find.byType(Center)).first,
        );
        expect(slot.left - title.right, closeTo(6, .01));
        expect(
          (title.left + slot.right) / 2,
          closeTo(tabBounds.center.dx, .5),
          reason: 'the name and its status are centered together',
        );
        expect(_close('Desktop').hitTestable(), findsNothing);
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: const Offset(1260, 90));
        await tester.pump();
        await _capture(tester, boundary, 'tabs-${brightness.name}-$scale-rest');
        showShortcuts.value = true;
        await tester.pump();
        for (var number = 1; number <= _eightTabs.length; number++) {
          expect(find.text('⌘$number'), findsOneWidget);
        }
        expect(mark, findsNothing, reason: 'Command replaces the status');
        expect(tester.getRect(_tab('Desktop')), tabBounds);
        expect(_close('Desktop').hitTestable(), findsNothing);
        expect(tester.takeException(), isNull);
        await _capture(
          tester,
          boundary,
          'tabs-${brightness.name}-$scale-command',
        );
        showShortcuts.value = false;
        await tester.pump();
        expect(find.text('⌘2'), findsNothing);
        expect(mark, findsOneWidget);
        expect(tester.getRect(_label('Desktop')), title);
        await mouse.moveTo(title.center);
        await tester.pumpAndSettle();
        expect(_close('Desktop').hitTestable(), findsOneWidget);
        expect(mark, findsOneWidget, reason: 'hover keeps the status');
        // Eight tabs are narrow: the name moves left only as far as × needs,
        // never right.
        expect(
          tester.getRect(_label('Desktop')).left,
          lessThanOrEqualTo(title.left),
        );
        expect(tester.getRect(_tab('Desktop')), tabBounds);
        expect(
          tester.getRect(mark).right,
          lessThanOrEqualTo(tester.getRect(_close('Desktop')).left),
        );
        final icon = tester.widget<Icon>(
          find.descendant(of: _close('Desktop'), matching: find.byType(Icon)),
        );
        expect(icon.icon, AppIcons.close);
        expect(icon.size, AppIcons.closeSize);
        expect(
          tester.getSize(_close('Desktop')),
          const Size.square(DesktopWorkspaceTab.closeWidth),
        );
        await _capture(
          tester,
          boundary,
          'tabs-${brightness.name}-$scale-hover',
        );
        await mouse.removePointer();
        await tester.pump();
        expect(tester.getRect(_label('Desktop')), title);
        expect(_close('Desktop').hitTestable(), findsNothing);
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets('a wide tab\'s name never moves on hover', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 100);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      _host(
        tabs: const [
          (name: 'Desktop', working: true),
          (name: 'Docs', working: false),
        ],
      ),
    );
    for (final name in ['Desktop', 'Docs']) {
      final title = tester.getRect(_label(name));
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: title.center);
      await tester.pump();
      expect(_close(name).hitTestable(), findsOneWidget);
      expect(tester.getRect(_label(name)), title, reason: name);
      await mouse.removePointer();
      await tester.pump();
    }
  });

  testWidgets('a narrow tab gives its name the whole tab at rest', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(640, 100);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      _host(
        tabWidth: grid.AppDesktop.tabMinWidth,
        tabs: const [(name: 'website', working: true)],
      ),
    );
    final natural = DesktopWorkspaceTab.labelWidth(
      tester.element(_label('website')),
      'website',
    );
    final title = tester.getRect(_label('website'));
    expect(title.width, closeTo(natural, .01), reason: 'not cut at rest');
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: title.center);
    await tester.pump();
    final close = tester.getRect(_close('website'));
    final status = tester.getRect(find.byKey(const ValueKey('status:website')));
    expect(
      status.right,
      lessThanOrEqualTo(close.left),
      reason: 'revealed, the name and status clear ×',
    );
    expect(
      tester.getRect(_label('website')).left,
      greaterThanOrEqualTo(tester.getRect(_tab('website')).left + 14),
    );
    await mouse.removePointer();
    expect(tester.takeException(), isNull);
  });

  testWidgets('Return selects, × closes, a double click renames', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    var selections = 0, closes = 0, renames = 0;
    try {
      await tester.pumpWidget(
        _host(
          tabs: const [(name: 'Desktop', working: true)],
          onSelect: () => selections++,
          onClose: () => closes++,
          onRename: () => renames++,
        ),
      );
      final title = tester.getRect(_label('Desktop'));
      final status = find.bySemanticsLabel('Desktop, Working');
      expect(status, findsOneWidget);
      expect(
        tester.getSemantics(status).getSemanticsData().flagsCollection.isButton,
        isTrue,
      );
      expect(find.text('⌘1'), findsNothing, reason: 'Command is not held');
      Focus.of(tester.element(_label('Desktop'))).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(selections, 1);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: title.center);
      await tester.pump();
      await tester.tap(_close('Desktop'));
      await tester.pump();
      expect(closes, 1);
      expect(selections, 1);
      await tester.tap(_label('Desktop'));
      await tester.pump(const Duration(milliseconds: 80));
      await tester.tap(_label('Desktop'));
      await tester.pumpAndSettle();
      expect(renames, 1);
      await mouse.removePointer();
    } finally {
      await tester.pumpWidget(const SizedBox());
      semantics.dispose();
    }
  });

  testWidgets('a disabled tab reveals nothing', (tester) async {
    await tester.pumpWidget(
      _host(
        tabs: const [(name: 'Notes', working: true)],
        enabled: false,
        showShortcuts: const AlwaysStoppedAnimation(true),
      ),
    );
    expect(find.text('⌘1'), findsNothing);
    expect(find.byKey(const ValueKey('status:Notes')), findsOneWidget);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: tester.getCenter(_label('Notes')));
    await tester.pump();
    expect(_close('Notes').hitTestable(), findsNothing);
    await mouse.removePointer();
  });

  testWidgets('held hints follow remapped and unbound shortcuts', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        tabs: const [
          (name: 'Desktop', working: true),
          (name: 'Notes', working: true),
        ],
        showShortcuts: const AlwaysStoppedAnimation(true),
        shortcuts: const {'Desktop': '⌃⌥⌘R', 'Notes': null},
      ),
    );
    expect(find.text('⌃⌥⌘R'), findsOneWidget);
    expect(find.text('⌘1'), findsNothing);
    expect(find.text('⌘2'), findsNothing);
    expect(find.byKey(const ValueKey('status:Desktop')), findsNothing);
    expect(find.byKey(const ValueKey('status:Notes')), findsOneWidget);
  });
  testWidgets('the Flutter tab shows the people mark and count', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    try {
      await tester.pumpWidget(_single(_sharedTab(sharedCount: 7)));
      expect(find.byIcon(AppIcons.users), findsOneWidget);
      expect(find.text('7'), findsOneWidget);
      expect(
        find.bySemanticsLabel('app, shared tab, 7 harnesses'),
        findsOneWidget,
      );
      // After the name, inside the tab.
      final name = tester.getRect(_label('app'));
      final mark = tester.getRect(find.byKey(const ValueKey('tab-shared:app')));
      final slot = tester.getRect(find.byKey(const ValueKey('tab-slot')));
      expect(mark.left, greaterThanOrEqualTo(name.right));
      expect(mark.right, lessThanOrEqualTo(slot.right));

      await tester.pumpWidget(_single(_sharedTab(sharedCount: 1)));
      expect(
        find.bySemanticsLabel('app, shared tab, 1 harness'),
        findsOneWidget,
      );

      // An unshared tab has no mark and says nothing of sharing.
      await tester.pumpWidget(_single(_sharedTab()));
      expect(find.byIcon(AppIcons.users), findsNothing);
      expect(find.byKey(const ValueKey('tab-shared:app')), findsNothing);
      expect(find.bySemanticsLabel('app'), findsOneWidget);
    } finally {
      await tester.pumpWidget(const SizedBox());
      semantics.dispose();
    }
  });

  testWidgets('right-click opens the tab menu by role', (tester) async {
    const invite = 'Invite People…',
        show = 'Show Agent Messages',
        stop = 'Stop Sharing Tab',
        move = 'Move Here',
        leave = 'Leave Tab';
    final calls = <String>[];
    Future<void> openMenu() async {
      await tester.tap(_label('app'), buttons: kSecondaryButton);
      await tester.pumpAndSettle();
    }

    Future<void> check(DesktopWorkspaceTab tab, List<String> rows) async {
      await tester.pumpWidget(_single(tab));
      await openMenu();
      for (final row in [invite, show, stop, move, leave]) {
        expect(
          find.text(row),
          rows.contains(row) ? findsOneWidget : findsNothing,
          reason: row,
        );
      }
      // In this order.
      final tops = [for (final row in rows) tester.getRect(find.text(row)).top];
      expect(tops, [...tops]..sort());
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      for (final row in rows) {
        calls.clear();
        await openMenu();
        await tester.tap(find.text(row));
        await tester.pumpAndSettle();
        expect(calls, [row]);
        expect(find.text(row), findsNothing, reason: 'the menu closed');
      }
    }

    // Owner, shared from another of its computers.
    await check(
      _sharedTab(
        sharedCount: 3,
        onInvitePeople: () => calls.add(invite),
        onShowAgentMessages: () => calls.add(show),
        onStopSharing: () => calls.add(stop),
        onMoveHere: () => calls.add(move),
      ),
      [invite, show, stop, move],
    );
    // Member.
    await check(
      _sharedTab(
        sharedCount: 3,
        onShowAgentMessages: () => calls.add(show),
        onLeave: () => calls.add(leave),
      ),
      [show, leave],
    );
    // Unshared.
    await check(
      _sharedTab(
        onInvitePeople: () => calls.add(invite),
        onShowAgentMessages: () => calls.add(show),
      ),
      [invite, show],
    );
    // Nothing to offer: a right-click opens nothing.
    await tester.pumpWidget(_single(_sharedTab()));
    await openMenu();
    expect(find.text(show), findsNothing);
    expect(find.text(invite), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the tab menu is reachable without a mouse', (tester) async {
    final semantics = tester.ensureSemantics();
    var invited = 0;
    try {
      await tester.pumpWidget(
        _single(_sharedTab(onInvitePeople: () => invited++)),
      );
      final node = tester.getSemantics(find.bySemanticsLabel('app'));
      final action = CustomSemanticsAction.getIdentifier(
        const CustomSemanticsAction(label: 'Tab options'),
      );
      expect(
        node.getSemanticsData().customSemanticsActionIds,
        contains(action),
      );
      tester
          .renderObject(_label('app'))
          .owner!
          .semanticsOwner!
          .performAction(node.id, SemanticsAction.customAction, action);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Invite People…'));
      await tester.pumpAndSettle();
      expect(invited, 1);
    } finally {
      await tester.pumpWidget(const SizedBox());
      semantics.dispose();
    }
  });

  testWidgets('a hostile tab name stays one ellipsized line (Review Focus 5)', (
    tester,
  ) async {
    final hostile = '\u202E${'x' * 300}<b>';
    await tester.pumpWidget(
      _single(_sharedTab(label: hostile, sharedCount: 7)),
    );
    final slot = tester.getRect(find.byKey(const ValueKey('tab-slot')));
    expect(slot.width, grid.AppDesktop.tabMaxWidth);
    final text = tester.widget<Text>(_label('app'));
    // Shown as given, never read as markup.
    expect(text.data, hostile);
    expect(text.maxLines, 1);
    expect(text.overflow, TextOverflow.ellipsis);
    final name = tester.getRect(_label('app'));
    expect(name.height, lessThan(30), reason: 'one line');
    expect(name.left, greaterThanOrEqualTo(slot.left));
    expect(name.right, lessThanOrEqualTo(slot.right));
    // The name gives way; the count never does.
    final mark = tester.getRect(find.byKey(const ValueKey('tab-shared:app')));
    expect(mark.left, greaterThanOrEqualTo(name.right));
    expect(mark.right, lessThanOrEqualTo(slot.right));
    expect(find.text('7'), findsOneWidget);
    expect(tester.getRect(find.text('7')).right, lessThanOrEqualTo(slot.right));
    expect(tester.takeException(), isNull);
  });
}
