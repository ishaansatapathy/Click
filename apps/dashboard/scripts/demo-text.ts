// The demo repository (v3-admin-vite) is written by a Chinese-speaking team, so its comments are in Chinese. The Try page shows the code an
// agent would receive, and a reader who cannot read Chinese sees noise. This blanks the TEXT of comments that contain CJK characters
// and nothing else: string literals (UI labels, sample data) are code and stay as they are.
//
// The line count never changes: demo.json carries a graph whose symbols point at line ranges of these files, and the engine in the browser
// cuts code out by those ranges. Deleting a line would make every symbol after it point at the wrong code.

const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;

/** Index of a `//` that starts a comment on this line (not inside a string, not part of `://`), or -1. */
function lineCommentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') return i;
  }
  return -1;
}

export function blankCjkComments(text: string): string {
  let inBlock = false;
  let inHtml = false;
  return text
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      const indent = line.slice(0, line.length - t.length);
      const wasBlock = inBlock;
      const wasHtml = inHtml;
      if (/\/\*/.test(t) && !/\*\//.test(t.slice(t.indexOf('/*') + 2))) inBlock = true;
      if (/\*\//.test(t)) inBlock = false;
      if (/<!--/.test(t) && !/-->/.test(t.slice(t.indexOf('<!--') + 4))) inHtml = true;
      if (/-->/.test(t)) inHtml = false;
      if (!CJK.test(line)) return line;
      if (!wasBlock && inBlock) return line.replace(/(\/\*+)[^]*$/, '$1'); // `/* 中文` opens a block: keep only the opener
      if (wasBlock) return /\*\//.test(t) ? `${indent}*/` : `${indent}*`; // inside, or the closing line of, /* ... */
      if (!wasHtml && inHtml) return line.replace(/(<!--)[^]*$/, '$1');
      if (wasHtml) return /-->/.test(t) ? `${indent}-->` : indent;
      if (t.startsWith('//')) return `${indent}//`;
      if (t.startsWith('/*') || t.startsWith('<!--')) return line.replace(/(\/\*+|<!--)\s*[^]*?(\*\/|-->|$)/, (_m, open: string, close: string) => `${open}${close}`);
      const at = lineCommentStart(line);
      if (at >= 0 && CJK.test(line.slice(at))) return line.slice(0, at).trimEnd();
      return line; // CJK inside a string or template text: it is the code, leave it
    })
    .join('\n');
}
