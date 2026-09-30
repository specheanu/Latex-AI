import os from "node:os";
import path from "node:path";
import { ConversionCache, cacheKey } from "./cache";
import { convertBatch, convertOne, summarize, type PipelineDeps } from "./pipeline";
import { latexToSvg } from "./renderer";

/** AI fals: tabel sursă → răspuns; opțional un prim răspuns greșit pentru retry. */
function fakeAi(table: Record<string, string>, firstWrong?: Record<string, string>) {
  const calls: { text: string; retry: boolean }[] = [];
  const seen = new Set<string>();
  const fn = async (text: string, opts?: { previousIssues?: { code: string }[] }) => {
    const retry = !!opts?.previousIssues?.length;
    calls.push({ text, retry });
    if (firstWrong?.[text] && !seen.has(text)) {
      seen.add(text);
      return firstWrong[text]!;
    }
    return table[text] ?? "";
  };
  return { fn, calls };
}

function deps(ai: ReturnType<typeof fakeAi>["fn"], cache = new ConversionCache()): PipelineDeps {
  return { textToLatex: ai, render: async (l, f, m) => latexToSvg(l, f, m), cache };
}

describe("pipeline.convertOne", () => {
  it("OK: conversie fidelă, randată, scor 1, intră în cache", async () => {
    const cache = new ConversionCache();
    const ai = fakeAi({ "√75": "\\sqrt{75}" });
    const r = await convertOne({ id: "F1", source: "√75" }, deps(ai.fn, cache));
    expect(r.status).toBe("OK");
    expect(r.confidence).toBe(1);
    expect(r.svg).toContain("<svg");
    expect(r.width).toBeGreaterThan(0);
    expect(cache.stats().size).toBe(1);
  });

  it("cache hit: a doua oară 0 apeluri AI", async () => {
    const cache = new ConversionCache();
    const ai = fakeAi({ "√75": "\\sqrt{75}" });
    await convertOne({ id: "F1", source: "√75" }, deps(ai.fn, cache));
    const r = await convertOne({ id: "F2", source: "√75" }, deps(ai.fn, cache));
    expect(r.cacheHit).toBe(true);
    expect(r.aiCalls).toBe(0);
    expect(ai.calls.length).toBe(1);
  });

  it("retry cu eroarea concretă: prima încercare cu acolade neînchise, a doua corectă", async () => {
    const ai = fakeAi({ "√75": "\\sqrt{75}" }, { "√75": "\\sqrt{75" });
    const r = await convertOne({ id: "F1", source: "√75" }, deps(ai.fn));
    expect(r.status).toBe("OK");
    expect(r.attempts).toBe(2);
    expect(ai.calls[1]?.retry).toBe(true);
  });

  it("ERROR după 2 încercări eșuate, cu errorType VALIDATION_ERROR", async () => {
    const ai = fakeAi({ x: "\\sqrt{x" });
    const r = await convertOne({ id: "F1", source: "x" }, deps(ai.fn));
    expect(r.status).toBe("ERROR");
    expect(r.errorType).toBe("VALIDATION_ERROR");
    expect(r.aiCalls).toBe(2);
  });

  it("REVIEW: număr inventat scade scorul sub prag și nu intră în cache", async () => {
    const cache = new ConversionCache();
    const ai = fakeAi({ "x + 2 = 5": "x + 2 = 5 + 0" });
    const r = await convertOne({ id: "F1", source: "x + 2 = 5" }, deps(ai.fn, cache));
    expect(r.status).toBe("REVIEW");
    expect(cache.stats().size).toBe(0);
  });

  it("RENDER_ERROR: LaTeX valid sintactic dar nerandabil", async () => {
    const ai = fakeAi({ x: "\\nonexistentcommand{x}" });
    const r = await convertOne({ id: "F1", source: "x" }, deps(ai.fn));
    expect(r.status).toBe("ERROR");
    expect(r.errorType).toBe("RENDER_ERROR");
  });

  it("CONVERSION_ERROR când AI-ul aruncă", async () => {
    const boom = async () => { throw new Error("rate limit"); };
    const r = await convertOne({ id: "F1", source: "x" }, deps(boom));
    expect(r.status).toBe("ERROR");
    expect(r.errorType).toBe("CONVERSION_ERROR");
  });

  it("autoFix: \\times din AI devine \\cdot și rămâne OK", async () => {
    const ai = fakeAi({ "AB × CD": "AB \\times CD" });
    const r = await convertOne({ id: "F1", source: "AB × CD" }, deps(ai.fn));
    expect(r.status).toBe("OK");
    expect(r.latex).toBe("AB \\cdot CD");
  });

  it("inline vs display: inline produce SVG mai mic pentru o fracție", async () => {
    const ai = fakeAi({ "1/2": "\\frac{1}{2}" });
    const block = await convertOne({ id: "b", source: "1/2", placement: "block" }, deps(ai.fn));
    const inline = await convertOne({ id: "i", source: "1/2", placement: "inline" }, deps(ai.fn));
    expect(inline.height!).toBeLessThan(block.height!);
  });
});

describe("pipeline.convertBatch", () => {
  it("200 de item-uri, rezultate în ordine, sumar corect, formule repetate = 1 apel AI", async () => {
    const cache = new ConversionCache();
    const ai = fakeAi({ "√75": "\\sqrt{75}", "x + 2 = 5": "x + 2 = 5 + 0", bad: "\\sqrt{" });
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `F${i}`,
      source: i % 10 === 0 ? "x + 2 = 5" : i % 25 === 1 ? "bad" : "√75",
    }));
    const results = await convertBatch(items, deps(ai.fn, cache), 4);
    expect(results.map((r) => r.id)).toEqual(items.map((i) => i.id));
    const s = summarize(results);
    expect(s.total).toBe(200);
    expect(s.ok + s.review + s.error).toBe(200);
    expect(s.error).toBe(8);
    expect(s.review).toBe(20);
    // √75 apare de 172 de ori; cu concurență 4, cel mult ~4 apeluri înainte de primul cache set
    expect(ai.calls.filter((c) => c.text === "√75").length).toBeLessThanOrEqual(4);
    expect(s.cacheHits).toBeGreaterThan(150);
  });
});

describe("cache", () => {
  it("cheia ignoră spațiile și normalizează superscript-urile", () => {
    expect(cacheKey("x²  + 1")).toBe(cacheKey("x^2 + 1"));
    expect(cacheKey("x²")).not.toBe(cacheKey("x³"));
    expect(cacheKey("52", true)).not.toBe(cacheKey("52", false));
  });
  it("persistă și reîncarcă din fișier", () => {
    const file = path.join(os.tmpdir(), `latex-ai-cache-${Date.now()}.json`);
    const a = new ConversionCache(file);
    a.set("k", { latex: "x", validation: { status: "OK", issues: [], fixedLatex: "x" }, approvedAt: "now", origin: "auto" });
    const b = new ConversionCache(file);
    expect(b.get("k")?.latex).toBe("x");
  });
});
