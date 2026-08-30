import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  GuildConfig,
  GuildSnapshot,
  IncidentRecord,
  PersistedData,
} from "../domain/types.js";
import { createDefaultGuildConfig } from "../domain/types.js";
import { logger } from "../logger.js";

const EMPTY_DATA: PersistedData = {
  version: 1,
  configs: {},
  snapshots: {},
  incidents: [],
  pendingMemberRoles: {},
};

export class JsonStore {
  readonly filePath: string;
  private data: PersistedData = structuredClone(EMPTY_DATA);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.filePath = resolve(dataDirectory, "security-state.json");
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedData>;
      if (parsed.version !== 1) {
        throw new Error(`Phiên bản dữ liệu không hỗ trợ: ${String(parsed.version)}`);
      }
      this.data = {
        version: 1,
        configs: Object.fromEntries(
          Object.entries(parsed.configs ?? {}).map(([guildId, config]) => {
            const defaults = createDefaultGuildConfig(guildId);
            return [
              guildId,
              {
                ...defaults,
                ...config,
                thresholds: { ...defaults.thresholds, ...config.thresholds },
              },
            ];
          }),
        ),
        snapshots: parsed.snapshots ?? {},
        incidents: parsed.incidents ?? [],
        pendingMemberRoles: parsed.pendingMemberRoles ?? {},
      };
      logger.info({ filePath: this.filePath }, "Đã tải dữ liệu bảo mật");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
      logger.info({ filePath: this.filePath }, "Đã tạo kho dữ liệu bảo mật mới");
    }
  }

  getConfig(guildId: string): GuildConfig {
    const existing = this.data.configs[guildId];
    if (existing) return structuredClone(existing);

    const created = createDefaultGuildConfig(guildId);
    this.data.configs[guildId] = created;
    void this.persist();
    return structuredClone(created);
  }

  async setConfig(config: GuildConfig): Promise<void> {
    config.updatedAt = new Date().toISOString();
    this.data.configs[config.guildId] = structuredClone(config);
    await this.persist();
  }

  getSnapshot(guildId: string): GuildSnapshot | undefined {
    const snapshot = this.data.snapshots[guildId];
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async setSnapshot(snapshot: GuildSnapshot): Promise<void> {
    this.data.snapshots[snapshot.guildId] = structuredClone(snapshot);
    await this.persist();
  }

  async addIncident(incident: IncidentRecord): Promise<void> {
    this.data.incidents.push(structuredClone(incident));
    if (this.data.incidents.length > 1_000) {
      this.data.incidents.splice(0, this.data.incidents.length - 1_000);
    }
    await this.persist();
  }

  getIncidents(guildId: string, limit = 10): IncidentRecord[] {
    return this.data.incidents
      .filter((incident) => incident.guildId === guildId)
      .slice(-limit)
      .reverse()
      .map((incident) => structuredClone(incident));
  }

  async setPendingMemberRoles(
    guildId: string,
    userId: string,
    roleIds: string[],
  ): Promise<void> {
    const guildPending = (this.data.pendingMemberRoles[guildId] ??= {});
    guildPending[userId] = [...roleIds];
    await this.persist();
  }

  getPendingMemberRoles(guildId: string, userId: string): string[] {
    return [...(this.data.pendingMemberRoles[guildId]?.[userId] ?? [])];
  }

  async clearPendingMemberRoles(guildId: string, userId: string): Promise<void> {
    const guildPending = this.data.pendingMemberRoles[guildId];
    if (!guildPending?.[userId]) return;
    delete guildPending[userId];
    await this.persist();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}
