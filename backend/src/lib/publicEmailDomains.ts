/**
 * Email domains anyone can get an address at. Sharing a machine with "everyone at @domain"
 * (lib/machineAccess.ts) is offered only for a domain that names an organization: at one of these it would
 * share the machine with strangers. Apple's private relay is here too: "Hide My Email" gives every Apple
 * account an address under it, and `pending.harness.invalid` is the placeholder a device row signs in
 * with before its account is known (services/UserService.ts).
 *
 * Kept short and plain on purpose: the providers people actually sign in with. A domain missing here is
 * offered to its owner, who still has to turn it on.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com',
  'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es', 'outlook.fr', 'outlook.de', 'live.co.uk',
  'yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.co.jp', 'yahoo.com.vn',
  'icloud.com', 'me.com', 'mac.com', 'privaterelay.appleid.com',
  'aol.com', 'aim.com',
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com',
  'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru',
  'tutanota.com', 'tuta.io', 'fastmail.com', 'hey.com', 'duck.com',
  'qq.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'naver.com', 'daum.net', 'hanmail.net',
  'pending.harness.invalid',
])

/** The domain of `email`, lower case; null when it has none. */
export function emailDomain(email: string): string | null {
  const at = email.trim().toLowerCase().lastIndexOf('@')
  const domain = at < 0 ? '' : email.trim().toLowerCase().slice(at + 1)
  return domain.includes('.') ? domain : null
}

/** Whether `domain` is one anyone can have an address at (or no organization's at all). */
export function isPublicEmailDomain(domain: string | null): boolean {
  return !domain || PUBLIC_EMAIL_DOMAINS.has(domain.toLowerCase()) || domain.toLowerCase().endsWith('.invalid')
}
