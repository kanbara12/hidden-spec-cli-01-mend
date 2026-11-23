// mend: one patch tool for every AI edit format.
//
// Reads one patch (unified diff, SEARCH/REPLACE blocks, V4A patch, or JSON
// text-editor tool calls) and applies it to the tree of text files in the
// working directory, exactly as SPEC.md (version 1) says. Node 22, standard
// library only. When MAKEFUN_ENV_URL is set, hands the trial over to the
// kit's runner instead of running one check.

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function trimEndWs(s: string): string {
  return s.replace(/\s+$/, '');
}

function stripTrailing(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function stripLeading(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(i);
}

function stripBoth(s: string): string {
  return stripLeading(stripTrailing(s));
}

function leadingWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function byteCompare(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// A patch's lines: split at \n, one trailing \r removed from each, without
// the empty piece after a final \n.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Files: lines, line break, final break (SPEC section 3)
// ---------------------------------------------------------------------------

interface ParsedFile {
  lines: string[];
  brk: string; // '\r\n' or '\n'
  endsWithBreak: boolean;
}

function parseFileText(text: string): ParsedFile {
  let brk = '\n';
  const firstLf = text.indexOf('\n');
  if (firstLf > 0 && text[firstLf - 1] === '\r') brk = '\r\n';
  if (text === '') return { lines: [], brk, endsWithBreak: false };
  const parts = text.split(brk);
  if (text.endsWith(brk)) {
    return { lines: parts.slice(0, -1), brk, endsWithBreak: true };
  }
  return { lines: parts, brk, endsWithBreak: false };
}

function serializeFile(f: ParsedFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.endsWithBreak ? f.brk : '');
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

interface Tree {
  files: Map<string, string>;
  dirs: Set<string>;
}

function loadTree(root: string): Tree {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel === '' ? e.name : rel + '/' + e.name;
      const full = join(dir, e.name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        dirs.add(p);
        walk(full, p);
      } else if (st.isFile()) {
        try {
          files.set(p, readFileSync(full, 'utf8'));
        } catch {
          // An unreadable file stays as it is; edits cannot see it.
        }
      }
    }
  };
  walk(root, '');
  return { files, dirs };
}

