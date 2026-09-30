import { latexToSvg } from "./renderer";

describe("renderer", () => {
  it("randează o fracție și scalează cu fontSize", () => {
    const a = latexToSvg("\\frac{1}{2}", 24);
    const b = latexToSvg("\\frac{1}{2}", 48);
    expect(a.svg).toContain("<svg");
    expect(b.heightPx).toBeGreaterThan(a.heightPx);
  });
  it("aruncă la comandă necunoscută (nu text roșu în design)", () => {
    expect(() => latexToSvg("\\nonexistentcommand{x}", 24)).toThrow(/Undefined control sequence/);
  });
  it("aruncă la acoladă lipsă", () => {
    expect(() => latexToSvg("\\frac{1}{2", 24)).toThrow(/Missing/);
  });
  it("aligned se randează", () => {
    const r = latexToSvg("\\begin{aligned}a &= b \\\\ &= c\\end{aligned}", 24);
    expect(r.heightPx).toBeGreaterThan(30);
  });
  it("SVG-ul conține doar elemente permise de Canva", () => {
    const r = latexToSvg("\\sqrt{\\frac{a^2}{b_1}} \\cdot \\widehat{ABC}", 24);
    const tags = new Set([...r.svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]!.toLowerCase()));
    for (const t of tags) expect(["svg", "defs", "path", "g", "use", "rect"]).toContain(t);
  });
});
