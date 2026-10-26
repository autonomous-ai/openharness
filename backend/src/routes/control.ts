import type { FastifyInstance } from 'fastify'
import type { DaemonsSwitch } from '../lib/daemonsSwitch.js'
import type { JevRouteOptions } from './jevRoute.js'
import { cursorRoutes } from './cursor.js'
import { voiceRoutes } from './voice.js'
import { harnessShareRoutes } from './harnessShares.js'
import { machineShareRoutes } from './machineShares.js'
import { harnessLinkRoutes } from './harnessLinks.js'
import { communityRoutes } from './community.js'
import { communityTranslateRoutes } from './communityTranslate.js'
import { communityCommentRoutes } from './communityComments.js'
import { communityCreatorRoutes } from './communityCreators.js'
import { communityNotificationRoutes } from './communityNotifications.js'
import { communityReportRoutes } from './communityReports.js'
import { communityEditRoutes } from './communityEdit.js'
import { deviceKeyRoutes } from './deviceKeys.js'
import { qrSignInRoutes } from './qrSignIn.js'
import { deskRoutes } from './desk.js'
import { connectorRoutes } from './connectors.js'
import { connectorVaultRoutes } from './connectorVault.js'
import { agentMessagesRoutes } from './agentMessages.js'
import { superTabRoutes } from './superTabs.js'
import { zooRoutes } from './zoo.js'
import { experimentalSettingsRoutes } from './experimentalSettings.js'
import { deviceAuthRoutes } from './deviceAuth.js'
import { healthRoutes, authRoutes, userRoutes, machineRoutes, planRoutes, gridRoutes, deviceRoutes, mobileRoutes, appRoutes, analyticsRoutes, productUsageRoutes, agentRouteRoutes, jevRouteRoutes, storeRoutes } from './index.js'

/**
 * Every control-API route, in the order the server registers them (server.ts, after the authentication hook). One
 * list, so what is checked against the route table — a team session's deny-by-default sweep (routes/control.test.ts)
 * — is the table production serves.
 */
export async function registerControlRoutes(app: FastifyInstance, opts: { daemons: DaemonsSwitch; count: JevRouteOptions['count'] }): Promise<void> {
  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(userRoutes)
  await app.register(machineRoutes)
  await app.register(planRoutes)
  await app.register(gridRoutes) // the account's private harness grid name
  await app.register(deviceRoutes)
  await app.register(mobileRoutes)
  await app.register(appRoutes)
  await app.register(analyticsRoutes)
  await app.register(productUsageRoutes)
  await app.register(agentRouteRoutes) // which agent a task belongs to — the prompt lives here, not in the CLI
  await app.register(jevRouteRoutes, { count: opts.count }) // ⌘B's Jev decisions on Harness's key, for people with none of their own
  await app.register(cursorRoutes)   // standalone STT + LLM for the Cursor desktop app (self-contained)
  // The cabled dial's transcription, authenticated by the caller's SSO token rather than a shared secret.
  // Absent from the auth middleware's skip-list on purpose: that absence IS the gate.
  await app.register(voiceRoutes)
  await app.register(deviceAuthRoutes) // device-authorization grant: how the desktop app gets a machine key
  await app.register(storeRoutes)      // the Harness Store's ratings and reviews; the catalogue is the CLI's registry
  await app.register(harnessShareRoutes)
  await app.register(machineShareRoutes)
  await app.register(harnessLinkRoutes)
  await app.register(communityRoutes)
  await app.register(communityEditRoutes)      // an author edits their publication in place
  await app.register(communityCommentRoutes)   // a harness page reads its earlier comments
  await app.register(communityCreatorRoutes)   // a creator's page: their name, followers and the reader's follow
  await app.register(communityReportRoutes)    // readers report a publication or comment; reviewers restore or remove it
  await app.register(communityNotificationRoutes) // a creator's bell: comments, replies and forks of their work
  await app.register(communityTranslateRoutes) // a Hub draft's words in English, for its author to review
  await app.register(qrSignInRoutes)       // sign a computer in by scanning its QR with a signed-in phone
  await app.register(deviceKeyRoutes)     // the account's device key log: signing in is what trusts a device
  await app.register(deskRoutes)          // the account's tabs, the same on every computer (lib/desk.ts)
  await app.register(connectorRoutes)     // sign-in to GitHub, Slack, Google… for local agents (lib/connectorGateway.ts)
  await app.register(connectorVaultRoutes) // those connections sealed for the account's computers, which keep them in step
  await app.register(agentMessagesRoutes)   // which tabs' harnesses may message each other (lib/agentMessages.ts)
  await app.register(superTabRoutes)
  await app.register(experimentalSettingsRoutes, { daemons: opts.daemons })
  // Availability is separate from opt-in: every account starts off, and its collection is retained.
  await app.register(zooRoutes, { daemons: opts.daemons, requireAccountOptIn: true })
}