// ---------------------------------------------------------------------------
// Invocation (SPEC section 1)
// ---------------------------------------------------------------------------

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Options | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let formatSeen = false;
  let checkSeen = false;
  let strictSeen = false;
  const positional: string[] = [];
  let noMoreOptions = false;
  for (const a of argv) {
    if (!noMoreOptions && a === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (checkSeen) return null;
        checkSeen = true;
        check = true;
      } else if (a === '--strict') {
        if (strictSeen) return null;
        strictSeen = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (formatSeen) return null;
        formatSeen = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patch: positional.length === 1 ? positional[0] : null };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const rest = lines[first].replace(/^\s+/, '');
  const c = rest.length > 0 ? rest[0] : '';
  if (c === '[' || c === '{') return 'json';
  for (const line of lines) {
    if (trimEndWs(line) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching (SPEC section 5)
// ---------------------------------------------------------------------------

function lineEqAtTier(fileLine: string, oLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oLine;
  if (tier === 1) return stripTrailing(fileLine) === stripTrailing(oLine);
  return stripBoth(fileLine) === stripBoth(oLine);
}

// All positions i >= minPos where O matches lines[i..i+O.length).
function occurrencesAtTier(lines: string[], o: string[], tier: number, minPos: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = minPos; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEqAtTier(lines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0, then 1, then 2; only 0 when strict) with an occurrence at
// or after minPos, and its positions.
function firstTierOccurrences(
  lines: string[],
  o: string[],
  strict: boolean,
  minPos: number,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAtTier(lines, o, tier, minPos);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

// One line of N: { text, ctx } where ctx is the index into O for a context
// line, or null for an added line.
interface NLine {
  text: string;
  ctx: number | null;
}

// Build the replacement lines for a match at position pos. Context lines are
// written as the file's own matched lines; other lines are written as they
// are, except at tier 2 they are re-indented (SPEC section 5).
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && o.length > 0) {
    const f = leadingWs(fileLines[pos]);
    const p = leadingWs(o[0]);
    for (const nl of n) {
      if (nl.ctx !== null) {
        out.push(fileLines[pos + nl.ctx]);
      } else if (nl.text !== '' && /[^ \t]/.test(nl.text) && nl.text.startsWith(p)) {
        out.push(f + nl.text.slice(p.length));
      } else {
        out.push(nl.text);
      }
    }
    return out;
  }
  for (const nl of n) {
    if (nl.ctx !== null) out.push(fileLines[pos + nl.ctx]);
    else out.push(nl.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  // A '\' line follows the hunk's last context or '+' line.
  noBreak: boolean;
  // A '\' line follows the hunk's last '+' line (creation files).
  plusNoBreak: boolean;
}

type Edit =
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; mode: 'create' | 'delete' | 'move' | 'change'; hunks: Hunk[]; createNoBreak: boolean }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a'; op: 'add' | 'delete' | 'update'; path: string; moveTo: string | null; addLines: string[]; chunks: VChunk[] }
  | { kind: 'json'; op: 'create' | 'str_replace' | 'insert'; path: string; fileText: string; oldStr: string; newStr: string; insertLine: number };

interface VChunk {
  anchor: string | null;
  hasAnchor: boolean;
  eof: boolean;
  body: string[];
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

function unifiedPath(raw: string): string | null {
  // Text after the four characters, up to the first tab, surrounding spaces
  // removed. /dev/null means no file. A leading a/ or b/ is removed.
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT_RE = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface HunkBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

function finishHunk(a: number, body: HunkBodyLine[]): Hunk {
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1].kind === 'ctx' && body[body.length - 1].text === '') {
    body.pop();
  }
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of body) {
    if (bl.kind === 'ctx') {
      o.push(bl.text);
      n.push({ text: bl.text, ctx: o.length - 1 });
    } else if (bl.kind === 'old') {
      o.push(bl.text);
    } else if (bl.kind === 'new') {
      n.push({ text: bl.text, ctx: null });
    }
  }
  let noBreak = false;
  let plusNoBreak = false;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i].kind === 'ctx' || body[i].kind === 'new') {
      noBreak = i + 1 < body.length && body[i + 1].kind === 'backslash';
      break;
    }
  }
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i].kind === 'new') {
      plusNoBreak = i + 1 < body.length && body[i + 1].kind === 'backslash';
      break;
    }
  }
  return { a, o, n, noBreak, plusNoBreak };
}

