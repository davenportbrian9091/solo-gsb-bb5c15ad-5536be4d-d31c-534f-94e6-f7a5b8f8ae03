import type { EntityDecision, Hit, HitException, MaskRule } from './types';

export function uid(prefix = 'rule'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 兼容旧版本规则：补齐稳定化名所需字段 */
export function normalizeRule(rule: MaskRule): MaskRule {
  return {
    ...rule,
    mode: rule.mode === 'alias' ? 'alias' : 'template',
    aliasPrefix: typeof rule.aliasPrefix === 'string' ? rule.aliasPrefix : '',
  };
}

/** 校验正则源码与标志，返回错误文案或 null */
export function validateRegex(pattern: string, flags: string): string | null {
  if (!pattern) return '正则不能为空';
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ---------------- 逐条例外 / 实体决定 ---------------- */

export type FinalState = 'applied' | 'reverted';

/**
 * 命中在不考虑逐条例外时的继承状态：
 * 有实体决定则按决定（keep → 保留原文），否则默认应用。
 */
export function inheritedState(
  hit: Pick<Hit, 'ruleId' | 'entityKey'>,
  decisions: EntityDecision[],
): FinalState {
  const d = decisions.find(
    (x) => x.ruleId === hit.ruleId && x.entityKey === hit.entityKey,
  );
  if (!d) return 'applied';
  return d.action === 'keep' ? 'reverted' : 'applied';
}

/**
 * 把一组命中写向目标状态：
 * - 目标与继承状态不同 → 写入显式例外（优先于实体决定）；
 * - 目标与继承状态相同 → 清除已有例外（恢复继承，不产生冗余例外）。
 */
export function withExceptionTarget(
  exceptions: HitException[],
  entries: { key: string; inherited: FinalState }[],
  target: FinalState,
): HitException[] {
  const map = new Map<string, FinalState>(exceptions.map((e) => [e.key, e.state]));
  for (const { key, inherited } of entries) {
    if (target === inherited) map.delete(key);
    else map.set(key, target);
  }
  return Array.from(map, ([key, state]) => ({ key, state }));
}
