/**
 * Validator determinist LaTeX — Etapa 1.
 * Nu folosește AI. Verifică regulile proiectului (§8, §9 din brief) și
 * fidelitatea față de sursă. Rezultat: OK / REVIEW / ERROR + lista de probleme.
 */

export type Severity = "error" | "review";

export type Issue = {
  code:
    | "QUAD"
    | "TIMES"
    | "UNICODE_TIMES"
    | "TEXT_CMD"
    | "LEFT_BRACE"
    | "RIGHT_BRACE"
    | "UNBALANCED_BRACES"
    | "UNBALANCED_PARENS"
    | "ALIGNED_STRUCTURE"
    | "DELIMITERS"
    | "MARKDOWN_FENCE"
    | "STYLE_CMD"
    | "NUMBER_MISMATCH"
    | "OPERATOR_MISMATCH"
    | "IDENT_MISMATCH"
    | "EMPTY";
  severity: Severity;
  message: string;
  /** Sugestie de corecție deterministă, dacă există. */
  fix?: string;
};

export type ValidationStatus = "OK" | "REVIEW" | "ERROR";

export type ValidationResult = {
  status: ValidationStatus;
  issues: Issue[];
  /** LaTeX după corecțiile deterministe sigure (\times→\cdot, \left\{→\{ etc.). */
  fixedLatex: string;
};

// ───────────────────────── corecții sigure (auto-fix) ─────────────────────────

/** Corecții care nu pot schimba sensul matematic; se aplică întotdeauna. */
export function autoFix(latex: string): { latex: string; applied: string[] } {
  const applied: string[] = [];
  let out = latex;

  const rules: Array<[RegExp, string, string]> = [
    [/\\times\b/g, "\\cdot", "\\times → \\cdot"],
    [/×/g, "\\cdot", "× → \\cdot"],
    [/\\left\\\{/g, "\\{", "\\left\\{ → \\{"],
    [/\\right\\\}/g, "\\}", "\\right\\} → \\}"],
    [/\\left\\lbrace/g, "\\{", "\\left\\lbrace → \\{"],
    [/\\right\\rbrace/g, "\\}", "\\right\\rbrace → \\}"],
    [/\\quad/g, "\\ ", "\\quad → \\ "],
    [/\\qquad/g, "\\ ", "\\qquad → \\ "],
    [/\\emptyset/g, "\\varnothing", "\\emptyset → \\varnothing"],
    // \text{cm} / \text{cateta}_1 → cm / cateta_1 (regula 6 + 16)
    [/\\text\{(cm|mm|dm|m|km|cateta|ipotenuza|ipotenuză)\}/g, "$1", "\\text{unitate} → unitate"],
  ];

  for (const [re, rep, label] of rules) {
    if (re.test(out)) {
      out = out.replace(re, rep);
      applied.push(label);
    }
  }
  return { latex: out, applied };
}

// ───────────────────────── verificări structurale ─────────────────────────

function checkBalanced(
  s: string,
  open: string,
  close: string,
): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const escaped = i > 0 && s[i - 1] === "\\";
    if (c === open && !escaped) depth++;
    else if (c === close && !escaped) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function checkAligned(latex: string): Issue[] {
  const issues: Issue[] = [];
  const opens = (latex.match(/\\begin\{aligned\}/g) || []).length;
  const closes = (latex.match(/\\end\{aligned\}/g) || []).length;
  if (opens !== closes) {
    issues.push({
      code: "ALIGNED_STRUCTURE",
      severity: "error",
      message: `\\begin{aligned} (${opens}) ≠ \\end{aligned} (${closes})`,
    });
    return issues;
  }
  if (opens > 0) {
    const body = latex.replace(/[\s\S]*\\begin\{aligned\}/, "").replace(/\\end\{aligned\}[\s\S]*/, "");
    const rows = body.split(/\\\\/).map((r) => r.trim()).filter(Boolean);
    const bad = rows.filter((r) => (r.match(/(?<!\\)&/g) || []).length > 1);
    if (bad.length) {
      issues.push({
        code: "ALIGNED_STRUCTURE",
        severity: "review",
        message: `Rând(uri) aligned cu mai mult de un "&": ${bad.length}`,
      });
    }
    if (rows.length < 2) {
      issues.push({
        code: "ALIGNED_STRUCTURE",
        severity: "review",
        message: "aligned cu un singur rând — probabil nu era necesar",
      });
    }
  }
  return issues;
}

