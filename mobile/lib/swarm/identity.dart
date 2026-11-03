/// Fallback for a person's recorded name when their Swarm membership is no
/// longer available, as Desktop does (`desktop/lib/super_tabs/identity.dart`).
String superTabPersonName(String email) => email.split('@').first;
