/// How a person is named in the Swarm: their email's name, as the desktop
/// names them (`desktop/lib/super_tabs/identity.dart`).
String superTabPersonName(String email) => email.split('@').first;
