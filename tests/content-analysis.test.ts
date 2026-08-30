import { describe, expect, it } from "vitest";
import { assessContent, normalizeContent } from "../src/services/content-analysis.js";

describe("normalizeContent", () => {
  it("removes zero-width characters and normalizes compatibility forms", () => {
    expect(normalizeContent("ＦＲＥＥ\u200B NITRO!!!")).toBe("free nitro");
  });

  it("normalizes selected Cyrillic homoglyphs", () => {
    expect(normalizeContent("discоrd gift")).toBe("discord gift");
  });
});

describe("assessContent", () => {
  it("flags a Discord lookalike gift link", () => {
    const result = assessContent("Free Nitro https://discord-gifts.example/claim");
    expect(result.suspiciousLink).toBe(true);
  });

  it("does not flag official Discord links", () => {
    const result = assessContent("Discord gift details https://support.discord.com/article");
    expect(result.suspiciousLink).toBe(false);
  });

  it("recognizes mass mentions", () => {
    expect(assessContent("@everyone read this").hasMassMention).toBe(true);
  });
});