interface USection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  inHunks: boolean;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hunkA = 0;
  let hunkBody: HunkBodyLine[] | null = null;

  const closeHunk = (): void => {
    if (hunkBody !== null && cur !== null) {
      cur.hunks.push(finishHunk(hunkA, hunkBody));
      hunkBody = null;
    }
  };
  const closeSection = (): void => {
    closeHunk();
    if (cur !== null) {
      sections.push(cur);
      cur = null;
    }
  };
  const newSection = (): USection => ({
    oldPath: undefined,
    newPath: undefined,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    hasPair: false,
    newFile: false,
    delFile: false,
    hunks: [],
    inHunks: false,
  });

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Inside a hunk body?
    if (hunkBody !== null) {
      // The body ends at a diff --git line, at a --- line followed by a
      // +++ line, or at the first other line.
      if (line.startsWith('diff --git ') || line === 'diff --git') {
        closeHunk();
        // fall through to section handling below
      } else if (
        line.startsWith('--- ') &&
        i + 1 < lines.length &&
        lines[i + 1].startsWith('+++ ')
      ) {
        closeHunk();
        // fall through to section handling below
      } else if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        if (line === '') hunkBody.push({ kind: 'ctx', text: '' });
        else if (line.startsWith(' ')) hunkBody.push({ kind: 'ctx', text: line.slice(1) });
        else if (line.startsWith('-')) hunkBody.push({ kind: 'old', text: line.slice(1) });
        else if (line.startsWith('+')) hunkBody.push({ kind: 'new', text: line.slice(1) });
        else hunkBody.push({ kind: 'backslash', text: line });
        continue;
      } else {
        closeHunk();
        // fall through to section handling below
      }
    }

    // Not in a body (or the body just ended): section structure.
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new ParseError(i + 1);
      closeSection();
      cur = newSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && !cur.inHunks && !cur.hasPair) {
        cur.oldPath = unifiedPath(line);
        cur.newPath = unifiedPath(lines[i + 1]);
        cur.hasPair = true;
      } else {
        closeSection();
        cur = newSection();
        cur.oldPath = unifiedPath(line);
        cur.newPath = unifiedPath(lines[i + 1]);
        cur.hasPair = true;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A --- line not followed by a +++ line, inside a section's header.
      if (cur !== null && !cur.inHunks) throw new ParseError(i + 2);
      continue;
    }
    if (line.startsWith('+++ ') && cur !== null && !cur.inHunks) {
      cur.newPath = unifiedPath(line);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseError(i + 1);
      if (cur === null) throw new ParseError(i + 1);
      closeHunk();
      cur.inHunks = true;
      hunkA = Number(m[1]);
      hunkBody = [];
      continue;
    }
    if (cur !== null && !cur.inHunks) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      // index, old mode, new mode, similarity/dissimilarity index, Index:
      // and any other line are ignored.
      continue;
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
  }
  closeSection();
  if (sections.length === 0) throw new ParseError(1);

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.oldPath !== undefined ? s.oldPath : s.renameFrom !== null ? s.renameFrom : s.diffOld;
    const newP = s.newPath !== undefined ? s.newPath : s.renameTo !== null ? s.renameTo : s.diffNew;
    let mode: 'create' | 'delete' | 'move' | 'change';
    if (oldP === null || s.newFile) mode = 'create';
    else if (newP === null || s.delFile) mode = 'delete';
    else if (oldP !== newP) mode = 'move';
    else mode = 'change';
    let createNoBreak = false;
    if (mode === 'create') {
      for (let hi = s.hunks.length - 1; hi >= 0; hi -= 1) {
        const h = s.hunks[hi];
        if (h.n.some((nl) => nl.ctx === null)) {
          createNoBreak = h.plusNoBreak;
          break;
        }
      }
    }
    edits.push({
      kind: 'unified',
      oldPath: oldP === undefined ? null : oldP,
      newPath: newP === undefined ? null : newP,
      mode,
      hunks: s.hunks,
      createNoBreak,
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = trimEndWs(lines[j]);
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new ParseError(searchIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      const t = trimEndWs(lines[j]);
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new ParseError(searchIdx + 1);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j -= 1) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseError(searchIdx + 1);
    }
    edits.push({
      kind: 'sr',
      path,
      oldLines: lines.slice(searchIdx + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

interface VSection {
  op: 'add' | 'delete' | 'update';
  path: string;
  updateLine: number;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  curChunk: VChunk | null;
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const edits: Edit[] = [];
  let cur: VSection | null = null;

  const closeSection = (): void => {
    if (cur === null) return;
    if (cur.op === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') {
        cur.addLines.pop();
      }
      edits.push({ kind: 'v4a', op: 'add', path: cur.path, moveTo: null, addLines: cur.addLines, chunks: [] });
    } else if (cur.op === 'delete') {
      edits.push({ kind: 'v4a', op: 'delete', path: cur.path, moveTo: null, addLines: [], chunks: [] });
    } else {
      const pushedOpen = cur.curChunk !== null;
      if (cur.curChunk !== null) {
        cur.chunks.push(cur.curChunk);
        cur.curChunk = null;
      }
      if (pushedOpen && cur.chunks.length > 0) {
        const lastChunk = cur.chunks[cur.chunks.length - 1];
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1].trim() === '') {
          lastChunk.body.pop();
        }
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) throw new ParseError(cur.updateLine + 1);
      edits.push({ kind: 'v4a', op: 'update', path: cur.path, moveTo: cur.moveTo, addLines: [], chunks: cur.chunks });
    }
    cur = null;
  };

  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i];
    if (line.trim() === '*** End Patch') throw new ParseError(i + 1);
    if (line.startsWith(V4A_ADD) || line.startsWith(V4A_DELETE) || line.startsWith(V4A_UPDATE)) {
      closeSection();
      const op = line.startsWith(V4A_ADD) ? 'add' : line.startsWith(V4A_DELETE) ? 'delete' : 'update';
      const prefix = op === 'add' ? V4A_ADD : op === 'delete' ? V4A_DELETE : V4A_UPDATE;
      cur = { op, path: line.slice(prefix.length).trim(), updateLine: i, moveTo: null, addLines: [], chunks: [], curChunk: null };
      continue;
    }
    if (cur === null) {
      if (line.trim() === '') continue;
      throw new ParseError(i + 1);
    }
    if (cur.op === 'add') {
      if (line === '') {
        cur.addLines.push('');
        continue;
      }
      if (line.startsWith('+')) {
        cur.addLines.push(line);
        continue;
      }
      throw new ParseError(i + 1);
    }
    if (cur.op === 'delete') {
      if (line.trim() === '') continue;
      throw new ParseError(i + 1);
    }
    // Update section.
    if (line.startsWith(V4A_MOVE)) {
      if (cur.chunks.length === 0 && cur.curChunk === null && cur.moveTo === null) {
        cur.moveTo = line.slice(V4A_MOVE.length).trim();
        continue;
      }
      throw new ParseError(i + 1);
    }
    if (line.trim() === '*** End of File') {
      if (cur.curChunk === null) throw new ParseError(i + 1);
      cur.curChunk.eof = true;
      cur.chunks.push(cur.curChunk);
      cur.curChunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur.curChunk !== null) {
        cur.chunks.push(cur.curChunk);
        cur.curChunk = null;
      }
      const anchor = line.slice(2).trim();
      cur.curChunk = { anchor: anchor === '' ? null : anchor, hasAnchor: anchor !== '', eof: false, body: [] };
      continue;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (cur.curChunk === null) {
        if (cur.chunks.length === 0) {
          cur.curChunk = { anchor: null, hasAnchor: false, eof: false, body: [] };
        } else if (line.trim() === '') {
          // Blank line at the end of a section: not part of it.
          continue;
        } else {
          throw new ParseError(i + 1);
        }
      }
      cur.curChunk.body.push(line);
      continue;
    }
    throw new ParseError(i + 1);
  }
  closeSection();
  if (edits.length === 0) throw new ParseError(1);

  // Convert raw Add lines ('+...' or '') to file lines.
  for (const e of edits) {
    if (e.kind === 'v4a' && e.op === 'add') {
      e.addLines = e.addLines.map((raw) => (raw === '' ? '' : raw.slice(1)));
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function validateJsonEdit(obj: unknown): Edit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'json', op: 'create', path: o.path, fileText: o.file_text, oldStr: '', newStr: '', insertLine: 0 };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { kind: 'json', op: 'str_replace', path: o.path, fileText: '', oldStr: o.old_str, newStr: typeof o.new_str === 'string' ? o.new_str : '', insertLine: 0 };
  }
  if (o.command === 'insert') {
    if (!Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'json', op: 'insert', path: o.path, fileText: '', oldStr: '', newStr: o.new_str, insertLine: o.insert_line as number };
  }
  return null;
}

