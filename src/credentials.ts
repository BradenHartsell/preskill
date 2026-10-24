/**
 * The shared credential scan, for real secret values only.
 *
 * A Skill that reads a credential is not a Skill that holds one: environment
 * reads, template slots, documented example keys and obvious placeholders are
 * not values. A literal key-shaped value is reported by file and line, never
 * by value, so a person can decide about it.
 */

export const credentialValueKinds = [
  "password_assignment",
  "credential_assignment",
  "session_cookie",
  "jwt",
  "github_token",
  "aws_access_key",
  "aws_secret_key",
  "pem_private_key",
  "openai_project_token",
  "authorization_value",
  "provider_token",
  "credential_url",
  "query_credential",
] as const;

export type CredentialValueKind = (typeof credentialValueKinds)[number];

export interface CredentialValueMatch {
  kind: CredentialValueKind;
  start: number;
  end: number;
}

interface CredentialPattern {
  kind: CredentialValueKind;
  expression: RegExp;
  candidateGroups?: number[];
  skipsCodeValues?: "code" | "reads";
  viewsOnlyInUrlQuery?: boolean;
  keepsLabelValues?: boolean | "prose";
  requiresOpaqueValue?: boolean;
  requiresHeaderValue?: boolean;
}

export interface CredentialScanOptions {
  readonly urlQueryCredentials?: boolean;
}

const isInUrlQueryContext = (text: string, index: number): boolean =>
  index > 0 && "?&#;".includes(text.charAt(index - 1));

const QUERY_VALUE = String.raw`[^&#\s"'<>()\[\]{},;\\]`;

