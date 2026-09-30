/**
 * Converter: text → LaTeX prin AI (Groq). Singurul modul care apelează AI-ul.
 * Clientul e inițializat leneș, ca testele să nu aibă nevoie de GROQ_API_KEY.
 */
import Groq from "groq-sdk";
import { GROQ_MODEL, NO_MULTIPLICATION_ADDENDUM, RULES } from "./rules";
import type { Issue } from "./validator";

let groq: Groq | null = null;

function client(): Groq {
  if (!groq) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY nu este definită în .env");
    groq = new Groq({ apiKey });
  }
  return groq;
}

export function cleanLatex(raw: string): string {
  let latex = raw.trim();

  latex = latex
    .replace(/^```latex\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Eliminăm delimitatorii dacă modelul i-a pus totuși
  latex = latex
    .replace(/^\\\[\s*/, "")
    .replace(/\s*\\\]$/, "")
    .replace(/^\$\$\s*/, "")
    .replace(/\s*\$\$$/, "")
    .replace(/^\$\s*/, "")
    .replace(/\s*\$$/, "")
    .trim();

  return latex;
}

export type ConvertOptions = {
  /** Overline bifat: interzice \cdot între cifre (numere periodice). */
  suppressMultiplication?: boolean;
  /** Erorile validatorului din încercarea anterioară (§21: retry cu eroarea concretă). */
  previousIssues?: Issue[];
};

export type TextToLatex = (text: string, opts?: ConvertOptions) => Promise<string>;

export const textToLatex: TextToLatex = async (text, opts = {}) => {
  const systemPrompt = opts.suppressMultiplication
    ? RULES + NO_MULTIPLICATION_ADDENDUM
    : RULES;

  const messages: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ];

  if (opts.previousIssues && opts.previousIssues.length > 0) {
    const errors = opts.previousIssues
      .map((i) => `ERROR: ${i.message}\nRULE: ${i.code}`)
      .join("\n\n");
    messages.push({
      role: "user",
      content: `Rezultatul anterior a fost respins de validator:\n\n${errors}\n\nREGENERATE respectând regulile. Returnează doar LaTeX.`,
    });
  }

  const response = await client().chat.completions.create({
    model: GROQ_MODEL,
    temperature: 0,
    messages,
  });

  const raw = response.choices[0]?.message?.content || "";
  return cleanLatex(raw);
};
