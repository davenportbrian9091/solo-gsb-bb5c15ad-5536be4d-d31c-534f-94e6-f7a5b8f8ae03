import { createHash } from 'crypto';
import { parseTimeMs, parseVtt, serializeVtt } from './vtt';
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
  HitSpan,
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

/** 跨 cue 连续扫描缺省最大间隔（毫秒）：开启跨 cue 但未填 / 非法时使用 */
export const DEFAULT_CROSS_CUE_GAP_MS = 2000;

/** 跨 cue 最大间隔规整：非有限正数或缺省时回落到默认值，限制在 [0, 3_600_000] */
export function normalizeCrossCueGap(ms: unknown): number {
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_CROSS_CUE_GAP_MS;
  return Math.min(3_600_000, Math.max(0, Math.floor(n)));
}

/** 兼容旧版本规则：补齐 mode / aliasPrefix / 跨 cue 字段，并规整非法值 */
export function normalizeRule(rule: MaskRule): MaskRule {
  return {
    ...rule,
    mode: rule.mode === 'alias' ? 'alias' : 'template',
    aliasPrefix: typeof rule.aliasPrefix === 'string' ? rule.aliasPrefix : '',
    crossCue: rule.crossCue === true,
    crossCueMaxGapMs: normalizeCrossCueGap(rule.crossCueMaxGapMs ?? DEFAULT_CROSS_CUE_GAP_MS),
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
/* 跨 cue 扫描窗口：仅时间相邻且间隔不超阈值的 cue 文本拼接为窗口         */
/* ------------------------------------------------------------------ */

interface TimedCue {
  index: number;
  startMs: number;
  endMs: number;
}

/** 一条扫描窗口：若干时间相邻 cue 的纯文本顺序拼接（无分隔符），
 *  text 第 p 个字符通过 base+length 可反查到所属 cue 与 cue 内偏移 */
export interface ScanWindow<C extends TimedCue = TimedCue> {
  cues: C[];
  /** 每个 cue 在拼接文本中的起点与长度 */
  base: number[];
  length: number[];
  text: string;
}

/**
 * 把按时间顺序的 cue 切成若干极大窗口：相邻 cue（前一 cue end → 后一 cue start）
 * 间隔不超过 maxGapMs 才同属一个窗口；间隔超阈值即断开。单条 cue 也自成窗口，
 * 因此开启跨 cue 的规则在窗口上扫描即可同时覆盖单 cue 命中，无需再逐 cue 扫一遍。
 */
export function buildWindows<C extends TimedCue>(
  cues: C[],
  maxGapMs: number,
  textOf: (cue: C) => string,
): ScanWindow<C>[] {
  const windows: ScanWindow<C>[] = [];
  let group: C[] = [];
  const flush = (): void => {
    if (!group.length) return;
    const base: number[] = [];
    const length: number[] = [];
    let text = '';
    for (const c of group) {
      base.push(text.length);
      const t = textOf(c);
      length.push(t.length);
      text += t;
    }
    windows.push({ cues: group, base, length, text });
    group = [];
  };
  for (const cue of cues) {
    if (group.length) {
      const prev = group[group.length - 1];
      if (cue.startMs - prev.endMs > maxGapMs) flush();
    }
    group.push(cue);
  }
  flush();
  return windows;
}

/** 拼接文本中的字符位置 → cue 序号（窗口内下标）；空 cue 回退到前一条 */
function cueAtOffset<C extends TimedCue>(w: ScanWindow<C>, offset: number): number {
  let lo = 0;
  let hi = w.cues.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (w.base[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 把窗口拼接文本中的 [start, end) 区间拆成各 cue 内的含起止片段（丢弃零长片段） */
export function spansFromWindow<C extends TimedCue>(
  w: ScanWindow<C>,
  start: number,
  end: number,
): HitSpan[] {
  const spans: HitSpan[] = [];
  const first = cueAtOffset(w, start);
  const last = cueAtOffset(w, Math.max(start, end - 1));
  for (let k = first; k <= last; k++) {
    const s = Math.max(start, w.base[k]) - w.base[k];
    const e = Math.min(end, w.base[k] + w.length[k]) - w.base[k] - 1;
    if (e >= s) spans.push({ cueIndex: w.cues[k].index, start: s, end: e });
  }
  return spans;
}

/* ------------------------------------------------------------------ */
/* 命中合并（优先级 + 最长重叠吞并）                                    */
/* ------------------------------------------------------------------ */

interface RawHit {
  ruleId: string;
  ruleName: string;
  priority: number;
  /** 文档拼接坐标（各 cue 纯文本首尾相接），跨 cue 命中与单 cue 命中在此统一消解 */
  start: number;
  end: number; // 不含
  match: string;
  replacement: string;
  /** 实体键（NFKC + trim）：所有规则都计算，供实体决策与稳定化名使用 */
  entityKey: string;
  /** 命中覆盖到的 cue 片段（1 个为单 cue 命中，多个为跨 cue 命中） */
  spans: HitSpan[];
}

/** 单 cue 命中沿用历史 key 格式，保证旧任务的逐条例外继续生效 */
function singleCueHitKey(cueIndex: number, cueStart: string, h: RawHit): string {
  return `${cueIndex}:${cueStart}:${h.start}-${h.end}:${h.ruleId}`;
}

/** 跨 cue 命中 key：含全部涉及 cue 与区间，VTT 未改时保持稳定 */
function crossCueHitKey(h: RawHit): string {
  const body = h.spans.map((s) => `${s.cueIndex}:${s.start}-${s.end + 1}`).join('|');
  return `X:${body}:${h.ruleId}`;
}

/** 两个命中是否在任一 cue 的纯文本区间上重叠（含边界吞并，与原语义一致） */
function spansOverlap(a: HitSpan[], b: HitSpan[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x.cueIndex === y.cueIndex && x.start <= y.end && y.start <= x.end) return true;
    }
  }
  return false;
}

/** 合并阶段的内部抑制项：spans 必填（输出到 API / 审计时单 cue 项再剥离） */
type InternalSuppressed = SuppressedHit & { spans: HitSpan[] };

/** 按优先级降序、长度降序、规则名、起点排序，贪心选择互不重叠的命中 */
function mergeHits(raw: RawHit[]): { kept: RawHit[]; suppressed: InternalSuppressed[] } {
  const ordered = [...raw].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    const nameDiff = a.ruleName.localeCompare(b.ruleName);
    if (nameDiff !== 0) return nameDiff;
    // 最终确定性兜底：按首片段 cue / 偏移
    const as = a.spans[0];
    const bs = b.spans[0];
    if (as.cueIndex !== bs.cueIndex) return as.cueIndex - bs.cueIndex;
    return as.start - bs.start;
  });
  const kept: RawHit[] = [];
  const suppressed: InternalSuppressed[] = [];
  for (const h of ordered) {
    const winner = kept.find((k) => spansOverlap(h.spans, k.spans));
    if (winner) {
      suppressed.push({
        ruleId: h.ruleId,
        ruleName: h.ruleName,
        priority: h.priority,
        start: h.spans[0].start,
        end: h.spans[0].end,
        match: h.match,
        reason: 'overlap',
        winnerRuleId: winner.ruleId,
        winnerRuleName: winner.ruleName,
        entityKey: h.entityKey,
        spans: h.spans,
      });
    } else {
      kept.push(h);
    }
  }
  // 胜者按首个涉及 cue、cue 内起点排列（化名编号 / 审计顺序与 cue 阅读顺序一致）
  kept.sort((a, b) => {
    const as = a.spans[0];
    const bs = b.spans[0];
    if (as.cueIndex !== bs.cueIndex) return as.cueIndex - bs.cueIndex;
    return as.start - bs.start;
  });
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

  /* ---------- 纯文本与时间信息 ---------- */
  interface PlainCue extends TimedCue {
    cue: (typeof parsed.cues)[number];
    text: string;
    map: number[];
  }
  const plainCues: PlainCue[] = parsed.cues.map((cue) => {
    const { text, map } = plainText(cue.payload);
    return {
      index: cue.index,
      startMs: parseTimeMs(cue.start),
      endMs: parseTimeMs(cue.end),
      cue,
      text,
      map,
    };
  });

  /* ---------- 第一遍：单 cue / 跨 cue 窗口扫描 + 全局优先级合并 ---------- */
  const cues: CueHit[] = plainCues.map(({ cue, text, map }) => ({
    index: cue.index,
    id: cue.id,
    start: cue.start,
    end: cue.end,
    payload: cue.payload,
    map,
    text,
    hits: [],
    coveringHits: [],
    suppressed: [],
  }));
  const cueByIndex = new Map(cues.map((c) => [c.index, c]));

  /** 文档拼接坐标：各 cue 纯文本首尾相接，跨 cue 与单 cue 命中在此统一比较 */
  const docBase = new Map<number, number>();
  let docPos = 0;
  for (const c of plainCues) {
    docBase.set(c.index, docPos);
    docPos += c.text.length;
  }

  const raw: RawHit[] = [];
  for (const { rule, regex } of compiled) {
    const pushMatch = (
      m: RegExpExecArray,
      winStart: number,
      spans: HitSpan[],
    ): void => {
      const matched = m[0];
      const isAlias = rule.mode === 'alias';
      raw.push({
        ruleId: rule.id,
        ruleName: rule.name,
        priority: rule.priority,
        start: winStart,
        end: winStart + matched.length,
        match: matched,
        replacement: isAlias ? '' : applyTemplate(rule.replacement, matched, rule.name, m),
        entityKey: normalizeEntity(matched),
        spans,
      });
    };

    if (rule.crossCue) {
      // 跨 cue 规则：仅在时间相邻且间隔不超阈值的窗口上扫描；
      // 单条 cue 自成窗口，单 cue 命中同样由此产生（不再逐 cue 重扫，避免重复）。
      // 窗口按 cue 顺序划分全部 cue，窗口拼接文本起点即首 cue 文档坐标。
      const windows = buildWindows(plainCues, rule.crossCueMaxGapMs ?? DEFAULT_CROSS_CUE_GAP_MS, (c) => c.text);
      for (const w of windows) {
        regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(w.text)) !== null) {
          if (m[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          const spans = spansFromWindow(w, m.index, m.index + m[0].length);
          const docStart = docBase.get(w.cues[0].index)! + m.index;
          pushMatch(m, docStart, spans);
        }
      }
    } else {
      for (const c of plainCues) {
        regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(c.text)) !== null) {
          if (m[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          pushMatch(m, docBase.get(c.index)! + m.index, [
            { cueIndex: c.index, start: m.index, end: m.index + m[0].length - 1 },
          ]);
        }
      }
    }
  }

  const { kept, suppressed } = mergeHits(raw);
  let suppressedHits = 0;
  for (const s of suppressed) {
    // 抑制项挂在首个涉及 cue 上（审计与「重叠抑制」提示按此展示）；
    // 单 cue 抑制项不对外输出 spans，保持历史 API 形状
    const attached: SuppressedHit =
      s.spans.length > 1 ? s : { ...s, spans: undefined };
    cueByIndex.get(s.spans[0].cueIndex)!.suppressed.push(attached);
    suppressedHits++;
  }

  /* ---------- 第二遍：按 cue 顺序 / 文本位置首次命中分配持久化名、解析最终状态 ---------- */
  let totalHits = 0;
  let appliedHits = 0;
  let revertedHits = 0;
  let exceptionHits = 0;
  let crossCueHits = 0;
  /** 实体决策列表：按首次命中顺序登记，最后叠加仅存在于决定中的实体 */
  const entityMap = new Map<string, EntitySummary>();

  for (const h of kept) {
    const firstSpan = h.spans[0];
    const cue = cueByIndex.get(firstSpan.cueIndex)!;

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
    const key =
      h.spans.length > 1
        ? crossCueHitKey(h)
        : singleCueHitKey(cue.index, cue.start, h);
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
    if (h.spans.length > 1) crossCueHits++;

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

    const hit: Hit = {
      key,
      ruleId: h.ruleId,
      ruleName: h.ruleName,
      priority: h.priority,
      start: firstSpan.start,
      end: firstSpan.end,
      match: h.match,
      replacement: h.replacement,
      reverted: isReverted,
      decisionSource,
      entityKey: h.entityKey,
      alias: aliasName,
      spans: h.spans.length > 1 ? h.spans : undefined,
    };
    // 命中本体存于首个涉及 cue；后续涉及 cue 仅持同一对象引用，联动高亮 / 撤销共用 key
    cue.hits.push(hit);
    for (const span of h.spans.slice(1)) {
      cueByIndex.get(span.cueIndex)!.coveringHits.push(hit);
    }
  }
  for (const c of cues) {
    c.hits.sort((a, b) => a.start - b.start);
    c.coveringHits.sort((a, b) => (a.spans!.find((s) => s.cueIndex === c.index)!.start) - (b.spans!.find((s) => s.cueIndex === c.index)!.start));
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
    crossCueHits,
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

/**
 * 用最终命中替换 cue payload 中的对应区间；reverted 的命中保持原文。
 * 跨 cue 命中：替换文本写入首个命中 cue（含标签区间整体覆盖语义），
 * 后续涉及 cue 中被覆盖的字符整体删除（同样覆盖其间内联标签）；
 * 各 cue 时间、标识与未命中文字保留。
 */
export function applyHitsToPayload(cue: CueHit): string {
  /** 本 cue 上所有待执行编辑：命中本体（hits）取替换文本，跨 cue 后续覆盖取空串 */
  const edits: { from: number; to: number; replacement: string; start: number }[] = [];
  const consider = (h: Hit, covering: boolean): void => {
    if (h.reverted) return;
    const span = (h.spans ?? [{ cueIndex: cue.index, start: h.start, end: h.end }]).find(
      (s) => s.cueIndex === cue.index,
    );
    if (!span) return;
    const from = cue.map[span.start];
    const to = span.end + 1 < cue.map.length ? cue.map[span.end + 1] : cue.payload.length;
    edits.push({ from, to, replacement: covering ? '' : h.replacement, start: span.start });
  };
  for (const h of cue.hits) consider(h, false);
  for (const h of cue.coveringHits) consider(h, true);

  // 同一 cue 内各命中区间互不重叠（已合并），自后向前替换即可保持下标有效
  let payload = cue.payload;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    payload = payload.slice(0, e.from) + e.replacement + payload.slice(e.to);
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
  /** 本 cue 内的全部命中区间（含跨 cue 命中在本 cue 的后续覆盖部分） */
  const local = (h: Hit): { start: number; end: number; hit: Hit } | null => {
    const span = (h.spans ?? [{ cueIndex: cue.index, start: h.start, end: h.end }]).find(
      (s) => s.cueIndex === cue.index,
    );
    return span ? { start: span.start, end: span.end, hit: h } : null;
  };
  const sorted = [...cue.hits, ...cue.coveringHits]
    .map(local)
    .filter((x): x is { start: number; end: number; hit: Hit } => x !== null)
    .sort((a, b) => a.start - b.start);
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
      cueIndex: cue.index,
    });
    text += chunk;
  };
  for (const { start, end, hit } of sorted) {
    if (start > pos) push('original', cue.text.slice(pos, start));
    if (hit.reverted) push('reverted', cue.text.slice(start, end + 1), hit);
    else {
      const isFirstSpan = !hit.spans || hit.spans[0].cueIndex === cue.index;
      // 首个覆盖区间写入替换文本；跨 cue 命中在后续 cue 的覆盖部分应用时被删除（空替换），
      // 仍保留零长边界供跨边界判定感知。
      push('replacement', isFirstSpan ? hit.replacement : '', hit);
    }
    pos = end + 1;
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
 *  - 跨边界新命中（crossBoundary）：命中跨越多个来源片段（含替换边界 / cue 边界），
 *    或因替换改变上下文而落在纯原文上的全新命中 → 阻断导出，列出全部涉及区间。
 * 两遍扫描：A 逐 cue（全部规则，含跨 cue 规则的单 cue 命中）；
 * B 对开启跨 cue 的规则按与第一遍相同的相邻窗口拼接「候选文本」扫描，
 * 仅上报跨 ≥2 个 cue 的命中（单 cue 命中已由 A 覆盖）。
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

  const classify = (
    overlapped: SafetyScanSegment[],
  ): { kind: SafetyScanKind; sourceSeg?: SafetyScanSegment } => {
    const hasReplacement = overlapped.some((s) => s.source === 'replacement');
    const hasReverted = overlapped.some((s) => s.source === 'reverted');
    if (!hasReplacement && hasReverted) {
      // 残留源于人工保留的原文（含被抑制命中随保留复现），仅提示
      return { kind: 'kept' };
    }
    if (overlapped.length === 1 && overlapped[0].source === 'replacement') {
      return { kind: 'artifact', sourceSeg: overlapped[0] };
    }
    return { kind: 'crossBoundary' };
  };

  const record = (issue: SafetyScanIssue): void => {
    issues.push(issue);
    if (issue.kind === 'kept') kept++;
    else if (issue.kind === 'artifact') artifact++;
    else crossBoundary++;
  };

  /* ---------- 扫描 A：逐 cue，全部规则 ---------- */
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
        const { kind, sourceSeg } = classify(overlapped);
        record({
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
      }
    }
  }

  /* ---------- 扫描 B：跨 cue 窗口（仅开启跨 cue 的规则），只报跨 ≥2 cue 的命中 ---------- */
  interface FinalCue extends TimedCue {
    cue: CueHit;
    finalText: string;
    finalSegments: SafetyScanSegment[];
  }
  const finalCues: FinalCue[] = cues.map((cue) => {
    const { text, segments } = buildFinalText(cue);
    return {
      index: cue.index,
      startMs: parseTimeMs(cue.start),
      endMs: parseTimeMs(cue.end),
      cue,
      finalText: text,
      finalSegments: segments,
    };
  });

  for (const { rule, regex } of compiled) {
    if (!rule.crossCue) continue;
    const windows = buildWindows(
      finalCues,
      rule.crossCueMaxGapMs ?? DEFAULT_CROSS_CUE_GAP_MS,
      (c) => c.finalText,
    );
    for (const w of windows) {
      if (w.cues.length < 2) continue;
      // 把各 cue 候选文本的来源片段平移为窗口拼接坐标（保留零长替换边界）
      const flatSegments: SafetyScanSegment[] = [];
      for (let k = 0; k < w.cues.length; k++) {
        const base = w.base[k];
        for (const s of w.cues[k].finalSegments) {
          flatSegments.push({ ...s, start: s.start + base, end: s.end + base });
        }
      }
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(w.text)) !== null) {
        const matched = m[0];
        if (matched.length === 0) {
          regex.lastIndex++;
          continue;
        }
        const start = m.index;
        const end = start + matched.length;
        const overlapped = flatSegments.filter((s) => s.start < end && start < s.end);
        // 涉及 cue 列表（去重保序）；只有真正跨越 ≥2 个 cue 才由本扫描上报
        const cueIndices = Array.from(new Set(overlapped.map((s) => s.cueIndex)));
        if (cueIndices.length < 2) continue;

        const { kind, sourceSeg } = classify(overlapped);
        const firstCue = w.cues.find((c) => c.index === cueIndices[0])!.cue;
        const lastCue = w.cues.find((c) => c.index === cueIndices[cueIndices.length - 1])!.cue;
        record({
          cueIndex: firstCue.index,
          cueId: firstCue.id,
          time: { start: firstCue.start, end: lastCue.end },
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
          cueIndices,
        });
      }
    }
  }

  // 问题清单稳定排序：首 cue、规则、窗口偏移，便于预览与审计展示
  issues.sort((a, b) =>
    a.cueIndex - b.cueIndex ||
    a.rule.id.localeCompare(b.rule.id) ||
    a.start - b.start,
  );

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
  const cueByIdx = new Map(preview.cues.map((c) => [c.index, c]));
  for (const cue of preview.cues) {
    for (const h of cue.hits) {
      const cross = h.spans && h.spans.length > 1 ? h.spans : undefined;
      const lastCue = cross ? cueByIdx.get(cross[cross.length - 1].cueIndex) : undefined;
      records.push({
        cueIndex: cue.index,
        cueId: cue.id,
        time: { start: cue.start, end: lastCue ? lastCue.end : cue.end },
        rule: { id: h.ruleId, name: h.ruleName, priority: h.priority },
        source: { start: h.start, end: h.end, text: h.match },
        replacement: h.replacement,
        status: h.reverted ? 'reverted' : 'applied',
        entityKey: h.entityKey,
        alias: h.alias,
        decisionSource: h.decisionSource,
        cueIndices: cross?.map((s) => s.cueIndex),
        spans: cross,
      });
    }
    for (const s of cue.suppressed) {
      const cross = s.spans && s.spans.length > 1 ? s.spans : undefined;
      const lastCue = cross ? cueByIdx.get(cross[cross.length - 1].cueIndex) : undefined;
      records.push({
        cueIndex: cue.index,
        cueId: cue.id,
        time: { start: cue.start, end: lastCue ? lastCue.end : cue.end },
        rule: { id: s.ruleId, name: s.ruleName, priority: s.priority },
        source: { start: s.start, end: s.end, text: s.match },
        replacement: '',
        status: 'suppressed',
        suppressedBy: { id: s.winnerRuleId, name: s.winnerRuleName },
        entityKey: s.entityKey,
        cueIndices: cross?.map((sp) => sp.cueIndex),
        spans: cross,
      });
    }
  }

  const sha256 = createHash('sha256').update(input.vtt, 'utf8').digest('hex');
  const audit: AuditReport = {
    app: 'subtitle-mask-console',
    version: 5,
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
      crossCueHits: preview.crossCueHits,
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
