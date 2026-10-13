/**
 * The text rules of optchat_memory/redaction.py, for text that reaches the Master without passing
 * through a node, such as T3 Code thread messages. Gitleaks, the export gate there, does not run
 * in a Worker.
 */
const MARKER = "[REDACTED]";
const SECRET_NAME_ANY_CASE =
  /^(?:authorization|proxy.?authorization|cookie|set.?cookie|password|passwd|pwd|secret|client.?secret|private.?key|api.?key|open.?ai.?key|access.?token|refresh.?token|id.?token|auth.?token|bearer.?token|token|credential|credentials|[\w.-]+[_-](?:api[_-]?key|token|password|passwd|secret|private[_-]?key))$/i;
const SECRET_NAME_CAMEL =
  /^[A-Za-z][A-Za-z0-9]*(?:Token|Password|Secret|APIKey|ApiKey|PrivateKey)$/;
const PATTERNS: [RegExp, string][] = [
  [
    // A key cut off before its end line, as a truncated message is, is redacted to the end.
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g,
    MARKER,
  ],
  [
    /\b(?:sk-(?:proj-|ant-[\w-]+-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/g,
    MARKER,
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, MARKER],
  [/\bBearer\s+[A-Za-z0-9_+./=-]{16,}/gi, MARKER],
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, `$1${MARKER}$2`],
];
const BASIC = /\bBasic\s+([A-Za-z0-9+/]+={0,2})(?![\w+/=-])/gi;
const ASSIGNMENT =
  /(?<![\w.-])(?<prefix>["']?(?<name>[A-Z_][\w.-]*)["']?\s*(?::|=|→|->)\s*)(?<value>"[^"\n]*"|'[^'\n]*'|[^\s,;\]}]+)/gim;

const secretName = (name: string): boolean =>
  SECRET_NAME_ANY_CASE.test(name) || SECRET_NAME_CAMEL.test(name);

export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  result = result.replace(BASIC, (match, encoded: string) => {
    try {
      return atob(encoded).includes(":") ? MARKER : match;
    } catch {
      return match;
    }
  });
  return result.replace(ASSIGNMENT, (match, prefix: string, name: string, value: string) => {
    // A value an earlier rule redacted stays as it is.
    if (!secretName(name) || value.startsWith(MARKER.slice(0, -1))) return match;
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
    return prefix + quote + MARKER + quote;
  });
}
