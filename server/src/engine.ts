import { createHash } from 'crypto';
import { parseVtt, serializeVtt } from './vtt';
import type {
  AliasEntry,
  AuditRecord,
  AuditReport,
  CueHit,
  DecisionSource,
  EntityDecision,
  EntitySummary,
  ExportResult,
  Hit,
  HitException,
  MaskRule,
  PreviewResult,
  SafetyScanIssue,
  SafetyScanKind,
  SafetyScanSegment,
  SafetyScanSummary,
  SuppressedHit,
} from './types';

/* ------------------------------------------------------------------ */
/* 规则兼容与编译                                                       */
/* ------------------------------------------------------------------ */

/** 兼容旧版本规则：补齐 mode / aliasPrefix，并规整非法值 */
export function normalizeRule(rule: MaskRule): MaskRule {
  return {
    ...rule,
    mode: rule.mode === 'alias' ? 'alias' : 'template',
    aliasPrefix: typeof rule.aliasPrefix === 'string' ? rule.aliasPrefix : '',
  };
}

/** 化名模式缺省前缀（用户未填前缀时使用） */
export const DEFAULT_ALIAS_PREFIX = '化名';

export function aliasPrefixOf(rule: MaskRule): string {
  return rule.aliasPrefix.trim() || DEFAULT_ALIAS_PREFIX;
}

/** 自动化名：前缀 + 规则内稳定序号 */
export function autoAliasFor(prefix: string, seq: number): string {
  return `${prefix}${seq}`;
}

/**
 * 实体键规范化：Unicode NFKC 归一化（全角/兼容字符收敛）后去首尾空白。
 * 同一实体跨 cue、跨全半角写法均收敛到同一键。
 */
export function normalizeEntity(raw: string): string {
  return raw.normalize('NFKC').trim();
}

export function aliasMapKey(ruleId: string, entityKey: string): string {
  return `${ruleId} ${entityKey}`;
}

/** 实体决定的索引键：规则 id + 实体键（与化名表同构） */
export function entityDecisionKey(ruleId: string, entityKey: string): string {
  return `${ruleId} ${entityKey}`;
}

export interface CompiledRule {
  rule: MaskRule;
  regex: RegExp;
}

export function compileRules(rules: MaskRule[]): {
  compiled: CompiledRule[];
  errors: { ruleId: string; message: string }[];
} {
  const compiled: CompiledRule[] = [];
  const errors: { ruleId: string; message: string }[] = [];
  for (const rawRule of rules) {
    const rule = normalizeRule(rawRule);
    if (!rule.enabled) continue;
    if (!rule.pattern) continue;
    try {
      // 去重并限制标志：g 必须有（遍历全部命中），剔除不支持的标志
      const flagSet = new Set((rule.flags || '').split('').filter(Boolean));
      flagSet.add('g');
      flagSet.delete('y');
      flagSet.delete('d');
      const regex = new RegExp(rule.pattern, Array.from(flagSet).join(''));
      compiled.push({ rule, regex });
    } catch (e) {
      errors.push({ ruleId: rule.id, message: (e as Error).message });
    }
  }
  return { compiled, errors };
}

/* ------------------------------------------------------------------ */
/* payload <-> 纯文本 映射（剥离内联时间戳等标签）                       */
/* ------------------------------------------------------------------ */

const TAG_RE = /<[^>]+>/g;

/**
 * 返回去标签纯文本与逐字符映射：
 * map[i] 表示纯文本第 i 个字符在原 payload 中的下标。
 * 标签包围的命中在替换时会整体覆盖对应标签区间。
 */
export function plainText(payload: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let i = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = TAG_RE.exec(payload)) !== null) {
    for (; i < m.index; i++) {
      text += payload[i];
      map.push(i);
    }
    i = m.index + m[0].length;
    last = TAG_RE.lastIndex;
  }
  for (; i < payload.length; i++) {
    text += payload[i];
    map.push(i);
  }
  void last;
  return { text, map };
}

/* ------------------------------------------------------------------ */
/* 替换模板                                                            */
/* ------------------------------------------------------------------ */

