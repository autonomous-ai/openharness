/**
 * The account's zoo — its individuals and eggs, the same on every client (lib/zoo.ts for the rules,
 * daemons/README.md for the contract).
 *
 *   GET  /api/zoo       → { revision, zoo }
 *   POST /api/zoo/ops   → { ops } applied in order under `revision`,
 *                         answers { revision, zoo, hatched, grants, levelUps }
 *
 * The desk's write discipline (routes/desk.ts), on its own document: a write that lost a race is
 * retried from the fresh zoo, since the ops are idempotent and drop-on-missing. A hatch that lost the
 * race draws again against the fresh zoo; only the draw that was written is answered, and the same for
 * the eggs granted and the levels reached. After a change a client would draw (lib/zoo.ts `shownZoo`:
 * individuals, eggs, pair, dial, consent, habits — not a tally of turns or xp short of a level) every
 * adapter socket of the user hears `zoo_changed` (lib/adapterAccountPushes.ts), and so does every web and
 * phone socket (lib/webWs.ts). The revision moves with every write either way.
 *
 * A zoo stored before individuals is read as individuals with uids derived from the account and the
 * species (lib/zoo.ts `parseZoo`), so a client that read it can name them before and after the next write
 * stores the new shape.
 *
 * Every hatch — a species the account owns too — takes that species' next serial (`DaemonMint`, an
 * atomic increment shared by every account) before the write. A serial minted for a write that lost the
 * race is kept for the retry's hatch of the same species, so a race costs no numbers; one the request
 * never writes is a gap, never a number given twice.
 *
 * Dark unless the server's daemons switch is on (lib/daemonsSwitch.ts, `HARNESS_DAEMONS`): off, none of
 * this is registered and both paths answer the server's ordinary 404; on with an allowlist
 * (`HARNESS_DAEMONS_USERS`), an account outside it gets that same 404 before anything is read or written.
 * Production also requires the account's focus_bar_creature opt-in; absent or false returns 404
 * without reading or changing its collection. A client reads 404 as "daemons are off" and hides it.
 */
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import type { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { publishZooChanged } from '../lib/bus.js'
import { daemonsFor, DAEMONS_DARK, type DaemonsSwitch } from '../lib/daemonsSwitch.js'
import { applyZooOps, emptyZoo, parseZoo, zooOpsBodySchema, zooShownChanged, type Hatched, type Zoo, type ZooContext, type ZooDoc, type ZooOp } from '../lib/zoo.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { readExperimentalSettings } from '../lib/experimentalSettings.js'

const WRITE_ATTEMPTS = 5
/** Two first-ever hatches of one daemon at once both try to create its counter; the loser increments. */
const MINT_ATTEMPTS = 3

async function readZoo(userId: string): Promise<ZooDoc> {
  const row = await prisma.zoo.findUnique({ where: { userId } })
  return row ? { revision: row.revision, zoo: parseZoo(row.state, { userId }) } : { revision: 0, zoo: emptyZoo() }
}

/** Which of the machines the turn reports name are this account's. Only those count as a machine
 *  seen; a made-up id still has its turns counted, it just earns no second-machine egg. */
async function contextFor(userId: string, ops: ZooOp[]): Promise<ZooContext> {
  const named = [...new Set(ops.flatMap((op) => op.op === 'zoo.turn' ? [op.machineId] : []))]
  if (!named.length) return {}
  const rows = await prisma.machine.findMany({ where: { userId, machineId: { in: named } }, select: { machineId: true } })
  const owned = new Set(rows.map((r) => r.machineId))
  return { ownsMachine: (id) => owned.has(id) }
}

/** The next serial of the species `daemonId`: an atomic increment of its counter, which starts at 1 on
 *  the first hatch of that species anywhere. */
async function mint(daemonId: string): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      const row = await prisma.daemonMint.upsert({
        where: { daemonId },
        create: { daemonId, count: 1 },
        update: { count: { increment: 1 } },
        select: { count: true },
      })
      return row.count
    } catch (error) {
      if (attempt < MINT_ATTEMPTS && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue
      throw error
    }
  }
}

