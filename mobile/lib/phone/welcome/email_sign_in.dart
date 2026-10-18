import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../tty.dart';
import '../tty_controls.dart';
import 'onboarding_frame.dart';

/// One step of signing in by email: back, a title, a line or two, a field, the button — on the
/// welcome's left edge and in its headline's face ([OnboardingFrame]).
class SignInForm extends StatelessWidget {
  const SignInForm({
    super.key,
    required this.onBack,
    required this.title,
    required this.lines,
    required this.field,
    required this.button,
    this.error,
    this.footer,
  });

  final VoidCallback onBack;
  final String title;
  final List<String> lines;
  final Widget field;
  final Widget button;
  final String? error;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: TtyBackButton(onPressed: onBack),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(
              OnboardingFrame.side,
              12,
              OnboardingFrame.side,
              16,
            ),
            children: [
              // A title that wraps: "Check your email" is more than a 320pt phone holds on one line
              // at the largest text size, and a one-line TtyText cut it there.
              Text(title, style: OnboardingFrame.headlineStyle(tty)),
              const SizedBox(height: 12),
              for (final line in lines)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(
                    line,
                    style: tty.style(size: TtySize.row, color: tty.faint),
                  ),
                ),
              const SizedBox(height: 18),
              AutofillGroup(child: field),
              if (error case final error?)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    '✗ $error',
                    style: tty.style(size: TtySize.meta, color: tty.red),
                  ),
                ),
              const SizedBox(height: 16),
              button,
              ?footer,
            ],
          ),
        ),
      ],
    );
  }
}

/// The code, typed into one wide field in big mono digits — it submits itself on the last one.
class SignInCodeField extends StatelessWidget {
  const SignInCodeField({
    super.key,
    required this.controller,
    required this.focus,
    required this.length,
    required this.onFilled,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final int length;
  final VoidCallback onFilled;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      height: 64,
      decoration: BoxDecoration(
        color: ttyRaised(tty),
        borderRadius: BorderRadius.circular(6),
      ),
      alignment: Alignment.center,
      child: TextField(
        key: const Key('welcome-code'),
        controller: controller,
        focusNode: focus,
        keyboardType: TextInputType.number,
        autofillHints: const [AutofillHints.oneTimeCode],
        textAlign: TextAlign.center,
        maxLength: length,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        cursorColor: tty.green,
        style: tty
            .style(size: 30, weight: FontWeight.w600)
            .copyWith(letterSpacing: 18),
        onChanged: (value) {
          if (value.length == length) onFilled();
        },
        decoration: InputDecoration(
          isCollapsed: true,
          counterText: '',
          filled: false,
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          hintText: '•' * length,
          hintStyle: tty
              .style(size: 30, color: tty.dim)
              .copyWith(letterSpacing: 18),
        ),
      ),
    );
  }
}
