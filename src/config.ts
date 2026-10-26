export interface RepoConfig {
  repo: string;
  token: string;
}

export interface WayfinderSettings {
  repos: RepoConfig[];
  pollIntervalMinutes: number;
  ticketsPerRow: number;
  copyTemplate: string;
}

export const DEFAULT_SETTINGS: WayfinderSettings = {
  repos: [],
  pollIntervalMinutes: 2,
  ticketsPerRow: 15,
  copyTemplate: "/wayfinder {url}",
};

export function sanitizeSettings(value: unknown): WayfinderSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  let interval = DEFAULT_SETTINGS.pollIntervalMinutes;
  try {
    const coerced = Number(raw.pollIntervalMinutes);
    if (Number.isFinite(coerced)) interval = Math.min(120, Math.max(0.5, coerced));
  } catch {
    // Keep the default for values that cannot be converted to a number.
  }

  let repos: RepoConfig[] = [];
  if (Array.isArray(raw.repos)) {
    repos = raw.repos.flatMap((value): RepoConfig[] => {
      if (!value || typeof value !== "object") return [];
      const entry = value as Record<string, unknown>;
      if (typeof entry.repo !== "string" || typeof entry.token !== "string") return [];
      const config = { repo: entry.repo.trim(), token: entry.token.trim() };
      return config.repo || config.token ? [config] : [];
    });
  } else if (!("repos" in raw) && typeof raw.repo === "string" && typeof raw.token === "string") {
    const config = { repo: raw.repo.trim(), token: raw.token.trim() };
    if (config.repo || config.token) repos.push(config);
  }

  return {
    repos,
    pollIntervalMinutes: interval,
    ticketsPerRow: parseTicketsPerRow(raw.ticketsPerRow) ?? DEFAULT_SETTINGS.ticketsPerRow,
    copyTemplate:
      typeof raw.copyTemplate === "string" ? raw.copyTemplate : DEFAULT_SETTINGS.copyTemplate,
  };
}

/** Empty/zero disables wrapping. Reject invalid edits rather than changing the limit. */
export function parseTicketsPerRow(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function isValidRepoConfig(config: RepoConfig): boolean {
  return config.token.length > 0 && config.repo.includes("/");
}
