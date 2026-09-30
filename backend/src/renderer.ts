/**
 * Renderer: LaTeX → SVG (MathJax) → PNG (sharp). Mutat din server.ts;
 * adăugat modul inline/display (§19) și SVG-ul în rezultat (§11).
 */
import sharp from "sharp";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

// Fără "noundefined": o comandă necunoscută trebuie să fie EROARE, nu text roșu
// inserat în tăcere în design. formatError aruncă la orice eroare TeX
// (acoladă lipsă, comandă necunoscută etc.) — codul apelant o prinde.
const texInput = new TeX({
  packages: AllPackages.filter((p) => p !== "noundefined"),
  formatError: (_jax: unknown, err: { message: string }) => {
    throw new Error(`MathJax: ${err.message}`);
  },
});
const svgOutput = new SVG({ fontCache: "local" });
const mathDocument = mathjax.document("", {
  InputJax: texInput,
  OutputJax: svgOutput,
});

export type RenderMode = "inline" | "display";

export type Rendered = {
  svg: string;
  widthPx: number;
  heightPx: number;
};

export function latexToSvg(
  latex: string,
  fontSizePx: number,
  mode: RenderMode = "display",
): Rendered {
  // "em" controlează mărimea reală a caracterelor din formulă.
  const node = mathDocument.convert(latex, {
    display: mode === "display",
    em: fontSizePx,
    ex: fontSizePx / 2,
  });

  let svg = adaptor.innerHTML(node);
  svg = svg.replace(/currentColor/g, "#000000");

  // MathJax exprimă viewBox în unități de 1/1000 em.
  const viewBoxMatch = svg.match(
    /viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"/,
  );

  const widthUnits = viewBoxMatch?.[1] ? parseFloat(viewBoxMatch[1]) : 5000;
  const heightUnits = viewBoxMatch?.[2] ? parseFloat(viewBoxMatch[2]) : 1000;

  const pxPerUnit = fontSizePx / 1000;
  const widthPx = Math.max(1, Math.round(widthUnits * pxPerUnit));
  const heightPx = Math.max(1, Math.round(heightUnits * pxPerUnit));

  svg = svg
    .replace(/width="[\d.]+ex"/, `width="${widthPx}px"`)
    .replace(/height="[\d.]+ex"/, `height="${heightPx}px"`);

  return { svg, widthPx, heightPx };
}

export async function svgToPngDataUrl(
  svg: string,
  qualityMultiplier = 4,
): Promise<string> {
  const png = await sharp(Buffer.from(svg), { density: 96 * qualityMultiplier })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** Randare completă; aruncă dacă LaTeX-ul nu poate fi randat. */
export async function render(
  latex: string,
  fontSizePx: number,
  mode: RenderMode = "display",
): Promise<Rendered & { pngDataUrl: string }> {
  const r = latexToSvg(latex, fontSizePx, mode);
  const pngDataUrl = await svgToPngDataUrl(r.svg);
  return { ...r, pngDataUrl };
}
