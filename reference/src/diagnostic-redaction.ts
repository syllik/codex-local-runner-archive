export interface DiagnosticRedactionOptions {
  limit: number;
  replacement: string;
  token?: string | undefined;
  includeGenericKeys?: boolean;
  includeLegacyQueryKeys?: boolean;
}

type AssignmentMode = 'token' | 'generic' | 'query';

interface SensitiveKey {
  value: string;
  mode: AssignmentMode;
}

const tokenKeys: readonly SensitiveKey[] = [
  { value: 'access_token', mode: 'token' },
  { value: 'refresh_token', mode: 'token' },
];
const genericKeys: readonly SensitiveKey[] = [
  { value: 'authorization', mode: 'generic' },
  { value: 'token', mode: 'generic' },
  { value: 'password', mode: 'generic' },
  { value: 'secret', mode: 'generic' },
  { value: 'api_key', mode: 'generic' },
  { value: 'api-key', mode: 'generic' },
  { value: 'apikey', mode: 'generic' },
  { value: 'api key', mode: 'generic' },
];
const legacyQueryKeys: readonly SensitiveKey[] = [
  { value: 'token', mode: 'query' },
  { value: 'key', mode: 'query' },
  { value: 'secret', mode: 'query' },
  { value: 'password', mode: 'query' },
];

interface AssignmentMatch {
  start: number;
  contentStart: number;
  end: number;
  closingStart: number | null;
}

function isWordCharacter(value: string | undefined): boolean {
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122) || value === '_';
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function asciiLowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function matchesKeyAt(value: string, index: number, key: SensitiveKey): boolean {
  for (let offset = 0; offset < key.value.length; offset += 1) {
    if (asciiLowerCode(value.charCodeAt(index + offset)) !== key.value.charCodeAt(offset)) return false;
  }
  return !isWordCharacter(value[index - 1]) && !isWordCharacter(value[index + key.value.length]);
}

function parseAssignment(
  value: string,
  start: number,
  keys: readonly SensitiveKey[],
): AssignmentMatch | null {
  const key = keys.find((candidate) => matchesKeyAt(value, start, candidate));
  if (key === undefined) return null;

  const queryParameter = value[start - 1] === '?' || value[start - 1] === '&';
  if (key.mode === 'query' && !queryParameter) return null;

  let cursor = start + key.value.length;
  while (value[cursor] === '\\') cursor += 1;
  if (value[cursor] === '"' || value[cursor] === "'") cursor += 1;
  while (isWhitespace(value[cursor])) cursor += 1;
  if (value[cursor] !== ':' && value[cursor] !== '=') return null;
  cursor += 1;
  while (isWhitespace(value[cursor])) cursor += 1;

  const delimiterStart = cursor;
  let openingSlashCount = 0;
  while (value[cursor] === '\\') {
    openingSlashCount += 1;
    cursor += 1;
  }
  const delimiter = value[cursor];
  if (delimiter === '"' || delimiter === "'") {
    const contentStart = cursor + 1;
    let position = contentStart;
    let closingStart: number | null = null;
    let end = value.length;
    while (position < value.length) {
      if (value[position] === '\\') {
        const runStart = position;
        while (value[position] === '\\') position += 1;
        const runLength = position - runStart;
        if (value[position] === delimiter && runLength === openingSlashCount) {
          closingStart = runStart;
          end = position + 1;
          break;
        }
        if (value[position] === delimiter) position += 1;
        continue;
      }
      if (value[position] === delimiter && openingSlashCount === 0) {
        closingStart = position;
        end = position + 1;
        break;
      }
      position += 1;
    }
    return { start, contentStart, end, closingStart };
  }

  let end = cursor;
  while (end < value.length) {
    const character = value[end];
    if (isWhitespace(character)) break;
    if (queryParameter && character === '&') break;
    end += 1;
  }
  return { start, contentStart: delimiterStart, end, closingStart: null };
}

function redactSensitiveAssignments(
  value: string,
  replacement: string,
  includeGenericKeys: boolean,
  includeLegacyQueryKeys: boolean,
): string {
  const keys = [
    ...tokenKeys,
    ...(includeGenericKeys ? genericKeys : []),
    ...(includeLegacyQueryKeys ? legacyQueryKeys : []),
  ];
  let cursor = 0;
  let output = '';
  while (cursor < value.length) {
    let match: AssignmentMatch | null = null;
    for (let index = cursor; index < value.length; index += 1) {
      match = parseAssignment(value, index, keys);
      if (match !== null) break;
    }
    if (match === null) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, match.contentStart);
    output += replacement;
    if (match.closingStart !== null) output += value.slice(match.closingStart, match.end);
    cursor = match.end;
  }
  return output;
}

function normalizeDiagnostic(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function redactDiagnostic(value: string, options: DiagnosticRedactionOptions): string {
  const replacement = options.replacement;
  let sanitized = value;
  if (options.token !== undefined && options.token.length > 0) {
    sanitized = sanitized.replaceAll(options.token, replacement);
  }
  sanitized = normalizeDiagnostic(sanitized);
  sanitized = sanitized
    .replace(/\bBearer\s+\S+/giu, `Bearer ${replacement}`)
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{10,}\b/gu, replacement)
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/gu, replacement);
  sanitized = redactSensitiveAssignments(
    sanitized,
    replacement,
    options.includeGenericKeys === true,
    options.includeLegacyQueryKeys === true,
  );
  return sanitized.slice(0, options.limit);
}
