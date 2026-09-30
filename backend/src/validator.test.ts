import { validateLatex, autoFix, confidenceScore } from "./validator";

describe("autoFix (reguli deterministe)", () => {
  it("× și \\times → \\cdot", () => {
    expect(autoFix("AB \\times CD").latex).toBe("AB \\cdot CD");
    expect(autoFix("AB × CD").latex).toBe("AB \\cdot CD");
  });
  it("\\left\\{ / \\right\\} → \\{ \\}", () => {
    expect(autoFix("\\left\\{x \\in \\mathbb{R} \\mid x>0\\right\\}").latex)
      .toBe("\\{x \\in \\mathbb{R} \\mid x>0\\}");
  });
  it("\\quad → \\ ", () => {
    expect(autoFix("a = 1 \\quad b = 2").latex).toBe("a = 1 \\  b = 2");
  });
  it("\\text{cm} → cm, \\text{cateta}_1 → cateta_1", () => {
    expect(autoFix("5\\ \\text{cm}").latex).toBe("5\\ cm");
    expect(autoFix("\\text{cateta}_1").latex).toBe("cateta_1");
  });
});

describe("validateLatex — formule simple", () => {
  it("OK pentru conversie fidelă", () => {
    const r = validateLatex("AB × CD : 2 = 20 cm²", "AB \\cdot CD : 2 = 20\\ cm^2");
    expect(r.status).toBe("OK");
  });
  it("corectează \\times și rămâne OK (fix aplicat)", () => {
    const r = validateLatex("AB × CD", "AB \\times CD");
    expect(r.status).toBe("OK");
    expect(r.fixedLatex).toBe("AB \\cdot CD");
    expect(r.issues.map((i) => i.code)).toContain("TIMES");
  });
});

describe("validateLatex — fracții, radicali, unghiuri, mulțimi", () => {
  it("fracție: a:b → \\frac{a}{b} nu e considerat operator lipsă", () => {
    const r = validateLatex("(a+b) : 2", "\\frac{a+b}{2}");
    expect(r.status).toBe("OK");
  });
  it("regula 21: ÷ → \\frac nu e operator lipsă", () => {
    expect(validateLatex("6 ÷ 2 = 3", "\\frac{6}{2} = 3").status).toBe("OK");
  });
  it("regula 23: 3\\4 → \\frac{3}{4}", () => {
    expect(validateLatex("3\\4", "\\frac{3}{4}").status).toBe("OK");
  });
  it("regula 22: ... → \\dots", () => {
    expect(validateLatex("1, 2, ..., n", "1, 2, \\dots, n").status).toBe("OK");
  });
  it("radical √75", () => {
    expect(validateLatex("√75", "\\sqrt{75}").status).toBe("OK");
  });
  it("unghi cu mai multe litere", () => {
    expect(validateLatex("unghiul ABC = 60°", "\\widehat{ABC} = 60^\\circ").status).toBe("OK");
  });
  it("mulțime fără \\left\\{", () => {
    const r = validateLatex("{x ∈ ℝ | x > 2}", "\\left\\{x \\in \\mathbb{R} \\mid x > 2\\right\\}");
    expect(r.fixedLatex).toBe("\\{x \\in \\mathbb{R} \\mid x > 2\\}");
    expect(r.status).toBe("OK");
  });
});

describe("validateLatex — multiline aligned", () => {
  const src = "Δ = b² - 4ac = 25 - 24 = 1";
  it("aligned corect", () => {
    const r = validateLatex(src, "\\begin{aligned}\\Delta &= b^2 - 4ac \\\\ &= 25 - 24 \\\\ &= 1\\end{aligned}");
    expect(r.status).toBe("OK");
  });
  it("aligned fără \\end → ERROR", () => {
    const r = validateLatex(src, "\\begin{aligned}\\Delta &= b^2 - 4ac \\\\ &= 25 - 24 \\\\ &= 1");
    expect(r.status).toBe("ERROR");
    expect(r.issues[0]?.code).toBe("ALIGNED_STRUCTURE");
  });
});

describe("validateLatex — formule invalide / infidele", () => {
  it("acolade neînchise → ERROR", () => {
    expect(validateLatex("√75", "\\sqrt{75").status).toBe("ERROR");
  });
  it("număr inventat → REVIEW", () => {
    const r = validateLatex("x + 2 = 5", "x + 2 = 5 + 0");
    expect(r.status).toBe("REVIEW");
    expect(r.issues.some((i) => i.code === "NUMBER_MISMATCH")).toBe(true);
  });
  it("operator eliminat → REVIEW", () => {
    const r = validateLatex("2 × 3 × 4", "2 \\cdot 3\\ 4");
    expect(r.status).toBe("REVIEW");
    expect(r.issues.some((i) => i.code === "OPERATOR_MISMATCH")).toBe(true);
  });
  it("delimitatori $ → ERROR", () => {
    expect(validateLatex("x", "$x$").status).toBe("ERROR");
  });
  it("comandă de stil adăugată de AI → REVIEW", () => {
    expect(validateLatex("x", "\\mathbf{x}").status).toBe("REVIEW");
  });
});

describe("confidenceScore v0", () => {
  it("OK + randat + fără fix → 1.0", () => {
    const v = validateLatex("√75", "\\sqrt{75}");
    expect(confidenceScore({ validation: v, rendered: true, cacheHit: false, aiAttempts: 1 })).toBe(1);
  });
  it("REVIEW scade sub pragul implicit 0.95", () => {
    const v = validateLatex("x + 2 = 5", "x + 2 = 5 + 0");
    expect(confidenceScore({ validation: v, rendered: true, cacheHit: false, aiAttempts: 1 })).toBeLessThan(0.95);
  });
  it("nerandat → 0", () => {
    const v = validateLatex("x", "x");
    expect(confidenceScore({ validation: v, rendered: false, cacheHit: false, aiAttempts: 1 })).toBe(0);
  });
});
