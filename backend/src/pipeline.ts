/**
 * Pipeline-ul unei formule (§26, §28 — determinist înainte de AI):
 *   cache → AI → autoFix + validator → (retry cu eroarea concretă) → render → confidence → status
 * Dependențele (AI, render, cache) sunt injectabile ca să putem testa fără Groq.
 */
import { ConversionCache, cacheKey } from "./cache";
import type { TextToLatex } from "./converter";
import type { RenderMode, Rendered } from "./renderer";
import {
  confidenceScore,
  validateLatex,
  type Issue,
  type ValidationResult,
} from "./validator";

export type Placement = "inline" | "block" | "multiline";

export type BatchItem = {
  id: string;
  source: string;
  fontSize?: number;
  placement?: Placement;
  suppressMultiplication?: boolean;
};

export type ItemStatus = "OK" | "REVIEW" | "ERROR";

export type BatchResult = {
  id: string;
  status: ItemStatus;
  confidence: number;
  latex: string;
  svg?: string;
  pngDataUrl?: string;
  width?: number;
  height?: number;
  validation: ValidationResult;
  issues: Issue[];
  aiCalls: number;
  cacheHit: boolean;
  attempts: number;
  processingMs: number;
  errorType?: "CONVERSION_ERROR" | "VALIDATION_ERROR" | "RENDER_ERROR";
  error?: string;
};

export type PipelineConfig = {
  /** Sub acest scor → REVIEW (§10, configurabil). */
  autoThreshold: number;
  maxAttempts: number;
  defaultFontSize: number;
};

export const defaultConfig: PipelineConfig = {
  autoThreshold: Number(process.env.AUTO_THRESHOLD ?? 0.95),
  maxAttempts: 2,
  defaultFontSize: 24,
};

export type PipelineDeps = {
  textToLatex: TextToLatex;
  render: (latex: string, fontSize: number, mode: RenderMode) => Promise<Rendered & { pngDataUrl?: string }>;
  cache: ConversionCache;
  config?: Partial<PipelineConfig>;
};

function renderMode(p: Placement | undefined): RenderMode {
  return p === "inline" ? "inline" : "display";
}

export async function convertOne(item: BatchItem, deps: PipelineDeps): Promise<BatchResult> {
  const cfg = { ...defaultConfig, ...deps.config };
  const started = Date.now();
  const fontSize = item.fontSize ?? cfg.defaultFontSize;
  const key = cacheKey(item.source, item.suppressMultiplication);

  let latex = "";
  let validation: ValidationResult;
  let aiCalls = 0;
  let attempts = 0;
  let cacheHit = false;

  const cached = deps.cache.get(key);
  if (cached) {
    cacheHit = true;
    latex = cached.latex;
    validation = cached.validation;
  } else {
    let issues: Issue[] = [];
    validation = validateLatex(item.source, "");
    try {
      for (attempts = 1; attempts <= cfg.maxAttempts; attempts++) {
        aiCalls++;
        const raw = await deps.textToLatex(item.source, {
          suppressMultiplication: item.suppressMultiplication,
          previousIssues: issues,
        });
        validation = validateLatex(item.source, raw);
        if (validation.status !== "ERROR") break;
        issues = validation.issues.filter((i) => !i.fix);
      }
    } catch (err: any) {
      return {
        id: item.id, status: "ERROR", confidence: 0, latex: "", validation,
        issues: validation.issues, aiCalls, cacheHit, attempts,
        processingMs: Date.now() - started,
        errorType: "CONVERSION_ERROR", error: err?.message || String(err),
      };
    }
    latex = validation.fixedLatex;
  }

  if (!latex || validation.status === "ERROR") {
    return {
      id: item.id, status: "ERROR", confidence: 0, latex, validation,
      issues: validation.issues, aiCalls, cacheHit, attempts,
      processingMs: Date.now() - started,
      errorType: "VALIDATION_ERROR",
      error: validation.issues.filter((i) => !i.fix).map((i) => i.message).join("; ") || "LaTeX gol",
    };
  }

  let rendered: (Rendered & { pngDataUrl?: string }) | undefined;
  try {
    rendered = await deps.render(latex, fontSize, renderMode(item.placement));
  } catch (err: any) {
    return {
      id: item.id, status: "ERROR", confidence: 0, latex, validation,
      issues: validation.issues, aiCalls, cacheHit, attempts,
      processingMs: Date.now() - started,
      errorType: "RENDER_ERROR", error: err?.message || "LaTeX-ul nu a putut fi randat",
    };
  }

  const confidence = confidenceScore({ validation, rendered: true, cacheHit, aiAttempts: Math.max(1, attempts) });
  const status: ItemStatus =
    confidence >= cfg.autoThreshold && validation.status === "OK" ? "OK" : "REVIEW";

  if (status === "OK" && !cacheHit) {
    deps.cache.set(key, { latex, validation, approvedAt: new Date().toISOString(), origin: "auto" });
  }

  return {
    id: item.id, status, confidence, latex,
    svg: rendered.svg, pngDataUrl: rendered.pngDataUrl,
    width: rendered.widthPx, height: rendered.heightPx,
    validation, issues: validation.issues, aiCalls, cacheHit, attempts,
    processingMs: Date.now() - started,
  };
}

/** Rulează item-urile cu cel mult `concurrency` în paralel, păstrând ordinea. */
export async function convertBatch(
  items: BatchItem[],
  deps: PipelineDeps,
  concurrency = 4,
): Promise<BatchResult[]> {
  const results: BatchResult[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await convertOne(items[i]!, deps);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function summarize(results: BatchResult[]) {
  return {
    total: results.length,
    ok: results.filter((r) => r.status === "OK").length,
    review: results.filter((r) => r.status === "REVIEW").length,
    error: results.filter((r) => r.status === "ERROR").length,
    aiCalls: results.reduce((n, r) => n + r.aiCalls, 0),
    cacheHits: results.filter((r) => r.cacheHit).length,
    avgProcessingMs: results.length
      ? Math.round(results.reduce((n, r) => n + r.processingMs, 0) / results.length)
      : 0,
  };
}
