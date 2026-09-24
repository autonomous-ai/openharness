import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// One field of the phone's sign-in form — the email, or the emailed code.
///
/// [maxDigits] makes it a code field: digits only, no more than that many, and
/// the last one typed submits — there is nothing left to wait for.
class LoginTextField extends StatelessWidget {
  const LoginTextField({
    super.key,
    required this.controller,
    required this.hint,
    required this.keyboard,
    required this.autofill,
    required this.enabled,
    required this.onSubmitted,
    this.maxDigits,
  });

  final TextEditingController controller;
  final String hint;
  final TextInputType keyboard;
  final String autofill;
  final bool enabled;
  final VoidCallback onSubmitted;
  final int? maxDigits;

  @override
  Widget build(BuildContext context) {
    final digits = maxDigits;
    return TextField(
      controller: controller,
      autofocus: true,
      enabled: enabled,
      keyboardType: keyboard,
      autofillHints: [autofill],
      autocorrect: false,
      textAlign: TextAlign.center,
      textInputAction: TextInputAction.go,
      inputFormatters: [
        if (digits != null) ...[
          FilteringTextInputFormatter.digitsOnly,
          LengthLimitingTextInputFormatter(digits),
        ],
      ],
      decoration: InputDecoration(hintText: hint),
      onChanged: digits == null
          ? null
          : (value) {
              if (value.length == digits) onSubmitted();
            },
      onSubmitted: (_) => onSubmitted(),
    );
  }
}
