import "dotenv/config";

import express from "express";
import cors from "cors";
import sharp from "sharp";
import Groq from "groq-sdk";

import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const apiKey = process.env.GROQ_API_KEY;

if (!apiKey) {
  throw new Error("GROQ_API_KEY nu este definită în .env");
}

const groq = new Groq({ apiKey });

// Model Groq folosit pentru conversia text → LaTeX
// (llama-3.3-70b-versatile a fost retras de Groq pe 16 august 2026)
const GROQ_MODEL = "openai/gpt-oss-120b";

// ─────────────────────────────────────────────
// MathJax (LaTeX → SVG), inițializat o singură dată
// ─────────────────────────────────────────────
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const texInput = new TeX({ packages: AllPackages });
const svgOutput = new SVG({ fontCache: "local" });
const mathDocument = mathjax.document("", {
  InputJax: texInput,
  OutputJax: svgOutput,
});

function latexToSvg(
  latex: string,
  fontSizePx: number
): { svg: string; widthPx: number; heightPx: number } {
  // Trecem "em" ca dimensiune de referință — asta e parametrul care
  // controlează mărimea reală a caracterelor (cifre, litere) în interiorul
  // formulei, indiferent cât de înalt/lat iese formula per total.
  const node = mathDocument.convert(latex, {
    display: true,
    em: fontSizePx,
    ex: fontSizePx / 2, // valoare arbitrară — nu afectează mărimea cifrelor
  });

  let svg = adaptor.innerHTML(node);
  svg = svg.replace(/currentColor/g, "#000000");

  // MathJax exprimă viewBox în unități de 1/1000 em (documentat oficial:
  // "the viewBox attribute... values correspond to em units in the SVG
  // output"). Folosind asta direct, cifrele ies mereu la fontSizePx real,
  // indiferent dacă formula conține acolade, fracții sau exponenți care
  // fac bounding box-ul total mai înalt sau mai scund.
  const viewBoxMatch = svg.match(
    /viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"/
  );

  const widthUnits = viewBoxMatch ? parseFloat(viewBoxMatch[1]) : 5000;
  const heightUnits = viewBoxMatch ? parseFloat(viewBoxMatch[2]) : 1000;

  const pxPerUnit = fontSizePx / 1000;

  const widthPx = Math.max(1, Math.round(widthUnits * pxPerUnit));
  const heightPx = Math.max(1, Math.round(heightUnits * pxPerUnit));

  // Rescriem width/height explicit în pixeli, ca rasterizarea (sharp)
  // să nu ghicească dimensiunea din unitatea "ex".
  svg = svg
    .replace(/width="[\d.]+ex"/, `width="${widthPx}px"`)
    .replace(/height="[\d.]+ex"/, `height="${heightPx}px"`);

  return { svg, widthPx, heightPx };
}

async function svgToPngDataUrl(svg: string, qualityMultiplier = 4): Promise<string> {
  // density mare = rezoluție internă mai bună (imagine clară în Canva),
  // dar dimensiunea AFIȘATĂ e stabilită separat, prin width/height la inserare.
  const png = await sharp(Buffer.from(svg), { density: 96 * qualityMultiplier })
    .png()
    .toBuffer();

  return `data:image/png;base64,${png.toString("base64")}`;
}