// ───────────────────────── fidelitate față de sursă ─────────────────────────

const SUPERSCRIPTS: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };
const SUBSCRIPTS: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };

/** Normalizează sursa Unicode astfel încât să fie comparabilă cu LaTeX. */
export function normalizeSource(s: string): string {
  return s
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => "^" + SUPERSCRIPTS[c])
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => "_" + SUBSCRIPTS[c])
    .replace(/\u00a0/g, " ")
    // regula 23: "3\4" (backslash între numere) înseamnă fracție → o tratăm ca "/"
    .replace(/(\d)\\(\d)/g, "$1/$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrage numerele (inclusiv zecimale cu . sau ,) dintr-un text. */
function numbers(s: string): string[] {
  return (s.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "."));
}

const OP_MAP: Array<[RegExp, string]> = [
  [/\\cdot|×|\*/g, "*"],
  [/\\frac|\\div|÷|\/|:/g, "/"], // \frac{a}{b} ≙ a/b, a:b, a÷b (regula 21)
  [/\\pm|±/g, "±"],
  [/\\le\b|\\leq\b|≤/g, "≤"],
  [/\\ge\b|\\geq\b|≥/g, "≥"],
  [/\\ne\b|\\neq\b|≠/g, "≠"],
  [/\\sqrt|√/g, "√"],
];

function opSignature(s: string): Record<string, number> {
  const sig: Record<string, number> = {};
  for (const [re, key] of OP_MAP) {
    sig[key] = (s.match(re) || []).length;
  }
  sig["="] = (s.match(/(?<!\\[a-z]*)=/g) || []).length;
  sig["+"] = (s.match(/\+/g) || []).length;
  return sig;
}

function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function fidelityIssues(rawSource: string, latex: string): Issue[] {
  const issues: Issue[] = [];
  const source = normalizeSource(rawSource);

  const nSrc = numbers(source);
  const nOut = numbers(latex);
  if (!multisetEqual(nSrc, nOut)) {
    issues.push({
      code: "NUMBER_MISMATCH",
      severity: "review",
      message: `Numere sursă [${nSrc.join(", ")}] ≠ numere LaTeX [${nOut.join(", ")}]`,
    });
  }

  const oSrc = opSignature(source);
  const oOut = opSignature(latex);
  const diff = Object.keys(oSrc).filter((k) => oSrc[k] !== oOut[k]);
  // "/" tolerant: "a:b" poate deveni "\frac{a}{b}" — semnătura le unifică deja.
  if (diff.length) {
    issues.push({
      code: "OPERATOR_MISMATCH",
      severity: "review",
      message: `Operatori diferiți față de sursă: ${diff.map((k) => `${k} ${oSrc[k]}→${oOut[k]}`).join(", ")}`,
    });
  }

  return issues;
}

// ───────────────────────── validare completă ─────────────────────────