function parseJson(lines: string[], text: string): Edit[] {
  const firstNonWs = text.search(/\S/);
  if (firstNonWs === -1) throw new ParseError(1);
  const firstChar = text[firstNonWs];
  let arrayStartLine = 1;
  for (let i = 0; i < firstNonWs; i += 1) {
    if (text[i] === '\n') arrayStartLine += 1;
  }
  if (firstChar === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseError(arrayStartLine);
    }
    if (!Array.isArray(arr)) throw new ParseError(arrayStartLine);
    const edits: Edit[] = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (e === null) throw new ParseError(arrayStartLine);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Applying edits (SPEC sections 2, 3, 5-10)
// ---------------------------------------------------------------------------

interface Fail {
  code: string;
  path: string;
}

interface Applied {
  changes: Map<string, string | null>;
  moves: { oldPath: string; newPath: string }[];
}

type ApplyResult = { ok: true; applied: Applied } | { ok: false; fail: Fail };

function fileExists(tree: Tree, p: string): boolean {
  return tree.files.has(p);
}

function pathTaken(tree: Tree, p: string): boolean {
  return tree.files.has(p) || tree.dirs.has(p);
}

function chunkON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const raw of body) {
    if (raw === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (raw.startsWith(' ')) {
      const text = raw.slice(1);
      o.push(text);
      n.push({ text, ctx: o.length - 1 });
    } else if (raw.startsWith('-')) {
      o.push(raw.slice(1));
    } else if (raw.startsWith('+')) {
      n.push({ text: raw.slice(1), ctx: null });
    }
  }
  return { o, n };
}