const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  // A Skill that reads a credential is not a Skill that holds one:
  // `api_key = os.environ["API_KEY"]` and `password = getpass.getpass()` are code.
  {
    kind: "password_assignment",
    expression: /\b(?:password|passwd|pwd)\s*[:=](?!=)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;]+))/gi,
    candidateGroups: [1, 2, 3],
    skipsCodeValues: "reads",
    requiresOpaqueValue: true,
    keepsLabelValues: "prose",
  },
  {
    kind: "credential_assignment",
    expression:
      /\b(?:api[_-]?key|client[_-]?secret|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token)\s*[:=](?!=)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;]+))/gi,
    candidateGroups: [1, 2, 3],
    skipsCodeValues: "reads",
    requiresOpaqueValue: true,
    keepsLabelValues: true,
  },
  {
    kind: "credential_assignment",
    expression:
      /\b(?:api|access|refresh) (?:key|token)\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|((?=[^\s,;]*\d)[^\s,;]+))/gi,
    candidateGroups: [1, 2, 3],
    keepsLabelValues: true,
  },
  {
    kind: "credential_assignment",
    expression: /\bsecret\s*=(?!=)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;]+))/gi,
    candidateGroups: [1, 2, 3],
    skipsCodeValues: "code",
    viewsOnlyInUrlQuery: true,
    keepsLabelValues: true,
  },
  {
    kind: "session_cookie",
    expression: /\b(?:Cookie|Set-Cookie)\s*:\s*([^\r\n]+)/gi,
    candidateGroups: [1],
  },
  {
    kind: "jwt",
    expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: "github_token",
    expression: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
  {
    kind: "aws_access_key",
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    kind: "aws_secret_key",
    expression:
      /\b(?:aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key)\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9/+=]{32,}))/gi,
    candidateGroups: [1, 2, 3],
  },
  {
    kind: "pem_private_key",
    expression:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?=[ \t]*\r?\n\s*(?:[A-Za-z0-9-]+:[^\n]*\n\s*)*(?!-----)\S|\s*$)[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  },
  {
    kind: "openai_project_token",
    expression: /\bsk-proj-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    kind: "authorization_value",
    expression: /\bAuthorization[ \t]*:[ \t]*[A-Za-z][A-Za-z0-9_-]*[ \t]+([^\s,;]+)/gi,
    candidateGroups: [1],
    skipsCodeValues: "reads",
    requiresHeaderValue: true,
  },
  {
    kind: "authorization_value",
    expression: /\bBearer\s+([A-Za-z0-9._~+/-]{8,}=*)\b/gi,
    candidateGroups: [1],
    requiresHeaderValue: true,
  },
  {
    kind: "provider_token",
    expression: /\bsk-(?:(?:live|test|proj)-?)?[A-Za-z0-9_-]{8,}\b/gi,
  },
  {
    kind: "provider_token",
    expression:
      /\b(?:sk-ant-[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,})\b/g,
  },
  {
    kind: "credential_url",
    expression:
      /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s/@:]*:([^\s/@]+)@[^\s/]+/gi,
    candidateGroups: [1],
  },
  {
    kind: "query_credential",
    expression: new RegExp(String.raw`(?<=[?&#;])(?:signature|x-amz-signature|x-goog-signature)=(${QUERY_VALUE}{8,})`, "gi"),
    candidateGroups: [1],
  },
  {
    kind: "query_credential",
    expression: new RegExp(
      String.raw`(?<=[?&#;])sig=((?=${QUERY_VALUE}*\d)(?=${QUERY_VALUE}*[A-Za-z])${QUERY_VALUE}{16,})`,
      "gi",
    ),
    candidateGroups: [1],
  },
  {
    kind: "query_credential",
    expression: new RegExp(
      String.raw`(?<=[?&#;])code=((?=${QUERY_VALUE}*\d)(?=${QUERY_VALUE}*[A-Za-z])${QUERY_VALUE}{20,})`,
      "gi",
    ),
    candidateGroups: [1],
  },
  {
    kind: "query_credential",
    expression: new RegExp(String.raw`(?<=[?&#;])key=([0-9a-f]{16,})(?!${QUERY_VALUE})`, "gi"),
    candidateGroups: [1],
  },
  {
    kind: "credential_assignment",
    expression: /(?<![\w-])[a-z][a-z0-9]{1,15}_(?:key|token|secret|pass(?:word|phrase|code)?)_(?=[a-z0-9]*[0-9])[a-z0-9]{8,}\b/gi,
  },
  {
    kind: "credential_assignment",
    expression:
      /(?<![\w-])[a-z][a-z0-9]{1,15}-(?:key|token|secret|pass(?:word|phrase|code)?)-(?=[a-z0-9]*[0-9])(?=[a-z0-9]*[a-z])[a-z0-9]{8,}\b/gi,
  },
  {
    kind: "credential_assignment",
    expression:
      /\b[a-z][a-zA-Z0-9]{1,15}(?:Key|Token|Secret|Password|Passphrase|Passcode|Credential)(?=[a-z0-9]*[0-9])(?=[a-z0-9]*[a-z])[a-z0-9]{8,}\b/g,
  },
  {
    kind: "credential_assignment",
    expression:
      /\b(?:key|token|secret|password|passphrase|passcode|credential)\s+(?:is|was|reads?|equals?)\s+((?=[a-z0-9]*[0-9])[a-z0-9]{10,})\b/gi,
    candidateGroups: [1],
  },
];

/**
 * Published example values from vendor documentation. They are not secrets
 * and must never make a Skill un-installable on their own. The Google key is
 * the one Google's own API-key docs use as `AIzaSy...`.
 */
const documentedExampleKeys: ReadonlySet<string> = new Set([
  "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe",
]);