/** Serials minted during this request and not yet written, by species, lowest first. */
type SerialPool = Map<string, number[]>

/**
 * Give each individual this request hatched its species' serial: one kept from an attempt that lost the
 * race, or a fresh one. Returns what it used, so a lost race can put them back.
 */
async function giveSerials(zoo: Zoo, hatched: Hatched[], pool: SerialPool): Promise<Array<[string, number]>> {
  const used: Array<[string, number]> = []
  for (const h of hatched) {
    const d = zoo.daemons.find((x) => x.uid === h.uid)
    if (!d) continue
    const serial = pool.get(h.daemonId)?.shift() ?? await mint(h.daemonId)
    d.serial = serial
    h.serial = serial
    used.push([h.daemonId, serial])
  }
  return used
}

function keepSerials(pool: SerialPool, used: Array<[string, number]>): void {
  for (const [id, serial] of used) pool.set(id, [...(pool.get(id) ?? []), serial].sort((a, b) => a - b))
}

export interface ZooRouteOptions {
  /** Whether this server has daemons, and for whom. Absent: dark, nothing registered. */
  daemons?: DaemonsSwitch
  /** Production requires the account's explicit Experimental choice as well as server availability. */
  requireAccountOptIn?: boolean
}

export async function zooRoutes(app: FastifyInstance, opts: ZooRouteOptions = {}): Promise<void> {
  const daemons = opts.daemons ?? DAEMONS_DARK
  if (!daemons.on) return
  // An account outside the allowlist hears exactly what it would with the switch off: the ordinary 404,
  // ahead of the body's validation, so not even a malformed request tells it the route exists. Scoped to
  // this plugin, so it guards these routes only.
  app.addHook('preHandler', async (req, reply) => {
    if (!daemonsFor(daemons, req.user)) return reply.callNotFound()
    if (opts.requireAccountOptIn && !(await readExperimentalSettings(req.user!.sub)).features.focus_bar_creature) {
      return reply.callNotFound()
    }
  })

  app.get('/api/zoo', async (req, reply) => {
    sendSuccess(reply, await readZoo(req.user!.sub))
  })

  app.post<{ Body: z.infer<typeof zooOpsBodySchema> }>(
    '/api/zoo/ops', { preHandler: [validateBody(zooOpsBodySchema)] },
    async (req, reply) => {
      const userId = req.user!.sub
      const ctx = await contextFor(userId, req.body.ops)
      const serials: SerialPool = new Map()
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const current = await readZoo(userId)
        const applied = applyZooOps(current.zoo, req.body.ops, undefined, new Date(), ctx)
        // Nothing moved — the same request twice, or ops on eggs already hatched. Say where we are.
        if (!applied.changed) return sendSuccess(reply, { ...current, hatched: [], grants: [], levelUps: [] })
        const used = await giveSerials(applied.zoo, applied.hatched, serials)
        const next = { revision: current.revision + 1, zoo: applied.zoo }
        const state = next.zoo as unknown as Prisma.InputJsonValue
        // Compare-and-set on the revision: whoever wrote first wins, the other re-reads and replays.
        const bumped = await prisma.zoo.updateMany({ where: { userId, revision: current.revision }, data: { revision: next.revision, state } })
        if (bumped.count !== 1) {
          if (current.revision !== 0) { keepSerials(serials, used); continue }
          // No row yet (the only way revision 0 and no update): make it. A second client making it at
          // the same moment trips the unique index and re-reads what the first one wrote.
          try {
            await prisma.zoo.create({ data: { userId, revision: next.revision, state } })
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') { keepSerials(serials, used); continue }
            throw error
          }
        }
        // Everyone else hears it only when something they draw changed: a report that only tallied (a
        // `zoo.turn` short of an egg or a level) is read on their next natural fetch, not every minute.
        if (zooShownChanged(current.zoo, applied.zoo)) void publishZooChanged(userId, { revision: next.revision })
        return sendSuccess(reply, { ...next, hatched: applied.hatched, grants: applied.grants, levelUps: applied.levelUps })
      }
      return sendError(reply, 'The zoo is changing too quickly; try again.', 'ZOO_BUSY', 409)
    },
  )
}
