import { env } from '../config/env.js'

export const autonomousEnvironments = ['prod', 'stag'] as const
export type AutonomousEnvironment = typeof autonomousEnvironments[number]

export function isAutonomousEnvironment(value: unknown): value is AutonomousEnvironment {
  return value === 'prod' || value === 'stag'
}

/** Missing values are production for backward-compatible clients; malformed explicit values fail. */
export function parseAutonomousEnvironment(
  value: unknown,
  fallback: AutonomousEnvironment = 'prod',
): AutonomousEnvironment {
  if (value == null || value === '') return fallback
  if (isAutonomousEnvironment(value)) return value
  throw new Error('INVALID_AUTONOMOUS_ENV')
}

/** Reads a persisted row safely during rolling migration, before the worker has stamped it. */
export function storedAutonomousEnvironment(value: unknown): AutonomousEnvironment {
  return isAutonomousEnvironment(value) ? value : 'stag'
}

export interface AutonomousEnvironmentConfig {
  name: AutonomousEnvironment
  ssoIssuer: string
  ssoClientId: string
  ssoClientSecret?: string
  ssoProfileUrl: string
  /** An explicit identity URL ('' = off). Left raw on purpose: this object is built for every upstream
   *  call, billing included, and must not do SSO work — see `ssoIdentityUrlFor`. */
  ssoIdentityUrlOverride?: string
  bffUrl: string
  checkoutOrigin: string
  campaignApiUrl: string
  campaignApiKey?: string
}

/**
 * Where a token is proved without the profile read behind it.
 *
 * Derived rather than defaulted: only a stock `…/me/profile` URL has an `…/me/identity` sibling. A rig
 * that points the profile URL at a local stand-in must not start validating its fake tokens against
 * production because a second URL defaulted there.
 */
export function ssoIdentityUrlFor(profileUrl: string, explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit || undefined
  return profileUrl.endsWith('/me/profile') ? `${profileUrl.slice(0, -'/profile'.length)}/identity` : undefined
}

/** Single source of truth for upstream account-plane routing. */
export function autonomousEnvironmentConfig(name: AutonomousEnvironment): AutonomousEnvironmentConfig {
  if (name === 'stag') {
    return {
      name,
      ssoIssuer: env.STAGING_SSO_ISSUER,
      ssoClientId: env.STAGING_SSO_CLIENT_ID || env.SSO_CLIENT_ID,
      ssoClientSecret: env.STAGING_SSO_CLIENT_SECRET || env.SSO_CLIENT_SECRET,
      ssoProfileUrl: env.STAGING_SSO_PROFILE_URL,
      ssoIdentityUrlOverride: env.STAGING_SSO_IDENTITY_URL,
      bffUrl: env.STAGING_AUTONOMOUS_BFF_URL,
      checkoutOrigin: env.STAGING_AUTONOMOUS_CHECKOUT_ORIGIN,
      campaignApiUrl: env.STAGING_AUTONOMOUS_CAMPAIGN_API_URL,
      campaignApiKey: env.STAGING_AUTONOMOUS_CAMPAIGN_API_KEY || undefined,
    }
  }
  return {
    name,
    ssoIssuer: env.SSO_ISSUER,
    ssoClientId: env.SSO_CLIENT_ID,
    ssoClientSecret: env.SSO_CLIENT_SECRET,
    ssoProfileUrl: env.SSO_PROFILE_URL,
    ssoIdentityUrlOverride: env.SSO_IDENTITY_URL,
    bffUrl: env.AUTONOMOUS_BFF_URL,
    checkoutOrigin: env.AUTONOMOUS_CHECKOUT_ORIGIN,
    campaignApiUrl: env.AUTONOMOUS_CAMPAIGN_API_URL,
    campaignApiKey: env.AUTONOMOUS_CAMPAIGN_API_KEY || undefined,
  }
}