function maskChar(ch: string): string {
  return /\s/.test(ch) ? ch : '*';
}

/**
 * 扩展内置占位符，再交给 JS 标准替换语义（$&/$1/$<name>）。
 *  - $KEEP:n   保留命中前 n 个字符，其余打码
 *  - $MASK:n   仅前 n 个字符打码
 *  - $MASKALL  整体打码（空白保留）
 *  - $RULE     替换为规则名
 */
export function expandReplacement(
  template: string,
  matched: string,
  ruleName: string,
): string {
  let t = template;
  t = t.replace(/\$MASKALL/g, () => matched.split('').map(maskChar).join(''));
  t = t.replace(/\$KEEP:(\d+)/g, (_s, n: string) => {
    const k = Math.min(Number(n), matched.length);
    return matched.slice(0, k) + matched.slice(k).split('').map(maskChar).join('');
  });
  t = t.replace(/\$MASK:(\d+)/g, (_s, n: string) => {
    const k = Math.min(Number(n), matched.length);
    return matched.slice(0, k).split('').map(maskChar).join('') + matched.slice(k);
  });
  t = t.replace(/\$RULE/g, ruleName);
  return t;
}

function applyTemplate(
  template: string,
  matched: string,
  ruleName: string,
  match: RegExpMatchArray | RegExpExecArray,
): string {
  const expanded = expandReplacement(template, matched, ruleName);
  // 标准 $& / $1.. / $<name> 语义
  return expanded.replace(/\$(\d+|&|`|'|<[^>]+>)/g, (tok) => {
    if (tok === '$&') return matched;
    if (tok === '$`' || tok === "$'") return '';
    if (tok.startsWith('$<')) {
      const name = tok.slice(2, -1);
      return (match.groups?.[name] ?? '') as string;
    }
    const g = match[Number(tok.slice(1))];
    return g ?? '';
  });
}

/* ------------------------------------------------------------------ */
/* 命中合并（优先级 + 最长重叠吞并）                                    */
/* ------------------------------------------------------------------ */

interface RawHit {
  ruleId: string;
  ruleName: string;
  priority: number;
  start: number;
  end: number; // 不含
  match: string;
  replacement: string;
  /** 实体键（NFKC + trim）：所有规则都计算，供实体决策与稳定化名使用 */
  entityKey: string;
}

function hitKey(cueIndex: number, start: string, h: RawHit): string {
  return `${cueIndex}:${start}:${h.start}-${h.end}:${h.ruleId}`;
}

/** 按优先级降序、长度降序、规则名排序，贪心选择互不重叠的命中 */
function mergeHits(raw: RawHit[]): { kept: RawHit[]; suppressed: SuppressedHit[] } {
  const ordered = [...raw].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return a.ruleName.localeCompare(b.ruleName);
  });
  const kept: RawHit[] = [];
  const suppressed: SuppressedHit[] = [];
  for (const h of ordered) {
    const winner = kept.find((k) => h.start < k.end && k.start < h.end);
    if (winner) {
      suppressed.push({
        ruleId: h.ruleId,
        ruleName: h.ruleName,
        priority: h.priority,
        start: h.start,
        end: h.end - 1,
        match: h.match,
        reason: 'overlap',
        winnerRuleId: winner.ruleId,
        winnerRuleName: winner.ruleName,
        entityKey: h.entityKey,
      });
    } else {
      kept.push(h);
    }
  }
  kept.sort((a, b) => a.start - b.start);
  return { kept, suppressed };
}

/* ------------------------------------------------------------------ */
/* 预览                                                                */
/* ------------------------------------------------------------------ */

