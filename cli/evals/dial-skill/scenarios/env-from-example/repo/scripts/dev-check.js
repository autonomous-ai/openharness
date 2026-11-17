const url = process.env.DATABASE_URL
if (!url) {
  console.error('dev:check: DATABASE_URL is not set')
  process.exit(1)
}
const { protocol, pathname } = new URL(url)
if (protocol !== 'postgres:' || pathname.length < 2) {
  console.error('dev:check: DATABASE_URL must be postgres://<user>:<password>@<host>:<port>/<database>')
  process.exit(1)
}
console.log('dev:check: config ok')
