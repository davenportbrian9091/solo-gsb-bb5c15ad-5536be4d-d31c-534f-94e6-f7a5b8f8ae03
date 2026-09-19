import { promises as fs } from 'fs';
import path from 'path';
import type { HitException, JobState } from './types';

/**
 * 兼容旧版本任务文件，规整为当前 JobState：
 * - 旧版 revertedKeys（逐条撤销 key 列表）迁移为 state=reverted 的逐条例外；
 * - 缺少的实体决定 / 例外 / 化名表字段补空数组。
 */
export function migrateJobState(
  parsed: Partial<JobState> & { revertedKeys?: unknown },
): JobState {
  let hitExceptions: HitException[] = [];
  if (Array.isArray(parsed.hitExceptions)) {
    hitExceptions = parsed.hitExceptions.filter(
      (e): e is HitException =>
        !!e &&
        typeof e.key === 'string' &&
        (e.state === 'applied' || e.state === 'reverted'),
    );
  } else if (Array.isArray(parsed.revertedKeys)) {
    hitExceptions = parsed.revertedKeys
      .filter((k): k is string => typeof k === 'string')
      .map((key) => ({ key, state: 'reverted' as const }));
  }
  return {
    jobId: typeof parsed.jobId === 'string' ? parsed.jobId : '',
    vtt: typeof parsed.vtt === 'string' ? parsed.vtt : '',
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    hitExceptions,
    entityDecisions: Array.isArray(parsed.entityDecisions)
      ? parsed.entityDecisions
      : [],
    aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  };
}

/**
 * 单机文件持久化：整个任务序列化为 data/job.json，原子替换写入。
 * 服务重启 / 浏览器刷新后均可恢复。
 */
export class JobStore {
  private filePath: string;
  private cache: JobState | null = null;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'job.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      // 兼容旧版本任务文件（含 revertedKeys 时代）
      this.cache = migrateJobState(JSON.parse(raw));
    } catch {
      this.cache = null;
    }
  }

  get(): JobState | null {
    return this.cache;
  }

  /** 合并式保存（防抖 + 原子写） */
  save(state: JobState): void {
    this.cache = { ...state, updatedAt: new Date().toISOString() };
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      const tmp = this.filePath + '.tmp';
      fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf8')
        .then(() => fs.rename(tmp, this.filePath))
        .catch((e) => console.error('[store] 写入失败:', e));
    }, 300);
  }

  async flush(): Promise<void> {
    if (!this.cache) return;
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}