// ─────────────────────────────────────────────
// Reguli Gemini
// ─────────────────────────────────────────────
const RULES = `
Ești un convertor specializat în matematică românească.

Transformă textul primit în LaTeX.

RESPECTĂ STRICT următoarele reguli:

1. Dacă textul original conține un semn de înmulțire explicit (× sau *),
   scrie-l întotdeauna cu \\cdot.

2. Nu utiliza niciodată simbolul × pentru înmulțire.

3. Pentru unghiurile formate din mai multe litere:
   \\widehat{ABC}

4. Pentru unghiurile formate dintr-o singură literă sau cifră:
   \\sphericalangle A

5. Nu utiliza niciodată \\quad.

6. Nu utiliza \\text{} pentru:
   ipotenuza
   cateta
   cm

7. Pentru calcule desfășurate pe mai multe rânduri:
   \\begin{aligned}
   ...
   \\end{aligned}

8. Fracțiile se scriu cu:
   \\frac{}{}

9. Transformă EXACT expresia primită — nu adăuga, nu elimina și nu
   rearanjezi simboluri, termeni sau paranteze. Singura ta sarcină e
   conversia sintaxei în LaTeX valid; nu simplifica, nu corecta, nu
   reformula și nu „îmbunătăți" expresia matematic, chiar dacă pare
   incompletă, neconvențională sau posibil greșită. Ce a scris
   autorul, aia se transformă — 1 la 1.

10. Nu explica rezultatul.

11. Nu returna Markdown.

12. Nu returna:
   \`\`\`latex

13. Nu include delimitatori $ sau \\[ \\]. Returnează doar conținutul formulei.

14. Returnează EXCLUSIV cod LaTeX valid, compatibil cu MathJax.

15. Ignoră diacriticele, nu returna cod cu diacritice.

16. Pentru cuvinte nu folosi \\text{} — scrie-le clasic (literele direct
    în modul matematică). Adaugă "\\ " (backslash urmat de spațiu —
    „control space") DOAR între două tokenuri alăturate care altfel
    NU au niciun separator vizual între ele — adică:
      - cuvânt urmat direct de alt cuvânt (ex: și h → și\\ h)
      - număr sau variabilă urmată direct de un cuvânt/unitate
        (ex: 11 m → 11\\ m)
    NU adăuga "\\ " în jurul unui operator, semn de relație sau
    semn de punctuație — acestea au deja spațiere automată în LaTeX
    și nu au nevoie de nimic suplimentar:
      - NU înainte/după "=", "+", "-", "\\cdot" etc.
      - NU după virgulă ","
    NU folosi niciodată spațiu simplu (nu se vede în LaTeX) și
    NU folosi niciodată \\quad (mult prea larg).

    Exemplu corect:
      Text:  "L = 11 m, l = 9 m, și h = 7 m"
      LaTeX: L = 11\\ m,\\ l = 9\\ m,\\ și\\ h = 7\\ m
      (rescris corect ca aliniere, cu spații DOAR unde chiar lipsesc)

    Exemplu greșit (prea lăbărțat — NU face asta):
      L\\ =\\ 11\\ m,\\ l\\ =\\ 9\\ m,\\ și\\ h\\ =\\ 7\\ m
      (are \\ inclusiv în jurul lui "=" și după virgulă — greșit)

    Exemplu greșit (spațiu simplu, nu se vede):
      există o mulțime de elemente

17. Simbolul ∅ este \\varnothing.

18. Dacă textul original NU conține niciun semn de înmulțire (nici ×,
    nici *) între doi factori — de exemplu "2x", "3(a+b)", "xy" — NU
    adăuga tu \\cdot sau orice alt semn. Păstrează juxtapunerea exact
    așa cum e dată, fără să deduci sau să presupui o înmulțire acolo
    unde autorul nu a scris-o explicit.

19. NU adăuga NICIODATĂ, din proprie inițiativă, comenzi de stilizare:
    \\mathbf, \\boldsymbol, \\bf, \\mathit, \\it, \\overline, \\underline,
    \\textbf, \\emph sau orice altă comandă de îngroșare/înclinare/
    subliniere/bară. Stilizarea (bold, italic, overline) este
    controlată STRICT de aplicație, printr-un pas separat, aplicat
    DUPĂ ce tu generezi LaTeX-ul — tu returnezi întotdeauna varianta
    NESTILIZATĂ, indiferent de context, chiar dacă crezi că o parte a
    expresiei ar trebui evidențiată sau accentuată.

20. Pentru paralele se folosește \\parallel.
21. Ce este cu \\div se modifica in\\frac. sau :, in functie de context.
22. In cazul in care textul contine ... se va transforma in \\dots
23. In cazul in care textul contine "\\", se va transforma in \\frac.
`;