export function buildPreview(input: {
  vtt: string;
  rules: MaskRule[];
  revertedKeys?: string[];
  hitExceptions?: HitException[];
  entityDecisions?: EntityDecision[];
  aliases?: AliasEntry[];
}): PreviewResult {
  const parsed = parseVtt(input.vtt);
  const normalizedRules = input.rules.map(normalizeRule);
  const { compiled, errors } = compileRules(normalizedRules);
  for (const e of errors) parsed.errors.push(`规则 ${e.ruleId} 正则无效：${e.message}`);

  const ruleById = new Map(normalizedRules.map((r) => [r.id, r]));

  /* ---------- 逐条例外：旧版 revertedKeys 兼容并入，显式例外优先 ---------- */
  const exceptions = new Map<string, 'applied' | 'reverted'>();
  for (const k of input.revertedKeys ?? []) exceptions.set(k, 'reverted');
  for (const e of input.hitExceptions ?? []) exceptions.set(e.key, e.state);

  /* ---------- 实体决定：规则 + 实体键 → 始终应用 / 始终保留 ---------- */
  const decisions = new Map<string, EntityDecision>();
  for (const d of input.entityDecisions ?? []) {
    decisions.set(entityDecisionKey(d.ruleId, d.entityKey), d);
  }

  /* ---------- 化名状态：载入已持久映射，序号只增不复用 ---------- */
  const aliases: AliasEntry[] = (input.aliases ?? []).map((a) => ({ ...a }));
  const aliasByKey = new Map<string, AliasEntry>();
  const seqByRule = new Map<string, number>();
  for (const a of aliases) {
    aliasByKey.set(aliasMapKey(a.ruleId, a.entityKey), a);
    seqByRule.set(a.ruleId, Math.max(seqByRule.get(a.ruleId) ?? 0, a.seq));
  }

  /* ---------- 第一遍：扫描 + 优先级合并（暂不解析化名） ---------- */
  const cues: CueHit[] = [];
  let suppressedHits = 0;
  /** 每条 cue 合并后的原始命中，保留 cue 顺序供编号分配 */
  const mergedByCue: { index: number; kept: RawHit[] }[] = [];

  for (const cue of parsed.cues) {
    const { text, map } = plainText(cue.payload);
    const raw: RawHit[] = [];

    for (const { rule, regex } of compiled) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      // 防止零宽命中死循环
      while ((m = regex.exec(text)) !== null) {
        const matched = m[0];
        if (matched.length === 0) {
          regex.lastIndex++;
          continue;
        }
        const isAlias = rule.mode === 'alias';
        raw.push({
          ruleId: rule.id,
          ruleName: rule.name,
          priority: rule.priority,
          start: m.index,
          end: m.index + matched.length,
          match: matched,
          replacement: isAlias ? '' : applyTemplate(rule.replacement, matched, rule.name, m),
          entityKey: normalizeEntity(matched),
        });
      }
    }

    const { kept, suppressed } = mergeHits(raw);
    suppressedHits += suppressed.length;
    mergedByCue.push({ index: cue.index, kept });

    cues.push({
      index: cue.index,
      id: cue.id,
      start: cue.start,
      end: cue.end,
      payload: cue.payload,
      map,
      text,
      hits: [],
      suppressed,
    });
  }

  /* ---------- 第二遍：按 cue 顺序 / 文本位置首次命中分配持久化名 ---------- */
  let totalHits = 0;
  let appliedHits = 0;
  let revertedHits = 0;
  let exceptionHits = 0;
  /** 实体决策列表：按首次命中顺序登记，最后叠加仅存在于决定中的实体 */
  const entityMap = new Map<string, EntitySummary>();

  const cueByIndex = new Map(cues.map((c) => [c.index, c]));
  for (const { index, kept } of mergedByCue) {
    const cue = cueByIndex.get(index)!;
    const hits: Hit[] = kept.map((h) => {
      let aliasName: string | undefined;
      const rule = ruleById.get(h.ruleId);
      if (rule?.mode === 'alias') {
        const mapKey = aliasMapKey(h.ruleId, h.entityKey);
        let entry = aliasByKey.get(mapKey);
        if (!entry) {
          // 首次命中：分配规则内稳定编号（后续 cue / 重排均不复用）
          const seq = (seqByRule.get(h.ruleId) ?? 0) + 1;
          seqByRule.set(h.ruleId, seq);
          entry = {
            ruleId: h.ruleId,
            entityKey: h.entityKey,
            seq,
            alias: autoAliasFor(aliasPrefixOf(rule), seq),
            auto: true,
            sourceText: h.match,
          };
          aliasByKey.set(mapKey, entry);
          aliases.push(entry);
        } else {
          entry.sourceText = h.match;
          if (entry.auto) {
            // 前缀调整联动所有自动化名；手动改名不受影响
            entry.alias = autoAliasFor(aliasPrefixOf(rule), entry.seq);
          }
        }
        h.replacement = entry.alias;
        aliasName = entry.alias;
      }

      /* ---------- 最终状态：逐条例外 > 实体决定 > 默认应用 ---------- */
      const key = hitKey(cue.index, cue.start, h);
      const decision = decisions.get(entityDecisionKey(h.ruleId, h.entityKey));
      const exception = exceptions.get(key);
      let isReverted: boolean;
      let decisionSource: DecisionSource;
      if (exception !== undefined) {
        isReverted = exception === 'reverted';
        decisionSource = 'exception';
        exceptionHits++;
      } else if (decision) {
        isReverted = decision.action === 'keep';
        decisionSource = 'entity';
      } else {
        isReverted = false;
        decisionSource = 'default';
      }
      if (isReverted) revertedHits++;
      else appliedHits++;
      totalHits++;

      /* ---------- 实体决策列表统计（仅胜出命中；被抑制项不生成例外） ---------- */
      const eKey = entityDecisionKey(h.ruleId, h.entityKey);
      let summary = entityMap.get(eKey);
      if (!summary) {
        summary = {
          ruleId: h.ruleId,
          ruleName: h.ruleName,
          entityKey: h.entityKey,
          sourceText: h.match,
          decision: decision?.action ?? null,
          decidedAt: decision?.decidedAt,
          totalHits: 0,
          appliedHits: 0,
          revertedHits: 0,
          exceptionHits: 0,
        };
        entityMap.set(eKey, summary);
      }
      summary.totalHits++;
      if (isReverted) summary.revertedHits++;
      else summary.appliedHits++;
      if (decisionSource === 'exception') summary.exceptionHits++;
      summary.sourceText = h.match;

      return {
        key,
        ruleId: h.ruleId,
        ruleName: h.ruleName,
        priority: h.priority,
        start: h.start,
        end: h.end - 1,
        match: h.match,
        replacement: h.replacement,
        reverted: isReverted,
        decisionSource,
        entityKey: h.entityKey,
        alias: aliasName,
      };
    });
    cue.hits = hits;
  }

  /* ---------- 已持久决定但当前无命中的实体也列入（决定仍生效于未来命中） ---------- */
  for (const d of input.entityDecisions ?? []) {
    const eKey = entityDecisionKey(d.ruleId, d.entityKey);
    if (!entityMap.has(eKey)) {
      entityMap.set(eKey, {
        ruleId: d.ruleId,
        ruleName: ruleById.get(d.ruleId)?.name ?? '',
        entityKey: d.entityKey,
        sourceText: '',
        decision: d.action,
        decidedAt: d.decidedAt,
        totalHits: 0,
        appliedHits: 0,
        revertedHits: 0,
        exceptionHits: 0,
      });
    }
  }

  /* ---------- 导出残留防线：按最终状态生成候选文本并二次扫描 ---------- */
  const safety = runSafetyScan(cues, compiled);

  return {
    cueCount: parsed.cues.length,
    totalHits,
    appliedHits,
    revertedHits,
    suppressedHits,
    exceptionHits,
    cues,
    parseErrors: parsed.errors,
    aliases,
    entities: Array.from(entityMap.values()),
    safety,
  };
}

