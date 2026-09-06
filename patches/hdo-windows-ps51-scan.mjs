/**
 * Static Windows PowerShell 5.1 expandable-string scanners.
 * Used by Owner-path gates so Linux pwsh is not the only parser.
 */

function skipLineComment(source, i) {
  while (i < source.length && source[i] !== "\n") i += 1;
  return i;
}

function skipSingleQuoted(source, i) {
  i += 1;
  while (i < source.length) {
    if (source[i] === "'") {
      if (source[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return i;
}

function skipLiteralHereString(source, i) {
  const nl = source.indexOf("\n", i);
  if (nl < 0) return source.length;
  const end = source.indexOf("\n'@", nl);
  return end < 0 ? source.length : end + 3;
}

function scanExpandable(source, file, start, end, errors) {
  let i = start;
  while (i < end) {
    if (source[i] === "`") {
      i += 2;
      continue;
    }
    if (source[i] !== "$") {
      i += 1;
      continue;
    }
    const next = source[i + 1];
    if (next === "{" || next === "(") {
      i += 2;
      continue;
    }
    if (!next || !/[A-Za-z_]/.test(next)) {
      i += 1;
      continue;
    }
    let j = i + 2;
    while (j < end && /[A-Za-z0-9_]/.test(source[j])) j += 1;
    if (source[j] === ":") {
      const after = source[j + 1];
      if (!after || !/[A-Za-z_?]/.test(after)) {
        const snippet = source.slice(i, Math.min(end, j + 6)).replace(/\s+/g, " ");
        errors.push(`${file}: Windows PowerShell 5.1 rejects scoped expansion ${JSON.stringify(snippet)}`);
      }
    } else if (source[j] === "." && /[a-z]/.test(source[j + 1] ?? "")) {
      let k = j + 1;
      while (k < end && /[A-Za-z0-9_]/.test(source[k])) k += 1;
      const member = source.slice(j + 1, k);
      if (member.includes("_") || member === "ownerdecision") {
        const snippet = source.slice(i, Math.min(end, k + 4)).replace(/\s+/g, " ");
        errors.push(
          `${file}: expandable $var.literal is member access; use \${var}.literal (${JSON.stringify(snippet)})`,
        );
      }
    }
    i = j;
  }
}

export function findPs51ExpandableScopeErrors(source, file) {
  const errors = [];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<#", i)) {
      const end = source.indexOf("#>", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source[i] === "#" && (i === 0 || source[i - 1] === "\n" || /\s/.test(source[i - 1]))) {
      i = skipLineComment(source, i);
      continue;
    }
    if (source.startsWith("@'", i)) {
      i = skipLiteralHereString(source, i);
      continue;
    }
    if (source.startsWith('@"', i)) {
      const nl = source.indexOf("\n", i);
      if (nl < 0) break;
      const end = source.indexOf('\n"@', nl);
      const close = end < 0 ? source.length : end;
      scanExpandable(source, file, nl + 1, close, errors);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[i] === "'") {
      i = skipSingleQuoted(source, i);
      continue;
    }
    if (source[i] === '"') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "`") {
          j += 2;
          continue;
        }
        if (source[j] === '"') break;
        j += 1;
      }
      scanExpandable(source, file, i + 1, j, errors);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return errors;
}

export function findInlineNodeEHazards(source, file) {
  const errors = [];
  if (/\bnode\s+-e\b/.test(source)) {
    errors.push(`${file}: uses inline node -e (PowerShell can rewrite quoting)`);
  }
  return errors;
}
