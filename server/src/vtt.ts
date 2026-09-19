/**
 * 轻量 WebVTT 解析器：只解析结构，不改动时间码与样式。
 * - 保留 WEBVTT 头部（NOTE / STYLE / REGION 块原样输出）
 * - 保留每个 cue 的 id 行（无 id 则输出时省略）
 * - 时间行、payload 原样保留；行尾统一为 \r\n（WebVTT 规范要求 CRLF，容忍 LF 输入）
 */

export interface ParsedCue {
  /** 在所有 cue 中的序号（0 起） */
  index: number;
  /** 原始 id 行；没有则为空串 */
  id: string;
  timing: string;
  start: string;
  end: string;
  payload: string;
}

export interface ParsedVtt {
  signature: string;
  /** 头部块（NOTE/STYLE/REGION 等），逐块保留原文 */
  head: string[];
  cues: ParsedCue[];
  errors: string[];
}

const TIMING_RE =
  /^(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s*(.*)$/;

function splitBlocks(input: string): string[][] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (cur.length) {
        blocks.push(cur);
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

export function parseVtt(input: string): ParsedVtt {
  const errors: string[] = [];
  const blocks = splitBlocks(input);
  const cues: ParsedCue[] = [];
  const head: string[] = [];

  let signature = 'WEBVTT';
  let first = true;

  for (const block of blocks) {
    if (first && /^WEBVTT(\s|$)/.test(block[0])) {
      signature = block[0];
      if (block.length > 1) head.push(block.slice(1).join('\n'));
      first = false;
      continue;
    }
    first = false;

    const firstLine = block[0] ?? '';
    let timingLineIdx = -1;
    for (let i = 0; i < Math.min(block.length, 3); i++) {
      if (TIMING_RE.test(block[i])) {
        timingLineIdx = i;
        break;
      }
    }

    if (timingLineIdx === -1) {
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(firstLine)) {
        head.push(block.join('\n'));
      } else {
        errors.push(`无法识别的块已忽略: ${firstLine.slice(0, 40)}`);
      }
      continue;
    }

    const m = block[timingLineIdx].match(TIMING_RE)!;
    const id = block.slice(0, timingLineIdx).join('\n');
    const payload = block.slice(timingLineIdx + 1).join('\n');
    if (!payload.trim()) {
      errors.push(`时间码 ${m[1]} --> ${m[2]} 的字幕文本为空，已保留`);
    }
    cues.push({
      index: cues.length,
      id,
      timing: block[timingLineIdx],
      start: m[1],
      end: m[2],
      payload,
    });
  }

  if (cues.length === 0 && input.trim() !== '' && !/^WEBVTT/i.test(input.trim())) {
    errors.push('未找到 WEBVTT 签名或任何有效字幕块');
  }

  return { signature, head, cues, errors };
}

/** 序列化，payload 可逐条替换；时间轴/头部完全保留 */
export function serializeVtt(
  parsed: ParsedVtt,
  payloadByIndex: Map<number, string>,
): string {
  const out: string[] = [parsed.signature.trim() || 'WEBVTT', ''];
  for (const h of parsed.head) {
    out.push(h, '');
  }
  for (const cue of parsed.cues) {
    if (cue.id) out.push(cue.id);
    out.push(cue.timing);
    out.push(payloadByIndex.get(cue.index) ?? cue.payload);
    out.push('');
  }
  // WebVTT 要求 CRLF
  return out.join('\r\n');
}