function cleanLatex(raw: string): string {
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

// Instrucțiune suplimentară, adăugată DOAR când Overline e bifat.
// La overline, textul selectat e de regulă o secvență de cifre pentru
// notația numerelor periodice (ex. 52x sub bară) — nu o înmulțire.
// Întărim explicit regula 18 pentru acest caz, ca modelul să nu confunde
// cifrele alăturate cu o operație de înmulțire implicită.
const NO_MULTIPLICATION_ADDENDUM = `

REGULĂ SUPLIMENTARĂ PENTRU ACEST APEL:
Textul primit reprezintă o secvență de cifre/caractere care va fi
plasată sub o bară (\\overline), de obicei pentru notația unui număr
periodic. NU introduce niciun semn de înmulțire (\\cdot sau altul)
între cifre sau caractere, indiferent de context. Păstrează-le exact
alăturate, fără niciun operator inserat.
`;

async function textToLatex(
  text: string,
  suppressMultiplication = false
): Promise<string> {
  const systemPrompt = suppressMultiplication
    ? RULES + NO_MULTIPLICATION_ADDENDUM
    : RULES;

  const response = await groq.chat.completions.create({
    model: GROQ_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
  });

  const raw = response.choices[0]?.message?.content || "";
  return cleanLatex(raw);
}

// Aplică \overline / \bf / \it peste LaTeX-ul deja generat.
// \overline nu se exclude cu \bf/\it — se poate combina liber (bara
// rămâne deasupra, indiferent de stilul fontului). \bf și \it sunt
// comenzi vechi de schimbare a familiei de font (plain TeX) — acestea
// DOUĂ se exclud reciproc, deci dacă ambele sunt active, se aplică
// ultima (\it are prioritate).
function applyStyle(
  latex: string,
  bold: boolean,
  italic: boolean,
  overline: boolean
): string {
  let styled = latex;

  if (overline) {
    styled = `\\overline{${styled}}`;
  }

  if (bold) {
    styled = `{\\bf ${styled}}`;
  }

  if (italic) {
    styled = `{\\it ${styled}}`;
  }

  return styled;
}

// ─────────────────────────────────────────────
// Endpoint 1: text → LaTeX (cel existent)
// ─────────────────────────────────────────────
app.post("/api/latex", async (req, res) => {
  try {
    const text = req.body?.text;

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Text invalid." });
    }

    const latex = await textToLatex(text);

    if (!latex) {
      return res.status(502).json({ error: "Gemini nu a returnat LaTeX." });
    }

    console.log("INPUT:", text);
    console.log("LATEX:", latex);

    res.json({ latex });
  } catch (error: any) {
    console.error("GROQ ERROR:", error);
    res.status(500).json({
      error: error?.message || "Eroare la generarea LaTeX.",
    });
  }
});

// ─────────────────────────────────────────────
// Endpoint 2: text → LaTeX → PNG (data URL)
// ─────────────────────────────────────────────
app.post("/api/render", async (req, res) => {
  try {
    const text = req.body?.text;
    // Dimensiunea fontului textului selectat în Canva (px). Dacă lipsește,
    // folosim o valoare implicită rezonabilă.
    const fontSize = Number(req.body?.fontSize) || 24;
    const bold = !!req.body?.bold;
    const italic = !!req.body?.italic;
    const overline = !!req.body?.overline;

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Text invalid." });
    }

    let latex = await textToLatex(text, overline);

    if (!latex) {
      return res.status(502).json({ error: "Gemini nu a returnat LaTeX." });
    }

    latex = applyStyle(latex, bold, italic, overline);

    console.log("INPUT:", text);
    console.log("LATEX:", latex, "| bold:", bold, "italic:", italic);
    console.log("FONT SIZE:", fontSize);

    let rendered: { svg: string; widthPx: number; heightPx: number };
    try {
      rendered = latexToSvg(latex, fontSize);
    } catch (err: any) {
      console.error("MATHJAX ERROR:", err);
      return res.status(422).json({
        error: "LaTeX-ul generat nu a putut fi randat.",
        latex,
      });
    }

    const pngDataUrl = await svgToPngDataUrl(rendered.svg);

    res.json({
      latex,
      pngDataUrl,
      width: rendered.widthPx,
      height: rendered.heightPx,
    });
  } catch (error: any) {
    console.error("RENDER ERROR:", error);
    res.status(500).json({
      error: error?.message || "Eroare la randare.",
    });
  }
});

// ─────────────────────────────────────────────
// Endpoint 3: LaTeX (editat manual de utilizator) → PNG
// Nu apelează Groq deloc — randează exact ce trimite utilizatorul,
// pentru cazul în care corectează manual codul generat automat.
// ─────────────────────────────────────────────
app.post("/api/render-latex", async (req, res) => {
  try {
    const latex = req.body?.latex;
    const fontSize = Number(req.body?.fontSize) || 24;

    if (!latex || typeof latex !== "string") {
      return res.status(400).json({ error: "LaTeX invalid." });
    }

    console.log("RE-RANDARE LATEX (manual):", latex);
    console.log("FONT SIZE:", fontSize);

    let rendered: { svg: string; widthPx: number; heightPx: number };
    try {
      rendered = latexToSvg(latex, fontSize);
    } catch (err: any) {
      console.error("MATHJAX ERROR:", err);
      return res.status(422).json({
        error: "LaTeX-ul introdus nu a putut fi randat. Verifică sintaxa.",
      });
    }

    const pngDataUrl = await svgToPngDataUrl(rendered.svg);

    res.json({
      latex,
      pngDataUrl,
      width: rendered.widthPx,
      height: rendered.heightPx,
    });
  } catch (error: any) {
    console.error("RENDER-LATEX ERROR:", error);
    res.status(500).json({
      error: error?.message || "Eroare la randare.",
    });
  }
});

const PORT = 3001;

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});