// Apply a unified section's hunks to a file's lines. Returns the new lines
// and final-break flag, or a failure code.
function applyHunks(
  parsed: ParsedFile,
  hunks: Hunk[],
  strict: boolean,
): { lines: string[]; endsWithBreak: boolean } | { fail: string } {
  let lines = parsed.lines.slice();
  let endsWithBreak = parsed.endsWithBreak;
  let d = 0;
  for (const hunk of hunks) {
    if (hunk.o.length === 0) {
      let ins = hunk.a + d;
      if (ins < 0) ins = 0;
      if (ins > lines.length) ins = lines.length;
      const atEnd = ins === lines.length;
      const added = hunk.n.map((nl) => nl.text);
      lines.splice(ins, 0, ...added);
      if (atEnd) endsWithBreak = !hunk.noBreak;
      d += hunk.n.length;
      continue;
    }
    const found = firstTierOccurrences(lines, hunk.o, strict, 0);
    if (found === null) return { fail: 'no-match' };
    const target = hunk.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const atEnd = best + hunk.o.length === lines.length;
    const repl = buildReplacement(lines, best, hunk.o, hunk.n, found.tier);
    lines.splice(best, hunk.o.length, ...repl);
    if (atEnd) endsWithBreak = !hunk.noBreak;
    d += hunk.n.length - hunk.o.length;
  }
  return { lines, endsWithBreak };
}

function applyUnified(tree: Tree, edit: Extract<Edit, { kind: 'unified' }>, strict: boolean): ApplyResult {
  const changes = new Map<string, string | null>();
  const moves: { oldPath: string; newPath: string }[] = [];
  if (edit.mode === 'create') {
    const newPath = edit.newPath ?? '';
    if (!isSafePath(newPath)) return { ok: false, fail: { code: 'unsafe', path: newPath } };
    if (pathTaken(tree, newPath)) return { ok: false, fail: { code: 'exists', path: newPath } };
    const plusLines: string[] = [];
    for (const h of edit.hunks) {
      for (const nl of h.n) {
        if (nl.ctx === null) plusLines.push(nl.text);
      }
    }
    let text = '';
    if (plusLines.length > 0) {
      text = plusLines.join('\n') + (edit.createNoBreak ? '' : '\n');
    }
    changes.set(newPath, text);
    return { ok: true, applied: { changes, moves } };
  }
  const oldPath = edit.oldPath ?? '';
  if (!isSafePath(oldPath)) return { ok: false, fail: { code: 'unsafe', path: oldPath } };
  if (edit.mode === 'delete') {
    if (!fileExists(tree, oldPath)) return { ok: false, fail: { code: 'missing', path: oldPath } };
    changes.set(oldPath, null);
    return { ok: true, applied: { changes, moves } };
  }
  const newPath = edit.newPath ?? '';
  if (edit.mode === 'move' && !isSafePath(newPath)) return { ok: false, fail: { code: 'unsafe', path: newPath } };
  if (!fileExists(tree, oldPath)) return { ok: false, fail: { code: 'missing', path: oldPath } };
  if (edit.mode === 'move' && pathTaken(tree, newPath)) return { ok: false, fail: { code: 'exists', path: newPath } };
  const parsed = parseFileText(tree.files.get(oldPath) as string);
  const res = applyHunks(parsed, edit.hunks, strict);
  if ('fail' in res) return { ok: false, fail: { code: res.fail, path: oldPath } };
  const out: ParsedFile = { lines: res.lines, brk: parsed.brk, endsWithBreak: res.endsWithBreak };
  const text = serializeFile(out);
  if (edit.mode === 'move') {
    changes.set(oldPath, null);
    changes.set(newPath, text);
    moves.push({ oldPath, newPath });
  } else {
    changes.set(oldPath, text);
  }
  return { ok: true, applied: { changes, moves } };
}