export function findCredentialValueMatches(
  text: string,
  options: CredentialScanOptions = {},
): CredentialValueMatch[] {
  const viewScan = options.urlQueryCredentials === true;
  const matches: CredentialValueMatch[] = [];
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (!viewScan && pattern.kind === "query_credential") continue;
    pattern.expression.lastIndex = 0;
    for (const match of text.matchAll(pattern.expression)) {
      if (!viewScan && pattern.viewsOnlyInUrlQuery && isInUrlQueryContext(text, match.index)) continue;
      const candidate = candidateValue(match, pattern.candidateGroups);
      if (documentedExampleKeys.has(candidate)) continue;
      const standsIn =
        pattern.candidateGroups === undefined
          ? holdsPlaceholderWord(candidate)
          : pattern.kind !== "session_cookie" && isExplicitCredentialPlaceholder(candidate);
      if (
        !candidate ||
        standsIn ||
        isUnquotedExpressionKeyword(match, pattern.candidateGroups) ||
        (pattern.kind === "session_cookie" && isExplicitCookiePlaceholderHeader(candidate)) ||
        (pattern.skipsCodeValues !== undefined &&
          isUnquotedCodeValue(match, pattern.skipsCodeValues, pattern.candidateGroups)) ||
        (pattern.keepsLabelValues === "prose"
          ? isLabelValue(candidate) && /\s/u.test(candidate.trim())
          : pattern.keepsLabelValues === true && isLabelValue(candidate)) ||
        (pattern.requiresOpaqueValue &&
          isUnquotedCandidate(match, pattern.candidateGroups) &&
          !looksLikeSecretValue(candidate) &&
          !(pattern.kind === "password_assignment" && isPassphrase(candidate))) ||
        (pattern.requiresHeaderValue &&
          isHeaderProse(candidate, text.slice(match.index + match[0].length)))
      ) {
        continue;
      }
      const start = match.index;
      matches.push({ kind: pattern.kind, start, end: start + match[0].length });
    }
  }
  for (const named of findNamedAssignmentMatches(text, viewScan)) {
    if (!matches.some((match) => match.start <= named.start && match.end >= named.end)) matches.push(named);
  }
  return matches;
}

export function containsCredentialValue(text: string, options: CredentialScanOptions = {}): boolean {
  return findCredentialValueMatches(text, options).length > 0;
}

const NAMED_ASSIGNMENT_HEAD =
  /(?<![A-Za-z0-9_.-])(?:-{1,2}|\\{0,7}["'])?([A-Za-z_][A-Za-z0-9_.-]{0,79})(?:\\*["'])?[ \t]*([:=])[ \t]*/g;
const NAMED_ASSIGNMENT_VALUE = /\\*"([^"\\\r\n]+)\\*"|\\*'([^'\\\r\n]+)\\*'|([^\s,;"'\\)\]}]+)/y;
const NAMED_ASSIGNMENT_QUERY_VALUE = /\\*"([^"\\\r\n]+)\\*"|\\*'([^'\\\r\n]+)\\*'|([^\s,;&#"'\\)\]}]+)/y;

function findNamedAssignmentMatches(text: string, viewScan: boolean): CredentialValueMatch[] {
  const matches: CredentialValueMatch[] = [];
  for (const head of text.matchAll(NAMED_ASSIGNMENT_HEAD)) {
    const name = head[1];
    if (name === undefined || !isSecretBearingFieldName(name) || !credentialNounStartsAWord(name)) continue;
    if (/public|publishable/iu.test(name)) continue;
    if (head[2] === "=" && text.charAt(head.index + head[0].length) === "=") continue;
    if (head[2] === ":" && endsInsideUrn(text, head.index)) continue;
    const inUrlQuery = isInUrlQueryContext(text, head.index);
    if (inUrlQuery && !viewScan) continue;
    const valueStart = head.index + head[0].length;
    const valueExpression = inUrlQuery ? NAMED_ASSIGNMENT_QUERY_VALUE : NAMED_ASSIGNMENT_VALUE;
    valueExpression.lastIndex = valueStart;
    const value = valueExpression.exec(text);
    if (value === null) continue;
    const literal = value[1] ?? value[2];
    const concrete = literal ?? value[3];
    if (concrete !== undefined && documentedExampleKeys.has(concrete)) continue;
    const joined =
      /^\s*\+/u.test(text.slice(valueStart + value[0].length)) ||
      (literal !== undefined && /^[\s,;:+]|[\s,;:+]$/u.test(literal));
    const hidden = joined
      ? false
      : literal !== undefined
        ? !isExplicitCredentialPlaceholder(literal) && !isLabelValue(literal)
        : value[3] !== undefined && isCredentialLookingBareValue(value[3], head[2] === ":");
    if (hidden) matches.push({ kind: "credential_assignment", start: head.index, end: valueStart + value[0].length });
  }
  return matches;
}