/* ------------------------------------------------------------------ */
/* 应用命中到 payload（含标签区间覆盖）                                 */
/* ------------------------------------------------------------------ */

/** 用最终命中替换 cue payload 中的对应区间；reverted 的命中保持原文 */
export function applyHitsToPayload(cue: CueHit): string {
  const active = cue.hits.filter((h) => !h.reverted).sort((a, b) => b.start - a.start);
  let payload = cue.payload;
  for (const h of active) {
    const from = cue.map[h.start];
    const endIdx = h.end + 1 < cue.map.length ? cue.map[h.end + 1] : payload.length;
    payload = payload.slice(0, from) + h.replacement + payload.slice(endIdx);
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* 导出残留防线：候选文本二次扫描                                        */
/* ------------------------------------------------------------------ */

/**
 * 按最终状态把 cue 纯文本拼成候选导出文本，并记录逐字符来源：
 *  - original：未被任何胜出命中覆盖的原文；
 *  - reverted：人工保留（逐条例外撤销 / 实体「始终保留」决定）的原文；
 *  - replacement：替换产物（模板展开或稳定化名）。
 * 与 applyHitsToPayload 的语义一致（命中区间覆盖的内联标签被整体移除），
 * 区别仅在于这里作用于纯文本并保留来源映射，供二次扫描分类使用。
 */
export function buildFinalText(cue: CueHit): { text: string; segments: SafetyScanSegment[] } {
  const sorted = [...cue.hits].sort((a, b) => a.start - b.start);
  const segments: SafetyScanSegment[] = [];
  let text = '';
  let pos = 0;
  const push = (
    source: SafetyScanSegment['source'],
    chunk: string,
    hit?: Hit,
  ): void => {
    // 空替换片段仍保留为零长边界：跨边界判定需要感知「这里发生过替换」
    if (!chunk && source === 'original') return;
    segments.push({
      start: text.length,
      end: text.length + chunk.length,
      source,
      ruleId: hit?.ruleId,
      ruleName: hit?.ruleName,
      text: chunk,
    });
    text += chunk;
  };
  for (const h of sorted) {
    if (h.start > pos) push('original', cue.text.slice(pos, h.start));
    if (h.reverted) push('reverted', cue.text.slice(h.start, h.end + 1), h);
    else push('replacement', h.replacement, h);
    pos = h.end + 1;
  }
  if (pos < cue.text.length) push('original', cue.text.slice(pos));
  return { text, segments };
}

/**
 * 导出残留防线：对每条 cue 的候选导出文本再次运行全部启用规则，
 * 用替换前后字符来源映射把二次命中分为三类：
 *  - 人工保留（kept）：命中不涉及任何替换产物，且与人工保留的原文重叠
 *    （保留命中本身，或第一遍被抑制、因胜出命中被保留而复现的命中）→ 仅提示；
 *  - 替换产物（artifact）：命中完全落在单个替换产物内 → 阻断导出，
 *    报告来源规则（产生替换）与目标规则（二次命中）；
 *  - 跨边界新命中（crossBoundary）：命中跨越多个来源片段（含替换边界），
 *    或因替换改变上下文而落在纯原文上的全新命中 → 阻断导出，列出全部涉及区间。
 * 不做优先级合并：任何残留命中都需要被审校员看到。
 */
export function runSafetyScan(
  cues: CueHit[],
  compiled: CompiledRule[],
): SafetyScanSummary {
  const issues: SafetyScanIssue[] = [];
  let kept = 0;
  let artifact = 0;
  let crossBoundary = 0;

  for (const cue of cues) {
    const { text, segments } = buildFinalText(cue);
    if (!text) continue;
    for (const { rule, regex } of compiled) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        const matched = m[0];
        if (matched.length === 0) {
          regex.lastIndex++;
          continue;
        }
        const start = m.index;
        const end = start + matched.length;
        const overlapped = segments.filter((s) => s.start < end && start < s.end);

        const hasReplacement = overlapped.some((s) => s.source === 'replacement');
        const hasReverted = overlapped.some((s) => s.source === 'reverted');
        let kind: SafetyScanKind;
        if (!hasReplacement && hasReverted) {
          // 残留源于人工保留的原文（含被抑制命中随保留复现），仅提示
          kind = 'kept';
        } else if (overlapped.length === 1 && overlapped[0].source === 'replacement') {
          kind = 'artifact';
        } else {
          kind = 'crossBoundary';
        }

        const sourceSeg = kind === 'artifact' ? overlapped[0] : undefined;
        issues.push({
          cueIndex: cue.index,
          cueId: cue.id,
          time: { start: cue.start, end: cue.end },
          rule: { id: rule.id, name: rule.name },
          start,
          end,
          match: matched,
          kind,
          sourceRule:
            sourceSeg && sourceSeg.ruleId
              ? { id: sourceSeg.ruleId, name: sourceSeg.ruleName ?? '' }
              : undefined,
          segments: overlapped,
        });
        if (kind === 'kept') kept++;
        else if (kind === 'artifact') artifact++;
        else crossBoundary++;
      }
    }
  }

  return {
    kept,
    artifact,
    crossBoundary,
    blocked: artifact + crossBoundary > 0,
    issues,
  };
}

