import type {
  AliasEntry,
  AuditReport,
  EntityDecision,
  ExportResult,
  HitException,
  JobState,
  MaskRule,
  Preset,
  PreviewResult,
} from './types';

/** 预览 / 保存 / 导出共用的任务载荷（三者必须使用同一份状态） */
export interface JobPayload {
  vtt: string;
  rules: MaskRule[];
  hitExceptions: HitException[];
  entityDecisions: EntityDecision[];
  aliases: AliasEntry[];
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  presets: () => req<{ presets: Preset[] }>('/api/presets'),
  getJob: () => req<{ job: JobState | null }>('/api/job'),
  saveJob: (payload: JobPayload) =>
    req<{ job: JobState }>('/api/job', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  preview: (payload: JobPayload) =>
    req<PreviewResult>('/api/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  export: (payload: JobPayload) =>
    req<ExportResult>('/api/export', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

export type { AliasEntry, AuditReport };
