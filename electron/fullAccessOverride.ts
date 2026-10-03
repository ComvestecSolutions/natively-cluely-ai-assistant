/**
 * Master access override.
 *
 * Set `FULL_ACCESS` to `true` to unlock every paywalled feature in the app
 * without a real license. When `true`:
 *
 *   - `isProOrTrialActive()` in ipcHandlers.ts short-circuits to `true`, so
 *     every server-side `pro_required` gate opens (all `modes:*` handlers,
 *     Profile Intelligence, OKF Knowledge, Role Insight, company research, …).
 *   - The three renderer-facing license IPCs (`license:check-premium`,
 *     `license:get-details`, `license:check-premium-async`) report the user as
 *     premium, so every UI check (`isPremiumActive`, `hasProfileAccess`, the
 *     `PremiumUpgradeModal`, `ModesProGate`, `ProfileIntelligenceProGate`, …)
 *     lights up as if a paid license were installed.
 *
 * Leave at `false` for normal, gated behavior.
 *
 * Cross-platform note: this is a plain TypeScript constant read the same way
 * on macOS and Windows — no platform-specific paths, native modules, or
 * packaging concerns.
 */
export const FULL_ACCESS = true;

/**
 * Shape returned by `license:get-details` when `FULL_ACCESS` is on. Matches
 * the real `LicenseManager.getLicenseDetails()` contract so every renderer
 * consumer (App.tsx `planDetails`, ProfileIntelligenceSettings' premium cache,
 * ad targeting, etc.) sees a well-formed premium session.
 */
export const FULL_ACCESS_LICENSE_DETAILS = {
    isPremium: true,
    plan: 'pro',
    provider: 'full_access_override',
} as const;