export function validateLatex(source: string, rawLatex: string): ValidationResult {
  const issues: Issue[] = [];

  if (!rawLatex || !rawLatex.trim()) {
    return { status: "ERROR", issues: [{ code: "EMPTY", severity: "error", message: "LaTeX gol" }], fixedLatex: "" };
  }

  if (/```/.test(rawLatex)) {
    issues.push({ code: "MARKDOWN_FENCE", severity: "error", message: "Conține ``` (Markdown)" });
  }
  if (/^\s*(\$\$?|\\\[)/.test(rawLatex) || /(\$\$?|\\\])\s*$/.test(rawLatex)) {
    issues.push({ code: "DELIMITERS", severity: "error", message: "Conține delimitatori $ / \\[ \\]" });
  }

  // Raportăm încălcările regulilor ÎNAINTE de auto-fix (pentru metrici + feedback AI)
  const before = rawLatex;
  if (/\\quad|\\qquad/.test(before)) issues.push({ code: "QUAD", severity: "review", message: "Conține \\quad", fix: "înlocuit cu \\ " });
  if (/\\times\b/.test(before)) issues.push({ code: "TIMES", severity: "review", message: "Conține \\times", fix: "înlocuit cu \\cdot" });
  if (/×/.test(before)) issues.push({ code: "UNICODE_TIMES", severity: "review", message: "Conține ×", fix: "înlocuit cu \\cdot" });
  if (/\\left\\\{|\\left\\lbrace/.test(before)) issues.push({ code: "LEFT_BRACE", severity: "review", message: "Conține \\left\\{", fix: "înlocuit cu \\{" });
  if (/\\right\\\}|\\right\\rbrace/.test(before)) issues.push({ code: "RIGHT_BRACE", severity: "review", message: "Conține \\right\\}", fix: "înlocuit cu \\}" });
  if (/\\text\{(cm|mm|dm|m|km|cateta|ipotenuza|ipotenuză)\}/.test(before)) {
    issues.push({ code: "TEXT_CMD", severity: "review", message: "\\text{} folosit pentru unitate/cateta/ipotenuza", fix: "eliminat \\text{}" });
  }
  if (/\\(mathbf|boldsymbol|textbf|emph|mathit|underline)\b/.test(before)) {
    issues.push({ code: "STYLE_CMD", severity: "review", message: "Comandă de stil adăugată de AI (stilul e controlat de aplicație)" });
  }

  const { latex: fixed } = autoFix(before);

  if (!checkBalanced(fixed, "{", "}")) issues.push({ code: "UNBALANCED_BRACES", severity: "error", message: "Acolade { } neechilibrate" });
  if (!checkBalanced(fixed, "(", ")")) issues.push({ code: "UNBALANCED_PARENS", severity: "error", message: "Paranteze ( ) neechilibrate" });
  if (!checkBalanced(fixed, "[", "]")) issues.push({ code: "UNBALANCED_PARENS", severity: "error", message: "Paranteze [ ] neechilibrate" });

  issues.push(...checkAligned(fixed));
  issues.push(...fidelityIssues(source, fixed));

  // Problemele cu `fix` au fost deja corectate → nu mai blochează, dar rămân în raport.
  const blocking = issues.filter((i) => !i.fix);
  const status: ValidationStatus = blocking.some((i) => i.severity === "error")
    ? "ERROR"
    : blocking.some((i) => i.severity === "review")
      ? "REVIEW"
      : "OK";

  return { status, issues, fixedLatex: fixed };
}

// ───────────────────────── confidence v0 (necalibrat) ─────────────────────────

export type ConfidenceInputs = {
  validation: ValidationResult;
  rendered: boolean;
  cacheHit: boolean;
  aiAttempts: number;
};

/**
 * Scor euristic în [0,1]. NU este o probabilitate calibrată (vezi §10 din brief).
 * Devine calibrabil după ce avem date din review (accept/reject per scor).
 */
export function confidenceScore(inp: ConfidenceInputs): number {
  let score = 1.0;
  if (!inp.rendered) return 0;
  if (inp.validation.status === "ERROR") return 0;
  for (const issue of inp.validation.issues) {
    if (issue.fix) score -= 0.01; // corectat determinist — penalizare mică
    else if (issue.severity === "review") score -= 0.15;
  }
  score -= 0.05 * Math.max(0, inp.aiAttempts - 1);
  if (inp.cacheHit) score = Math.max(score, 0.99); // deja aprobat anterior
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}