function applySr(tree: Tree, edit: Extract<Edit, { kind: 'sr' }>, strict: boolean): ApplyResult {
  const changes = new Map<string, string | null>();
  if (!isSafePath(edit.path)) return { ok: false, fail: { code: 'unsafe', path: edit.path } };
  if (edit.oldLines.length === 0) {
    if (pathTaken(tree, edit.path)) return { ok: false, fail: { code: 'exists', path: edit.path } };
    const text = edit.newLines.length > 0 ? edit.newLines.join('\n') + '\n' : '';
    changes.set(edit.path, text);
    return { ok: true, applied: { changes, moves: [] } };
  }
  if (!fileExists(tree, edit.path)) return { ok: false, fail: { code: 'missing', path: edit.path } };
  const parsed = parseFileText(tree.files.get(edit.path) as string);
  const found = firstTierOccurrences(parsed.lines, edit.oldLines, strict, 0);
  if (found === null) return { ok: false, fail: { code: 'no-match', path: edit.path } };
  if (found.occ.length > 1) return { ok: false, fail: { code: 'ambiguous', path: edit.path } };
  const pos = found.occ[0];
  const n: NLine[] = edit.newLines.map((text) => ({ text, ctx: null }));
  const repl = buildReplacement(parsed.lines, pos, edit.oldLines, n, found.tier);
  const lines = parsed.lines.slice();
  lines.splice(pos, edit.oldLines.length, ...repl);
  const text = serializeFile({ lines, brk: parsed.brk, endsWithBreak: parsed.endsWithBreak });
  changes.set(edit.path, text);
  return { ok: true, applied: { changes, moves: [] } };
}

function applyV4a(tree: Tree, edit: Extract<Edit, { kind: 'v4a' }>, strict: boolean): ApplyResult {
  const changes = new Map<string, string | null>();
  const moves: { oldPath: string; newPath: string }[] = [];
  if (!isSafePath(edit.path)) return { ok: false, fail: { code: 'unsafe', path: edit.path } };
  if (edit.op === 'add') {
    if (pathTaken(tree, edit.path)) return { ok: false, fail: { code: 'exists', path: edit.path } };
    const text = edit.addLines.length > 0 ? edit.addLines.join('\n') + '\n' : '';
    changes.set(edit.path, text);
    return { ok: true, applied: { changes, moves } };
  }
  if (edit.op === 'delete') {
    if (!fileExists(tree, edit.path)) return { ok: false, fail: { code: 'missing', path: edit.path } };
    changes.set(edit.path, null);
    return { ok: true, applied: { changes, moves } };
  }
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return { ok: false, fail: { code: 'unsafe', path: edit.moveTo } };
  if (!fileExists(tree, edit.path)) return { ok: false, fail: { code: 'missing', path: edit.path } };
  if (edit.moveTo !== null && pathTaken(tree, edit.moveTo)) return { ok: false, fail: { code: 'exists', path: edit.moveTo } };
  const parsed = parseFileText(tree.files.get(edit.path) as string);
  let lines = parsed.lines.slice();
  let cursor = 0;
  for (const chunk of edit.chunks) {
    if (chunk.hasAnchor && chunk.anchor !== null) {
      // First line at or after the cursor equal to the anchor, at the
      // first tier where one is (single-line comparison).
      let anchorIdx = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        for (let i = cursor; i < lines.length; i += 1) {
          if (lineEqAtTier(lines[i], chunk.anchor, tier)) {
            anchorIdx = i;
            break;
          }
        }
        if (anchorIdx !== -1) break;
      }
      if (anchorIdx === -1) return { ok: false, fail: { code: 'no-match', path: edit.path } };
      cursor = anchorIdx + 1;
    }
    const { o, n } = chunkON(chunk.body);
    if (o.length === 0) {
      const ins = chunk.eof ? lines.length : cursor;
      const added = n.map((nl) => nl.text);
      lines.splice(ins, 0, ...added);
      cursor = ins + added.length;
      continue;
    }
    let pos = -1;
    let tierUsed = 0;
    if (chunk.eof) {
      // Only an occurrence ending at the file's last line qualifies.
      const endPos = lines.length - o.length;
      if (endPos >= cursor) {
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          let ok = true;
          for (let j = 0; j < o.length; j += 1) {
            if (!lineEqAtTier(lines[endPos + j], o[j], tier)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            pos = endPos;
            tierUsed = tier;
            break;
          }
        }
      }
      if (pos === -1) return { ok: false, fail: { code: 'no-match', path: edit.path } };
    } else {
      const found = firstTierOccurrences(lines, o, strict, cursor);
      if (found === null) return { ok: false, fail: { code: 'no-match', path: edit.path } };
      pos = found.occ[0];
      tierUsed = found.tier;
    }
    const repl = buildReplacement(lines, pos, o, n, tierUsed);
    lines.splice(pos, o.length, ...repl);
    cursor = pos + repl.length;
  }
  const text = serializeFile({ lines, brk: parsed.brk, endsWithBreak: parsed.endsWithBreak });
  if (edit.moveTo !== null) {
    changes.set(edit.path, null);
    changes.set(edit.moveTo, text);
    moves.push({ oldPath: edit.path, newPath: edit.moveTo });
  } else {
    changes.set(edit.path, text);
  }
  return { ok: true, applied: { changes, moves } };
}