/** 导出残留防线拦截：候选文本仍存在替换产物 / 跨边界新命中 */
export class SafetyScanBlockedError extends Error {
  scan: SafetyScanSummary;
  constructor(scan: SafetyScanSummary) {
    super(
      `导出残留防线拦截：候选文本仍有 ${scan.artifact} 处替换产物命中、` +
        `${scan.crossBoundary} 处跨边界新命中，请调整规则或改为人为保留后再导出`,
    );
    this.name = 'SafetyScanBlockedError';
    this.scan = scan;
  }
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

export function exportResult(input: {
  vtt: string;
  rules: MaskRule[];
  revertedKeys?: string[];
  hitExceptions?: HitException[];
  entityDecisions?: EntityDecision[];
  aliases?: AliasEntry[];
  jobId?: string;
}): ExportResult {
  const preview = buildPreview(input);
  // 导出残留防线：替换产物 / 跨边界新命中阻断导出（人工保留仅提示）
  if (preview.safety.blocked) throw new SafetyScanBlockedError(preview.safety);
  const parsed = parseVtt(input.vtt);
  const payloadByIndex = new Map<number, string>();
  for (const cue of preview.cues) {
    payloadByIndex.set(cue.index, applyHitsToPayload(cue));
  }
  const newVtt = serializeVtt(parsed, payloadByIndex);

  const records: AuditRecord[] = [];
  for (const cue of preview.cues) {
    for (const h of cue.hits) {
      records.push({
        cueIndex: cue.index,
        cueId: cue.id,
        time: { start: cue.start, end: cue.end },
        rule: { id: h.ruleId, name: h.ruleName, priority: h.priority },
        source: { start: h.start, end: h.end, text: h.match },
        replacement: h.replacement,
        status: h.reverted ? 'reverted' : 'applied',
        entityKey: h.entityKey,
        alias: h.alias,
        decisionSource: h.decisionSource,
      });
    }
    for (const s of cue.suppressed) {
      records.push({
        cueIndex: cue.index,
        cueId: cue.id,
        time: { start: cue.start, end: cue.end },
        rule: { id: s.ruleId, name: s.ruleName, priority: s.priority },
        source: { start: s.start, end: s.end, text: s.match },
        replacement: '',
        status: 'suppressed',
        suppressedBy: { id: s.winnerRuleId, name: s.winnerRuleName },
        entityKey: s.entityKey,
      });
    }
  }

  const sha256 = createHash('sha256').update(input.vtt, 'utf8').digest('hex');
  const audit: AuditReport = {
    app: 'subtitle-mask-console',
    version: 4,
    generatedAt: new Date().toISOString(),
    source: {
      sha256,
      length: input.vtt.length,
      cueCount: preview.cueCount,
    },
    rules: input.rules.map(normalizeRule),
    stats: {
      totalHits: preview.totalHits,
      appliedHits: preview.appliedHits,
      revertedHits: preview.revertedHits,
      suppressedHits: preview.suppressedHits,
      exceptionHits: preview.exceptionHits,
    },
    records,
    aliases: preview.aliases,
    entityDecisions: (input.entityDecisions ?? []).map((d) => ({
      ruleId: d.ruleId,
      entityKey: d.entityKey,
      action: d.action,
      decidedAt: d.decidedAt,
    })),
    safetyScan: {
      blocked: preview.safety.blocked,
      counts: {
        kept: preview.safety.kept,
        artifact: preview.safety.artifact,
        crossBoundary: preview.safety.crossBoundary,
      },
      issues: preview.safety.issues,
    },
  };

  return {
    vtt: newVtt,
    audit,
    jobId: input.jobId ?? '',
  };
}
