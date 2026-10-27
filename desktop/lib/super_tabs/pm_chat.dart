/// The visible name of a person's private chat with a project's Product
/// Manager (docs/naming-system.md).
const kChatWithPm = 'Chat with PM';

/// What a PM chat's unread count says: "2 new in Chat with PM".
String pmUnreadLabel(int count) => '$count new in $kChatWithPm';