function credentialNounStartsAWord(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/giu, "").toLowerCase();
  const ending = secretFieldNameEndings
    .filter((candidate) => normalized.endsWith(candidate))
    .sort((left, right) => right.length - left.length)[0];
  if (!ending || ending === normalized) return true;
  let remaining = ending.length;
  let start = name.length;
  while (start > 0 && remaining > 0) {
    start -= 1;
    if (/[A-Za-z0-9]/u.test(name.charAt(start))) remaining -= 1;
  }
  if (start === 0) return true;
  const before = name.charAt(start - 1);
  if (!/[A-Za-z0-9]/u.test(before)) return true;
  if (!/[a-z]/u.test(name)) return true;
  const first = name.charAt(start);
  if (!/[A-Z]/u.test(first)) return false;
  return /[a-z0-9]/u.test(before) || /[a-z]/u.test(name.charAt(start + 1));
}

const URN_LOOKBACK_CHARACTERS = 256;
const URN_PREFIX = /(?<![\w.-])urn:[a-z0-9][a-z0-9-]{0,31}:(?:[\w.~%-]+:)*$/i;

function endsInsideUrn(text: string, index: number): boolean {
  return URN_PREFIX.test(text.slice(Math.max(0, index - URN_LOOKBACK_CHARACTERS), index));
}

function isCredentialLookingBareValue(value: string, _afterColon: boolean): boolean {
  if (
    isExplicitCredentialPlaceholder(value) ||
    isExpressionKeywordValue(value) ||
    isCodeOrReference(value) ||
    isLabelValue(value)
  ) {
    return false;
  }
  return looksLikeSecretValue(value);
}

function isLabelValue(value: string): boolean {
  return /^[\p{L} _-]+$/u.test(value) || /^[\p{L}_-]+(?:\.{3}|\u2026)$/u.test(value);
}

function isCodeOrReference(value: string): boolean {
  return /[()[\]{}]|=>|^\$|^%[^%]+%$/u.test(value) || isCredentialRead(value);
}

