import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";

const MIMI_LICENSE_SECRET = "MIMI_SHIELD_SECURE_AUTH_2026";
import { logger } from "../logger.js";

export interface LicensePlan {
  id: string;
  name: string;
  durationDays: number;
  price: number;
  priceFormatted: string;
  description: string;
}

export interface LicenseInfo {
  guildId: string;
  active: boolean;
  expired: boolean;
  plan: string | null;
  planName: string;
  activatedAt: string | null;
  expiresAt: string | null;
  expiresTimestamp: number | null;
  remainingDays: number;
  remainingHours: number;
  isPermanent: boolean;
  isOriginServer?: boolean;
  isTrial: boolean;
  warned3Days: boolean;
  warned1Day: boolean;
  history?: Array<{
    action: string;
    plan: string;
    daysAdded: number;
    timestamp: string;
    actor: string;
  }>;
}

export interface LicenseKeyObj {
  key: string;
  plan: string;
  planName: string;
  durationDays: number;
  createdAt: string;
  createdBy: string;
  note: string;
  isRedeemed: boolean;
  redeemedBy?: string | null;
  redeemedAt?: string | null;
  redeemedGuildId?: string | null;
}

export const PLANS: Record<string, LicensePlan> = {
  "1m": {
    id: "1m",
    name: "Gói 1 Tháng (Tiêu Chuẩn)",
    durationDays: 30,
    price: 50000,
    priceFormatted: "50.000đ",
    description: "Bảo vệ toàn diện Anti-Raid & Anti-Nuke cho server trong 30 ngày.",
  },
  "3m": {
    id: "3m",
    name: "Gói 3 Tháng (Tiết Kiệm)",
    durationDays: 90,
    price: 140000,
    priceFormatted: "140.000đ",
    description: "Tiết kiệm 10.000đ, bảo vệ liên tục 90 ngày kèm hỗ trợ ưu tiên.",
  },
  "12m": {
    id: "12m",
    name: "Gói 12 Tháng (VIP Trọn Gói)",
    durationDays: 365,
    price: 390000,
    priceFormatted: "390.000đ",
    description: "Tiết kiệm 210.000đ (Chỉ ~32k/tháng), full tính năng Anti-Raid cao cấp + hỗ trợ 24/7.",
  },
  trial: {
    id: "trial",
    name: "Dùng Thử (Trial 24h)",
    durationDays: 1,
    price: 0,
    priceFormatted: "Miễn phí",
    description: "Thời gian trải nghiệm 24h khi bot mới tham gia server.",
  },
  permanent: {
    id: "permanent",
    name: "Vĩnh Viễn (Lifetime VIP)",
    durationDays: 36500,
    price: 0,
    priceFormatted: "Đặc cách",
    description: "Bản quyền vĩnh viễn cho máy chủ của Creator / Owner.",
  },
};

const HOME_GUILD_IDS = ["1517068246493429852"];

export class LicenseService {
  private readonly dataDir: string;
  private readonly licensesFile: string;
  private readonly keysFile: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.licensesFile = join(dataDir, "licenses.json");
    this.keysFile = join(dataDir, "license_keys.json");

