import 'package:flutter/material.dart';

import 'app_theme.dart' as grid;

/// Scholes's agreed Machines palette and geometry. Scoped to this screen so
/// matching its mockup does not recolor the rest of the workspace.
abstract final class MachinesStyle {
  static Color get background =>
      grid.AppTheme.pick(const Color(0xffffffff), const Color(0xff141416));
  static Color get field =>
      grid.AppTheme.pick(const Color(0xfff6f6f7), const Color(0xff1b1b1e));
  static Color get line =>
      grid.AppTheme.pick(const Color(0xffe6e6e9), const Color(0xff2b2b30));
  static Color get ink =>
      grid.AppTheme.pick(const Color(0xff17171a), const Color(0xfff2f2f4));
  static Color get metadata =>
      grid.AppTheme.pick(const Color(0xff6b6b73), const Color(0xffa3a3ac));
  static Color get label =>
      grid.AppTheme.pick(const Color(0xff9a9aa3), const Color(0xff75757e));
  static Color get accent =>
      grid.AppTheme.pick(const Color(0xff1a73e8), const Color(0xff6aa4f8));
  static Color get online =>
      grid.AppTheme.pick(const Color(0xff1e9e5a), const Color(0xff43c882));
  static Color get asleep =>
      grid.AppTheme.pick(const Color(0xffc98a13), const Color(0xffe0a83c));
  static Color get offline =>
      grid.AppTheme.pick(const Color(0xffb3b3bb), const Color(0xff5c5c65));
  static Color get selected =>
      grid.AppTheme.pick(const Color(0xffeaf2fe), const Color(0xff1c2b40));
  static Color get selectedInk =>
      grid.AppTheme.pick(const Color(0xff14498f), const Color(0xffb8d4ff));
  static Color get chip =>
      grid.AppTheme.pick(const Color(0xffeef0f3), const Color(0xff27272b));
  static const side = EdgeInsets.symmetric(horizontal: 24);
  static const rowInset = EdgeInsets.symmetric(horizontal: 12);
  static const toolbarInset = EdgeInsets.symmetric(
    horizontal: 24,
    vertical: 12,
  );
  static const filterInset = EdgeInsets.fromLTRB(24, 8, 24, 0);
  static const headerInset = EdgeInsets.all(24);
  static const groupInset = EdgeInsets.only(top: 24, bottom: 8);
  static const badgeInset = EdgeInsets.symmetric(horizontal: 4);
  static const chipInset = EdgeInsets.symmetric(horizontal: 8, vertical: 4);
  static const radius = BorderRadius.all(Radius.circular(8));
  static const pillRadius = BorderRadius.all(Radius.circular(20));
  static const fieldPadding = EdgeInsets.symmetric(horizontal: 12, vertical: 8);
  static TextStyle title() => grid.AppType.body().copyWith(
    fontSize: 22,
    fontWeight: FontWeight.w600,
    letterSpacing: -.44,
    color: ink,
  );
  static TextStyle name({bool own = false}) => grid.AppType.body().copyWith(
    fontSize: 15,
    fontWeight: FontWeight.w600,
    letterSpacing: -.15,
    height: 1.3,
    color: own ? selectedInk : ink,
  );
  static TextStyle body({Color? color}) => grid.AppType.body().copyWith(
    fontSize: 13,
    height: 1.3,
    color: color ?? metadata,
  );
  static TextStyle small({Color? color, bool heading = false}) =>
      grid.AppType.body().copyWith(
        fontSize: 11,
        height: 1.3,
        color: color ?? label,
        letterSpacing: heading ? .66 : 0,
      );
  static const tabular = [FontFeature.tabularFigures()];
}
