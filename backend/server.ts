import "dotenv/config";

import express from "express";
import cors from "cors";

import { createCanvaJwtMiddleware } from "./src/auth";
import { ConversionCache, defaultCacheFile } from "./src/cache";
import { textToLatex } from "./src/converter";
import {
  convertBatch,
  convertOne,
  summarize,
  type BatchItem,
  type PipelineDeps,
} from "./src/pipeline";
import { latexToSvg, render, svgToPngDataUrl } from "./src/renderer";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

if (!process.env.GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY nu este definită în .env");
}

const requireCanvaJwt = createCanvaJwtMiddleware(process.env.CANVA_APP_ID);

const cache = new ConversionCache(defaultCacheFile);
const deps: PipelineDeps = { textToLatex, render, cache };

// Aplică \overline / \bf / \it peste LaTeX-ul deja generat (stil controlat
// de aplicație, nu de AI — regula 19).
function applyStyle(
  latex: string,
  bold: boolean,
  italic: boolean,
  overline: boolean,
): string {
  let styled = latex;
  if (overline) styled = `\\overline{${styled}}`;
  if (bold) styled = `{\\bf ${styled}}`;
  if (italic) styled = `{\\it ${styled}}`;
  return styled;
}

app.get("/api/health", (_req, res) => {
  return res.json({ ok: true, cache: cache.stats() });
});

// ─────────────────────────────────────────────
// Endpoint 1: text → LaTeX (fără randare)
// ─────────────────────────────────────────────
app.post("/api/latex", requireCanvaJwt, async (req, res) => {
  try {
    const text = req.body?.text;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Text invalid." });
    }

    const result = await convertOne(
      { id: "single", source: text, placement: "block" },
      { ...deps, render: async (latex, fontSize, mode) => latexToSvg(latex, fontSize, mode) },
    );

    console.log("INPUT:", text);
    console.log("LATEX:", result.latex, "| status:", result.status, "| cache:", result.cacheHit);

    if (result.status === "ERROR") {
      return res.status(422).json({ error: result.error, latex: result.latex, validation: result.validation });
    }
    return res.json({
      latex: result.latex,
      status: result.status,
      confidence: result.confidence,
      validation: result.validation,
      attempts: result.attempts,
      cacheHit: result.cacheHit,
    });
  } catch (error: any) {
    console.error("LATEX ERROR:", error);
    return res.status(500).json({ error: error?.message || "Eroare la generarea LaTeX." });
  }
});

// ─────────────────────────────────────────────
// Endpoint 2: text → LaTeX → validare → PNG (contractul vechi + validation)
// ─────────────────────────────────────────────
app.post("/api/render", requireCanvaJwt, async (req, res) => {
  try {
    const text = req.body?.text;
    const fontSize = Number(req.body?.fontSize) || 24;
    const bold = !!req.body?.bold;
    const italic = !!req.body?.italic;
    const overline = !!req.body?.overline;
    const placement = req.body?.placement === "inline" ? "inline" : "block";

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Text invalid." });
    }

    // Conversie + validare (fără randare aici: stilul se aplică înainte de randare)
    const converted = await convertOne(
      { id: "single", source: text, fontSize, placement, suppressMultiplication: overline },
      { ...deps, render: async (latex, fs, mode) => latexToSvg(latex, fs, mode) },
    );

    if (converted.status === "ERROR") {
      return res.status(422).json({
        error: converted.error || "LaTeX-ul generat nu a trecut validarea.",
        latex: converted.latex,
        validation: converted.validation,
      });
    }

    const latex = applyStyle(converted.latex, bold, italic, overline);
    console.log("INPUT:", text);
    console.log("LATEX:", latex, "| status:", converted.status, "| cache:", converted.cacheHit);

    let rendered;
    try {
      rendered = latexToSvg(latex, fontSize, placement === "inline" ? "inline" : "display");
    } catch (err) {
      console.error("MATHJAX ERROR:", err);
      return res.status(422).json({ error: "LaTeX-ul generat nu a putut fi randat.", latex });
    }
    const pngDataUrl = await svgToPngDataUrl(rendered.svg);

    return res.json({
      latex,
      pngDataUrl,
      svg: rendered.svg,
      width: rendered.widthPx,
      height: rendered.heightPx,
      status: converted.status,
      confidence: converted.confidence,
      validation: converted.validation,
      attempts: converted.attempts,
      cacheHit: converted.cacheHit,
    });
  } catch (error: any) {
    console.error("RENDER ERROR:", error);
    return res.status(500).json({ error: error?.message || "Eroare la randare." });
  }
});

// ─────────────────────────────────────────────
// Endpoint 3: LaTeX editat manual → PNG (fără AI, fără validare)
// ─────────────────────────────────────────────
app.post("/api/render-latex", requireCanvaJwt, async (req, res) => {
  try {
    const latex = req.body?.latex;
    const fontSize = Number(req.body?.fontSize) || 24;
    const mode = req.body?.placement === "inline" ? "inline" : "display";

    if (!latex || typeof latex !== "string") {
      return res.status(400).json({ error: "LaTeX invalid." });
    }

    let rendered;
    try {
      rendered = latexToSvg(latex, fontSize, mode);
    } catch (err) {
      console.error("MATHJAX ERROR:", err);
      return res.status(422).json({ error: "LaTeX-ul introdus nu a putut fi randat. Verifică sintaxa." });
    }
    const pngDataUrl = await svgToPngDataUrl(rendered.svg);

    return res.json({ latex, pngDataUrl, svg: rendered.svg, width: rendered.widthPx, height: rendered.heightPx });
  } catch (error: any) {
    console.error("RENDER-LATEX ERROR:", error);
    return res.status(500).json({ error: error?.message || "Eroare la randare." });
  }
});

// ─────────────────────────────────────────────
// Endpoint 4: batch (§5, §27) — items: [{id, source, fontSize?, placement?}]
// ─────────────────────────────────────────────
app.post("/api/batch", requireCanvaJwt, async (req, res) => {
  try {
    const items = req.body?.items as BatchItem[] | undefined;
    if (!Array.isArray(items) || items.length === 0 || items.length > 200) {
      return res.status(400).json({ error: "items: între 1 și 200 de elemente." });
    }
    const bad = items.find((i) => !i || typeof i.id !== "string" || typeof i.source !== "string");
    if (bad) return res.status(400).json({ error: "Fiecare item are nevoie de id și source (string)." });

    const withPng = req.body?.includePng !== false; // implicit: PNG inclus (pluginul actual îl folosește)
    const results = await convertBatch(
      items,
      withPng ? deps : { ...deps, render: async (l, f, m) => latexToSvg(l, f, m) },
      Number(process.env.BATCH_CONCURRENCY ?? 4),
    );
    const summary = summarize(results);
    console.log("BATCH:", summary);
    return res.json({ summary, results });
  } catch (error: any) {
    console.error("BATCH ERROR:", error);
    return res.status(500).json({ error: error?.message || "Eroare la procesarea batch." });
  }
});

const PORT = Number(process.env.CANVA_BACKEND_PORT ?? 3001);

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