    if (!existsSync(this.dataDir)) {
      try {
        mkdirSync(this.dataDir, { recursive: true });
      } catch {}
    }
  }

  private readJson<T>(file: string, defaultVal: T): T {
    try {
      if (!existsSync(file)) return defaultVal;
      const raw = readFileSync(file, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return defaultVal;
    }
  }

  private writeJson(file: string, data: unknown): boolean {
    try {
      writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
      return true;
    } catch (e) {
      logger.error({ file, error: e }, "Lỗi ghi file JSON license");
      return false;
    }
  }

  public getLicense(guildId: string): LicenseInfo {
    if (!guildId) {
      return {
        guildId: "",
        active: false,
        expired: true,
        plan: null,
        planName: "Chưa kích hoạt",
        activatedAt: null,
        expiresAt: null,
        expiresTimestamp: null,
        remainingDays: 0,
        remainingHours: 0,
        isPermanent: false,
        isTrial: false,
        warned3Days: false,
        warned1Day: false,
      };
    }

    // Máy chủ gốc Support MIMI BOT luôn là VIP Vĩnh Viễn
    if (HOME_GUILD_IDS.includes(guildId)) {
      return {
        guildId,
        active: true,
        expired: false,
        plan: "permanent",
        planName: "💎 Server Gốc (Support MIMI BOT - Vĩnh Viễn)",
        activatedAt: "ORIGIN_SERVER",
        expiresAt: "Vĩnh viễn",
        expiresTimestamp: null,
        remainingDays: 99999,
        remainingHours: 999999,
        isPermanent: true,
        isOriginServer: true,
        isTrial: false,
        warned3Days: false,
        warned1Day: false,
      };
    }

    const licenses = this.readJson<Record<string, any>>(this.licensesFile, {});
    const entry = licenses[guildId];

    if (!entry) {
      return {
        guildId,
        active: false,
        expired: true,
        plan: null,
        planName: "Chưa kích hoạt",
        activatedAt: null,
        expiresAt: null,
        expiresTimestamp: null,
        remainingDays: 0,
        remainingHours: 0,
        isPermanent: false,
        isTrial: false,
        warned3Days: false,
        warned1Day: false,
      };
    }

    const now = Date.now();
    const isPermanent = entry.plan === "permanent" || entry.expiresAt === "PERMANENT";
    const expiresAt = isPermanent ? null : Number(entry.expiresAt);
    const active = isPermanent ? true : (expiresAt ? expiresAt > now : false);
    const remainingMs = isPermanent ? Infinity : Math.max(0, (expiresAt || 0) - now);
    const remainingDays = isPermanent ? 9999 : Math.floor(remainingMs / (24 * 60 * 60 * 1000));
    const remainingHours = isPermanent ? 9999 : Math.floor(remainingMs / (60 * 60 * 1000));

    return {
      guildId,
      active,
      expired: !active,
      plan: entry.plan || "1m",
      planName: PLANS[entry.plan]?.name || "Gói tùy chỉnh",
      activatedAt: entry.activatedAt || null,
      expiresAt: isPermanent ? "Vĩnh viễn" : (expiresAt ? new Date(expiresAt).toISOString() : null),
      expiresTimestamp: expiresAt,
      remainingDays,
      remainingHours,
      isPermanent,
      isTrial: entry.plan === "trial",
      history: entry.history || [],
      warned3Days: !!entry.warned3Days,
      warned1Day: !!entry.warned1Day,
    };
  }

  public grantLicense(
    guildId: string,
    planType = "1m",
    customDays: number | null = null,
    grantedBy = "System"
  ): LicenseInfo {
    const plan = PLANS[planType] || PLANS["1m"]!;
    const addDays = customDays || plan.durationDays;
    const now = Date.now();
    const current = this.getLicense(guildId);

    const licenses = this.readJson<Record<string, any>>(this.licensesFile, {});
    let baseTime = now;

    if (current.active && current.expiresTimestamp && current.expiresTimestamp > now) {
      baseTime = current.expiresTimestamp;
    }

    let newExpiresAt: number | string = baseTime + addDays * 24 * 60 * 60 * 1000;
    if (planType === "permanent") {
      newExpiresAt = "PERMANENT";
    }

    const historyEntry = {
      action: "GRANT",
      plan: planType,
      daysAdded: addDays,
      timestamp: new Date().toISOString(),
      actor: grantedBy,
    };

    licenses[guildId] = {
      guildId,
      plan: planType,
      activatedAt: current.activatedAt || new Date().toISOString(),
      expiresAt: newExpiresAt,
      updatedAt: new Date().toISOString(),
      warned3Days: false,
      warned1Day: false,
      history: [...(current.history || []), historyEntry],
    };

    this.writeJson(this.licensesFile, licenses);
    logger.info(
      { guildId, plan: planType, daysAdded: addDays, grantedBy },
      "Đã cấp/gia hạn bản quyền server thành công"
    );
    return this.getLicense(guildId);
  }

  public generateKey(planType = "1m", note = "", createdBy = "Admin"): LicenseKeyObj {
    let planNorm = String(planType || "1m").toUpperCase();
    if (planNorm === "PERMANENT" || planNorm === "PERM") planNorm = "PERM";
    if (!["1M", "3M", "12M", "PERM"].includes(planNorm)) planNorm = "1M";

    const entropy = randomBytes(3).toString("hex").toUpperCase();
    const checksum = createHmac("sha256", MIMI_LICENSE_SECRET)
      .update(`${planNorm}:${entropy}`)
      .digest("hex")
      .slice(0, 4)
      .toUpperCase();

    const key = `MIMI-SHIELD-${planNorm}-${entropy}-${checksum}`;

    let durationDays = 30;
    let planName = "Gói 1 Tháng (30 ngày)";
    if (planNorm === "3M") { durationDays = 90; planName = "Gói 3 Tháng (90 ngày)"; }
    else if (planNorm === "12M") { durationDays = 365; planName = "Gói 12 Tháng (365 ngày)"; }
    else if (planNorm === "PERM") { durationDays = 36500; planName = "Gói Vĩnh Viễn (Lifetime VIP)"; }

    const keys = this.readJson<Record<string, LicenseKeyObj>>(this.keysFile, {});
    const keyObj: LicenseKeyObj = {
      key,
      plan: planNorm.toLowerCase(),
      planName,
      durationDays,
      createdAt: new Date().toISOString(),
      createdBy,
      note,
      isRedeemed: false,
      redeemedBy: null,
      redeemedAt: null,
      redeemedGuildId: null,
    };

    keys[key] = keyObj;
    this.writeJson(this.keysFile, keys);
    logger.info({ key, plan: planNorm, createdBy }, "Đã tạo License Key HMAC mới");
    return keyObj;
  }

  public generateKeys(planType = "1m", count = 1, note = "", createdBy = "Admin"): LicenseKeyObj[] {
    const list: LicenseKeyObj[] = [];
    for (let i = 0; i < count; i++) {
      list.push(this.generateKey(planType, note, createdBy));
    }
    return list;
  }

  public redeemKey(
    guildId: string,
    rawKey: string,
    redeemedBy = "User"
  ): { ok: boolean; error?: string; license?: LicenseInfo; daysAdded?: number; planName?: string } {
    if (!guildId || !rawKey) {
      return { ok: false, error: "Thiếu Server ID hoặc mã Key." };
    }

    const key = rawKey.trim().toUpperCase();

    // 1. Kiểm tra Signed Key HMAC MIMI-SHIELD-{PLAN}-{ENTROPY}-{CHECKSUM}
    const match = key.match(/^MIMI-SHIELD-(1M|3M|12M|PERM)-([0-9A-F]{4,8})-([0-9A-F]{4})$/);
    if (match) {
      const [, planCode, entropy, checksum] = match;
      const expectedChecksum = createHmac("sha256", MIMI_LICENSE_SECRET)
        .update(`${planCode}:${entropy}`)
        .digest("hex")
        .slice(0, 4)
        .toUpperCase();

      if (checksum === expectedChecksum) {
        const keys = this.readJson<Record<string, LicenseKeyObj>>(this.keysFile, {});
        if (keys[key]?.isRedeemed) {
          return {
            ok: false,
            error: `Mã Key này đã được sử dụng cho Server ${keys[key].redeemedGuildId || "khác"} lúc ${keys[key].redeemedAt}.`,
          };
        }

        let planType = "1m";
        let durationDays = 30;
        let planName = "Gói 1 Tháng (30 ngày)";
        if (planCode === "3M") { planType = "3m"; durationDays = 90; planName = "Gói 3 Tháng (90 ngày)"; }
        else if (planCode === "12M") { planType = "12m"; durationDays = 365; planName = "Gói 12 Tháng (365 ngày)"; }
        else if (planCode === "PERM") { planType = "permanent"; durationDays = 36500; planName = "Gói Vĩnh Viễn (Lifetime VIP)"; }

        keys[key] = {
          key,
          plan: planType,
          planName,
          durationDays,
          createdAt: new Date().toISOString(),
          createdBy: "Signature Auth",
          note: `Redeemed by ${redeemedBy}`,
          isRedeemed: true,
          redeemedBy,
          redeemedAt: new Date().toISOString(),
          redeemedGuildId: guildId,
        };
        this.writeJson(this.keysFile, keys);

        const updatedLic = this.grantLicense(
          guildId,
          planType,
          durationDays,
          `Redeemed Signed Key: ${key} by ${redeemedBy}`
        );

        return {
          ok: true,
          license: updatedLic,
          daysAdded: durationDays,
          planName,
        };
      }
    }

    // 2. Kiểm tra Local keysFile nếu là legacy key
    const keys = this.readJson<Record<string, LicenseKeyObj>>(this.keysFile, {});
    const keyObj = keys[key];

    if (!keyObj) {
      return { ok: false, error: "Mã License Key không tồn tại hoặc sai cú pháp." };
    }

    if (keyObj.isRedeemed) {
      return {
        ok: false,
        error: `Mã Key này đã được sử dụng cho Server ${keyObj.redeemedGuildId || "khác"} lúc ${keyObj.redeemedAt}.`,
      };
    }

    keyObj.isRedeemed = true;
    keyObj.redeemedBy = redeemedBy;
    keyObj.redeemedAt = new Date().toISOString();
    keyObj.redeemedGuildId = guildId;
    this.writeJson(this.keysFile, keys);

    const updatedLic = this.grantLicense(
      guildId,
      keyObj.plan,
      keyObj.durationDays,
      `Redeemed Key: ${key} by ${redeemedBy}`
    );

    return {
      ok: true,
      license: updatedLic,
      daysAdded: keyObj.durationDays,
      planName: keyObj.planName,
    };
  }

  public markWarning(guildId: string, type: "3days" | "1day"): void {
    const licenses = this.readJson<Record<string, any>>(this.licensesFile, {});
    if (!licenses[guildId]) return;
    if (type === "3days") licenses[guildId].warned3Days = true;
    if (type === "1day") licenses[guildId].warned1Day = true;
    this.writeJson(this.licensesFile, licenses);
  }
}
