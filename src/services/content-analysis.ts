const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const COMBINING_MARKS = /\p{M}/gu;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()]+/giu;

const HOMOGLYPHS: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ј: "j",
  Α: "a",
  Β: "b",
  Ε: "e",
  Ζ: "z",
  Η: "h",
  Ι: "i",
  Κ: "k",
  Μ: "m",
  Ν: "n",
  Ο: "o",
  Ρ: "p",
  Τ: "t",
  Χ: "x",
};

const TRUSTED_HOSTS = [
  "discord.com",
  "discord.gg",
  "discordapp.com",
  "support.discord.com",
  "steamcommunity.com",
  "store.steampowered.com",
];

const LURE_TERMS = [
  "free nitro",
  "nitro free",
  "discord gift",
  "claim gift",
  "steam gift",
  "verify account",
  "verify your account",
  "mien phi nitro",
  "nhan nitro",
  "xac minh tai khoan",
];

export interface ContentAssessment {
  normalized: string;
  fingerprint: string;
  domains: string[];
  suspiciousLink: boolean;
  hasMassMention: boolean;
}

export function normalizeContent(input: string): string {
  const compatible = input.normalize("NFKD").replace(ZERO_WIDTH, "").replace(COMBINING_MARKS, "");
  return [...compatible]
    .map((character) => HOMOGLYPHS[character] ?? character)
    .join("")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " [url] ")
    .replace(/<@!?\d+>/g, " [user] ")
    .replace(/<@&\d+>/g, " [role] ")
    .replace(/[^\p{L}\p{N}\[\]@.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function assessContent(input: string): ContentAssessment {
  const normalized = normalizeContent(input);
  const domains = extractDomains(input);
  const hasLure = LURE_TERMS.some((term) => normalized.includes(term));
  const impersonatesKnownBrand = domains.some(
    (domain) =>
      !isTrustedHost(domain) &&
      (domain.includes("discord") || domain.includes("nitro") || domain.includes("steamcommunity")),
  );
  const rawIpLink = domains.some((domain) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain));
  const hasUntrustedHost = domains.some((domain) => !isTrustedHost(domain));
  return {
    normalized,
    fingerprint: normalized.slice(0, 500),
    domains,
    suspiciousLink: domains.length > 0 && ((hasLure && hasUntrustedHost) || impersonatesKnownBrand || rawIpLink),
    hasMassMention: /@(everyone|here)/i.test(input),
  };
}

function extractDomains(input: string): string[] {
  const matches = input.match(URL_PATTERN) ?? [];
  const domains = new Set<string>();
  for (const match of matches) {
    try {
      const url = new URL(match.startsWith("www.") ? `https://${match}` : match);
      domains.add(url.hostname.toLowerCase().replace(/\.$/, ""));
    } catch {
      // Invalid URLs are ignored; Discord itself does not turn them into clickable links.
    }
  }
  return [...domains];
}

function isTrustedHost(hostname: string): boolean {
  return TRUSTED_HOSTS.some((trusted) => hostname === trusted || hostname.endsWith(`.${trusted}`));
}
