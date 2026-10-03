// Courses Studio settings resolution — P1 (COURSES_FEATURE_PLAN §8 C1, locked defaults).

export interface CoursesStudioSettings {
  maxPagesPerCourse: number; // default 2000, hard ceiling 5000 (§6 decision 6)
  maxAssetMB: number; // soft per-run stop, locked 2048 MB
  concurrency: number; // politeness (R-A5 caps at 4), locked 4
  delayMs: number; // polite gap between fetch starts, locked 700
  respectRobots: boolean; // default ON (C1)
  aiAssistMode: "auto" | "on" | "off"; // auto = heuristics first, model-assisted profiling later
  autoGroundingEnabled: boolean; // per-turn auto-grounding (R-D6), default ON
}

const HARD_CAP_MAX_PAGES = 5000;

const DEFAULTS: CoursesStudioSettings = {
  maxPagesPerCourse: 2000,
  maxAssetMB: 2048,
  concurrency: 4,
  delayMs: 700,
  respectRobots: true,
  aiAssistMode: "auto",
  autoGroundingEnabled: true,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge a partial (persisted or UI-provided) settings object over the locked defaults. */
export function resolveCoursesStudioSettings(
  partial?: Partial<CoursesStudioSettings> | undefined,
): CoursesStudioSettings {
  const p = partial ?? {};
  return {
    maxPagesPerCourse: clampInt(p.maxPagesPerCourse, DEFAULTS.maxPagesPerCourse, 1, HARD_CAP_MAX_PAGES),
    maxAssetMB: clampInt(p.maxAssetMB, DEFAULTS.maxAssetMB, 1, Number.MAX_SAFE_INTEGER),
    concurrency: clampInt(p.concurrency, DEFAULTS.concurrency, 1, 4),
    delayMs: clampInt(p.delayMs, DEFAULTS.delayMs, 0, 3_600_000),
    respectRobots: p.respectRobots ?? DEFAULTS.respectRobots,
    aiAssistMode:
      p.aiAssistMode === "on" || p.aiAssistMode === "off" ? p.aiAssistMode : DEFAULTS.aiAssistMode,
    autoGroundingEnabled: p.autoGroundingEnabled ?? DEFAULTS.autoGroundingEnabled,
  };
}