function countOverlapping(hay: string, needle: string): number {
  let count = 0;
  let idx = 0;
  for (;;) {
    const at = hay.indexOf(needle, idx);
    if (at === -1) return count;
    count += 1;
    idx = at + 1;
  }
}

function applyJson(tree: Tree, edit: Extract<Edit, { kind: 'json' }>): ApplyResult {
  const changes = new Map<string, string | null>();
  if (!isSafePath(edit.path)) return { ok: false, fail: { code: 'unsafe', path: edit.path } };
  if (edit.op === 'create') {
    if (pathTaken(tree, edit.path)) return { ok: false, fail: { code: 'exists', path: edit.path } };
    changes.set(edit.path, edit.fileText);
    return { ok: true, applied: { changes, moves: [] } };
  }
  if (!fileExists(tree, edit.path)) return { ok: false, fail: { code: 'missing', path: edit.path } };
  const raw = tree.files.get(edit.path) as string;
  if (edit.op === 'str_replace') {
    const parsed = parseFileText(raw);
    let text = raw;
    let oldStr = edit.oldStr;
    let newStr = edit.newStr;
    if (parsed.brk === '\r\n') {
      text = raw.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    const count = countOverlapping(text, oldStr);
    if (count === 0) return { ok: false, fail: { code: 'no-match', path: edit.path } };
    if (count > 1) return { ok: false, fail: { code: 'ambiguous', path: edit.path } };
    let result = text.replace(oldStr, newStr);
    if (parsed.brk === '\r\n') result = result.replace(/\n/g, '\r\n');
    changes.set(edit.path, result);
    return { ok: true, applied: { changes, moves: [] } };
  }
  // insert
  const parsed = parseFileText(raw);
  if (edit.insertLine < 0 || edit.insertLine > parsed.lines.length) {
    return { ok: false, fail: { code: 'no-match', path: edit.path } };
  }
  const newLines = patchLines(edit.newStr);
  const lines = parsed.lines.slice();
  lines.splice(edit.insertLine, 0, ...newLines);
  const text = serializeFile({ lines, brk: parsed.brk, endsWithBreak: parsed.endsWithBreak });
  changes.set(edit.path, text);
  return { ok: true, applied: { changes, moves: [] } };
}

function applyEdit(tree: Tree, edit: Edit, strict: boolean): ApplyResult {
  if (edit.kind === 'unified') return applyUnified(tree, edit, strict);
  if (edit.kind === 'sr') return applySr(tree, edit, strict);
  if (edit.kind === 'v4a') return applyV4a(tree, edit, strict);
  return applyJson(tree, edit);
}

// ---------------------------------------------------------------------------
// Output and entry point (SPEC sections 1, 2, 10)
// ---------------------------------------------------------------------------

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      patchText = '';
    }
  } else {
    try {
      patchText = readFileSync(opts.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const lines = patchLines(patchText);
  let format = opts.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      return 2;
    }
    format = detected;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (err) {
    if (err instanceof ParseError) {
      process.stdout.write('error: parse ' + err.line + '\n');
      return 2;
    }
    throw err;
  }

  const tree = loadTree(process.cwd());
  const initial = new Map<string, string>(tree.files);
  const working = new Map<string, string>(tree.files);
  const workingDirs = new Set<string>(tree.dirs);
  const view: Tree = { files: working, dirs: workingDirs };
  const failures: Fail[] = [];
  const moves: { oldPath: string; newPath: string }[] = [];
  for (const edit of edits) {
    const res = applyEdit(view, edit, opts.strict);
    if (!res.ok) {
      failures.push(res.fail);
      continue;
    }
    for (const [p, v] of res.applied.changes) {
      if (v === null) {
        working.delete(p);
        workingDirs.delete(p);
      } else {
        working.set(p, v);
        // A created file's parent directories now exist.
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i += 1) {
          workingDirs.add(parts.slice(0, i).join('/'));
        }
      }
    }
    for (const m of res.applied.moves) moves.push(m);
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += 'error: ' + f.code + ' ' + f.path + '\n';
    out += 'failed: ' + failures.length + ' of ' + edits.length + ' edits\n';
    process.stdout.write(out);
    return 1;
  }

  // Change lines, in byte order of the paths (UTF-8); R lines sort by <new>.
  interface ChangeLine {
    sortKey: string;
    line: string;
  }
  const changeLines: ChangeLine[] = [];
  const handledOld = new Set<string>();
  const handledNew = new Set<string>();
  for (const m of moves) {
    if (initial.has(m.oldPath) && !working.has(m.oldPath) && !initial.has(m.newPath) && working.has(m.newPath)) {
      changeLines.push({ sortKey: m.newPath, line: 'R ' + m.oldPath + ' -> ' + m.newPath });
      handledOld.add(m.oldPath);
      handledNew.add(m.newPath);
    }
  }
  const allPaths = new Set<string>([...initial.keys(), ...working.keys()]);
  for (const p of allPaths) {
    if (handledOld.has(p) || handledNew.has(p)) continue;
    const before = initial.get(p);
    const after = working.get(p);
    if (before === undefined && after !== undefined) {
      changeLines.push({ sortKey: p, line: 'A ' + p });
    } else if (before !== undefined && after === undefined) {
      changeLines.push({ sortKey: p, line: 'D ' + p });
    } else if (before !== undefined && after !== undefined && before !== after) {
      changeLines.push({ sortKey: p, line: 'M ' + p });
    }
  }
  changeLines.sort((a, b) => byteCompare(a.sortKey, b.sortKey));
  let out = '';
  for (const cl of changeLines) out += cl.line + '\n';
  out += 'ok: ' + changeLines.length + (changeLines.length === 1 ? ' file\n' : ' files\n');
  process.stdout.write(out);

  if (!opts.check) {
    for (const p of allPaths) {
      const before = initial.get(p);
      const after = working.get(p);
      if (before === after) continue;
      if (after === undefined) {
        try {
          unlinkSync(join(process.cwd(), ...p.split('/')));
        } catch {
          // Already gone.
        }
      } else {
        const full = join(process.cwd(), ...p.split('/'));
        try {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, after, 'utf8');
        } catch {
          // A directory blocks the path; the in-memory result stands.
        }
      }
    }
  }
  return 0;
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  process.exitCode = main();
}
