/** Дописывает недостающие `}` / `]` с учётом вложенности (вне строковых литералов). */
export function balanceJsonBrackets(s: string): string {
  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1];
      if (top === ch) stack.pop();
    }
  }

  return s + stack.reverse().join('');
}