function isCredentialRead(value: string): boolean {
  return (
    /^[{[]/u.test(value) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*[([]/u.test(value) ||
    /^\$[({]/u.test(value) ||
    (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+!?$/u.test(value) && !/\d/u.test(value))
  );
}

function candidateValue(match: RegExpMatchArray, candidateGroups?: number[]): string {
  if (!candidateGroups) return match[0];
  for (const group of candidateGroups) {
    const value = match[group];
    if (value) return value;
  }
  return "";
}

const expressionKeywordValues = new Set([
  "await", "new", "null", "undefined", "true", "false", "this", "typeof", "void", "function", "async", "yield",
]);

function isUnquotedExpressionKeyword(match: RegExpMatchArray, candidateGroups?: number[]): boolean {
  const unquotedGroup = candidateGroups?.at(-1);
  if (unquotedGroup === undefined || candidateGroups === undefined || candidateGroups.length < 2) return false;
  const unquoted = match[unquotedGroup];
  return unquoted !== undefined && isExpressionKeywordValue(unquoted);
}

function isUnquotedCodeValue(
  match: RegExpMatchArray,
  floor: "code" | "reads",
  candidateGroups?: number[],
): boolean {
  const unquotedGroup = candidateGroups?.at(-1);
  if (unquotedGroup === undefined) return false;
  const unquoted = match[unquotedGroup];
  if (unquoted === undefined) return false;
  return floor === "code" ? isCodeOrReference(unquoted) : isCredentialRead(unquoted);
}

function isExpressionKeywordValue(unquoted: string): boolean {
  const leading = /^[A-Za-z_$][\w$]*/u.exec(unquoted)?.[0];
  return (
    leading !== undefined &&
    expressionKeywordValues.has(leading) &&
    (unquoted === leading || /^[.()[\]{}]/u.test(unquoted.slice(leading.length)))
  );
}

function isUnquotedCandidate(match: RegExpMatchArray, candidateGroups?: number[]): boolean {
  const unquotedGroup = candidateGroups?.at(-1);
  return unquotedGroup !== undefined && match[unquotedGroup] !== undefined;
}

function isPassphrase(value: string): boolean {
  return /^[A-Za-z]+(?:[-_.][A-Za-z]+){2,}$/u.test(value);
}

function isHeaderProse(value: string, after: string): boolean {
  const word = stripEdges(value, "", "`.,;:)");
  return (
    word === "" ||
    /^(?:\.\.\.|\u2026)/u.test(value) ||
    !/^[A-Za-z0-9]/u.test(word) ||
    /^(?:authentication|authorization|auth|token|tokens|credential|credentials|scheme|header|headers|prefix|format|string|value)$/iu.test(word) ||
    /^[a-z]+(?:\/[a-z]+)+$/u.test(word) ||
    (/^[A-Z][A-Z0-9_]*$/u.test(word) && word.includes("_")) ||
    /^(?:wrong|invalid|bad|expired|revoked)[-_]/iu.test(word) ||
    (/^[a-z-]+$/u.test(word) && /^[ \t]+[a-z]/u.test(after))
  );
}

function looksLikeSecretValue(value: string): boolean {
  const trimmed = stripEdges(value, QUOTE_CHARACTERS, `${QUOTE_CHARACTERS}.,;:)]}`);
  if (/^[A-Z][A-Z0-9_]*$/u.test(trimmed) && trimmed.includes("_")) return false;
  if (/^0x[0-9a-f]{1,16}$/iu.test(trimmed)) return false;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(trimmed)) return true;
  if (
    trimmed.length >= 6 &&
    /^[A-Za-z0-9][^\s<>|*]*$/u.test(trimmed) &&
    /[!@#%^&?~]/u.test(trimmed) &&
    /[A-Za-z]/u.test(trimmed)
  ) {
    return true;
  }
  if (!/\d/u.test(trimmed)) {
    const core = trimmed.replace(/=+$/u, "");
    return (
      core.length >= 12 &&
      /^[A-Za-z+/_-]+$/u.test(core) &&
      /[a-z]/u.test(core) &&
      /[A-Z]/u.test(core) &&
      !/^(?:[a-z]+|[A-Z]{0,5}[A-Z][a-z]{2,})(?:[A-Z][a-z]{2,})*$/u.test(core) &&
      !/^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*$/u.test(core)
    );
  }
  return (trimmed.length >= 6 && /[A-Za-z]/u.test(trimmed)) || /^\d{12,}$/u.test(trimmed);
}

/**
 * Words that mark a value as a stand-in: documented example keys,
 * `your-token-here`, `PLACEHOLDER_ONLY`, runs of x or *, a bare noun used as
 * the value, and obvious fixture words such as `fakekey`.
 */
const placeholderWordPattern =
  /(?:example|sample|placeholder|sentinel|dummy|redacted|changeme|replace[_-]?me|fakekey|(?<![A-Za-z0-9])fake(?!\w)|synthetic|(?<![A-Za-z0-9])(?:your|insert)[\s_-]|x{8,}|(?<![A-Za-z0-9])x{3,}(?![A-Za-z0-9])|\*{3,})/iu;

function holdsPlaceholderWord(token: string): boolean {
  return placeholderWordPattern.test(token);
}

const QUOTE_CHARACTERS = "\"'`";

function stripEdges(value: string, leading: string, trailing: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && leading.includes(value.charAt(start))) start += 1;
  while (end > start && trailing.includes(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

const placeholderNouns = new Set([
  "password", "passwd", "pass", "pwd", "secret", "token", "apikey", "api_key", "key", "credentials",
]);

const demonstrationPasswordPattern =
  /^(?:test|password|passwd|pass|secure|secret|admin|user|demo|default|guest|my|new|strong|weak|good|bad|example|sample|hunter)+\d*[!@#$%^&*.?]*$/iu;

function isPlaceholderShape(value: string, mayUnwrap = true): boolean {
  const raw = value.trim();
  if (/^["'`]?(?:[A-Za-z0-9_+/.=-]*[A-Za-z0-9_+/=-])?(?:\.\.\.|\u2026)[>"'`]?$/u.test(raw)) return true;
  if (/^\s*["'`]?\s*\+|\+\s*["'`\\]*$/u.test(raw)) return true;
  const word = stripEdges(raw, QUOTE_CHARACTERS, `${QUOTE_CHARACTERS}.,;`);
  if (holdsPlaceholderWord(word) || placeholderNouns.has(word.toLowerCase()) || demonstrationPasswordPattern.test(word)) {
    return true;
  }
  if (
    /^(?:\s*(?:\$\{[^}]*\}|\$\([^)]*\)|\$[a-z_][a-z0-9_]*|\$[A-Z_][A-Z0-9_]*|\$\d+))+\s*$/u.test(word)
  ) {
    return true;
  }
  if (/^(?:\{[\w.]*\}|%[sd]|\{\d*\})$/u.test(word)) return true;
  return isExplicitTemplatePlaceholder(value, mayUnwrap);
}

function isExplicitCredentialPlaceholder(value: string, mayUnwrap = true): boolean {
  return (
    isPlaceholderShape(value, mayUnwrap) ||
    isStandInValue(stripEdges(value.trim(), QUOTE_CHARACTERS, `${QUOTE_CHARACTERS}.,;`))
  );
}

function isStandInValue(word: string): boolean {
  if (/^\d{1,5}$/u.test(word)) return true;
  if (/^(?:<[^<>]+>[_.:/-]?)+$/u.test(word) || /^[a-z]+(?:[-_][a-z]+)*[-_]\d{1,3}$/u.test(word)) return true;
  if (
    /^(?:secret|password|passwd|pass|token|admin|test)\d*$/iu.test(
      word.replace(/[013457]/gu, (digit) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" })[digit] ?? digit),
    )
  ) {
    return true;
  }
  if (/\{\{[^{}]*\}\}/u.test(word) && !/\d{4}/u.test(word.replace(/\{\{[^{}]*\}\}/gu, ""))) return true;
  if (/\[\^|\\[sdwSDW]|\(\?[:=!<]/u.test(word)) return true;
  if (/^(?:~|\.{1,2})?\/(?:[\w.-]+\/)+[\w.-]*$/u.test(word) || word.includes("/path/to/")) return true;
  if (/^[~^<>=]*\d+\.\d+\.\d+/u.test(word)) return true;
  const segments = word.split(/[_-]/u);
  if (
    /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/u.test(word) &&
    segments.every((segment) => /^(?:[a-z]+|base64|\d{1,3})$/u.test(segment)) &&
    segments.some((segment) => /^(?:secret|token|key|password|passwd|apikey|pass|credentials?)$/u.test(segment)) &&
    segments.some((segment) => /^(?:base64|encoded|hex|test|demo|my|some)$/u.test(segment))
  ) {
    return true;
  }
  if (/^(.)\1{5,}$/u.test(word.replace(/-/gu, "")) || /^(?:0?123456789?0?|1234567)$/u.test(word) || /^abc123$/iu.test(word)) {
    return true;
  }
  return false;
}

function isExplicitTemplatePlaceholder(value: string, mayUnwrap: boolean): boolean {
  const normalized = stripEdges(value.trim(), QUOTE_CHARACTERS, `${QUOTE_CHARACTERS}.,;`);
  if (mayUnwrap) {
    const assignedValue = (/^[^=;\s]+\s*=\s*(.+)$/u.exec(normalized))?.[1];
    if (assignedValue && assignedValue !== normalized) return isPlaceholderShape(assignedValue, false);
    const schemeValue = (/^[A-Za-z][A-Za-z0-9_-]*\s+(\S+)$/u.exec(normalized))?.[1];
    if (schemeValue) return isExplicitCredentialPlaceholder(schemeValue, false);
  }
  return (
    /^\$\{[A-Z0-9_]+\}$/iu.test(normalized) ||
    /^\$[A-Z_][A-Z0-9_]*$/u.test(normalized) ||
    /^\$env:[A-Z_][A-Z0-9_]*$/iu.test(normalized) ||
    /^%[A-Z_][A-Z0-9_]*%$/iu.test(normalized) ||
    /^<[A-Z0-9_ -]+>$/iu.test(normalized) ||
    /^YOUR_[A-Z0-9_]+$/iu.test(normalized) ||
    /^(?:process\.)?env\.[A-Z0-9_]+$/iu.test(normalized) ||
    /^\[REDACTED\]$/iu.test(normalized) ||
    /^(?:REPLACE_ME|CHANGEME|EXAMPLE_VALUE)$/iu.test(normalized)
  );
}

function isExplicitCookiePlaceholderHeader(value: string): boolean {
  return value.split(";").every((pair) => {
    const assigned = (/^[^=\s]+\s*=\s*(.+)$/u.exec(pair.trim()))?.[1];
    if (!assigned) return false;
    const placeholderPrefix = (
      /^(\$\{[A-Z0-9_]+\}|<[A-Z0-9_ -]+>|YOUR_[A-Z0-9_]+|(?:process\.)?env\.[A-Z0-9_]+|\[REDACTED\])/iu.exec(assigned)
    )?.[1];
    return Boolean(placeholderPrefix && isExplicitCredentialPlaceholder(placeholderPrefix));
  });
}

/**
 * Whether a field name says its value is a credential, whatever that value
 * looks like. A credential noun at the end of the name (`dbPassword`,
 * `X-Auth-Token`, `client_secret`), a noun plus a carrying word
 * (`tokenValue`), a list of credentials (`accessTokens`), or a few whole names.
 */
export function isSecretBearingFieldName(key: string): boolean {
  const name = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (name.length === 0 || paginationCursorFieldNames.has(name)) return false;
  return (
    secretFieldNames.has(name) ||
    secretFieldNameEndings.some((ending) => name.endsWith(ending)) ||
    credentialNounWithValueWord.test(name) ||
    credentialTokenList.test(name)
  );
}

const credentialNounWithValueWord =
  /(?:secret|token|apikey|password|passwd|passphrase|credential|cookie|privatekey|accesskey)s?(?:value|header|pem|plain|plaintext|json|raw|confirmation)$/u;

const credentialTokenList = /(?:access|refresh|auth|api|session|bearer|csrf|xsrf)tokens$/u;

const paginationCursorFieldNames: ReadonlySet<string> = new Set([
  "nextpagetoken", "pagetoken", "nexttoken", "synctoken", "continuationtoken",
]);

const secretFieldNames: ReadonlySet<string> = new Set([
  "jwt", "bearer", "pkceverifier", "codeverifier", "grantref", "ciphertext", "share",
  "authorizationlink", "authorizationcode", "authorizationheader",
]);

const secretFieldNameEndings: readonly string[] = [
  "secret", "secrets", "token", "apikey", "apikeys", "secretkey", "accesskey", "privatekey", "privatekeys",
  "password", "passwords", "passwd", "passphrase", "passcode", "passwordhash", "credential", "credentials",
  "authorization", "cookie", "cookies",
];
