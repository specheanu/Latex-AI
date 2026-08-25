import React, { useEffect, useState } from "react";
import {
  Button,
  Rows,
  Columns,
  Column,
  Text,
  Title,
  Alert,
  Checkbox,
} from "@canva/app-ui-kit";
import { selection, addElementAtPoint, getCurrentPageContext } from "@canva/design";
import type { SelectionEvent } from "@canva/design";

export function App() {
  const [selectionEvent, setSelectionEvent] =
    useState<SelectionEvent<"richtext"> | null>(null);

  const [text, setText] = useState("");
  const [fontSize, setFontSize] = useState(24);

  // LaTeX-ul curent — poate veni din Groq SAU poate fi editat manual.
  // E sursa unică de adevăr pentru ce se randează / inserează.
  const [latex, setLatex] = useState("");

  const [preview, setPreview] = useState("");
  const [imgWidth, setImgWidth] = useState(0);
  const [imgHeight, setImgHeight] = useState(0);

  const [loading, setLoading] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [error, setError] = useState("");
  const [removeOriginal, setRemoveOriginal] = useState(false);
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [overline, setOverline] = useState(false);

  // 1. Ascultăm selecția de text (inclusiv o porțiune dintr-un text box)
  useEffect(() => {
    const dispose = selection.registerOnChange({
      scope: "richtext",
      onChange: async (event) => {
        setSelectionEvent(event);
        setLatex("");
        setPreview("");
        setError("");

        if (event.count === 0) {
          setText("");
          return;
        }

        try {
          const draft = await event.read();
          const joined = draft.contents
            .map((range) => range.readPlaintext())
            .join("\n");
          setText(joined);

          // Preluăm dimensiunea fontului din prima regiune formatată,
          // ca formula generată să iasă la aceeași mărime.
          const firstRange = draft.contents[0];
          const regions = firstRange?.readTextRegions() || [];
          const detectedFontSize = regions[0]?.formatting?.fontSize;
          setFontSize(detectedFontSize || 24);
        } catch (err) {
          console.error(err);
          setError("Nu am putut citi textul selectat.");
        }
      },
    });

    return () => dispose();
  }, []);

  const isTextSelected = !!selectionEvent && selectionEvent.count > 0;

  // PASUL 1: text selectat → Groq → LaTeX → randare inițială (preview).
  // NU inserează în design — doar generează, ca să poți verifica/edita.
  async function generateFromText() {
    if (!text.trim() || !selectionEvent) {
      setError("Selectează un text în design.");
      return;
    }

    setLoading(true);
    setError("");
    setLatex("");
    setPreview("");

    try {
      const response = await fetch("http://localhost:3001/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, fontSize, bold, italic, overline }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Backend error");
      }

      setLatex(data.latex);
      setPreview(data.pngDataUrl);
      setImgWidth(data.width);
      setImgHeight(data.height);
    } catch (err: any) {
      console.error(err);
      setError(err?.message || "Nu s-a putut genera formula.");
    } finally {
      setLoading(false);
    }
  }

  // PASUL 2 (opțional): utilizatorul editează manual textarea-ul cu LaTeX
  // și apasă "Re-randează" — randează EXACT ce a scris, fără Groq.
  async function rerenderFromLatex() {
    if (!latex.trim()) {
      setError("Codul LaTeX e gol.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        "http://localhost:3001/api/render-latex",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ latex, fontSize }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Backend error");
      }

      setPreview(data.pngDataUrl);
      setImgWidth(data.width);
      setImgHeight(data.height);
    } catch (err: any) {
      console.error(err);
      setError(err?.message || "Nu s-a putut randa LaTeX-ul.");
    } finally {
      setLoading(false);
    }
  }

  // PASUL 3: inserează imaginea curentă (preview) în design, centrată pe
  // pagină, și opțional golește textul original selectat.
  async function insertIntoDesign() {
    if (!preview || !imgWidth || !imgHeight) {
      setError("Generează sau randează mai întâi o formulă.");
      return;
    }

    setInserting(true);
    setError("");

    try {
      const pageContext = await getCurrentPageContext();
      const pageWidth = pageContext.dimensions?.width ?? 1000;
      const pageHeight = pageContext.dimensions?.height ?? 1000;

      const top = Math.max(0, Math.round((pageHeight - imgHeight) / 2));
      const left = Math.max(0, Math.round((pageWidth - imgWidth) / 2));

      await addElementAtPoint({
        type: "image",
        dataUrl: preview,
        width: imgWidth,
        height: imgHeight,
        top,
        left,
        altText: {
          text: latex,
          decorative: false,
        },
      });

      // Opțional: ștergem textul original selectat, înlocuindu-l cu
      // spații (lungime egală cu textul original) în loc să-l golim
      // complet. fontSize e atribut de PARAGRAF (nu inline) și se
      // fixează separat, prin formatParagraph.
      if (removeOriginal && selectionEvent) {
        const draft = await selectionEvent.read();
        draft.contents.forEach((range) => {
          const length = range.readPlaintext().length;
          const regions = range.readTextRegions();
          const regionFontSize = regions[0]?.formatting?.fontSize;

          const spaces = " ".repeat(length);

          range.replaceText({ index: 0, length }, spaces);

          if (regionFontSize) {
            range.formatParagraph(
              { index: 0, length: spaces.length },
              { fontSize: regionFontSize }
            );
          }
        });
        await draft.save();
      }
    } catch (err: any) {
      console.error(err);
      setError(err?.message || "Nu s-a putut insera imaginea în design.");
    } finally {
      setInserting(false);
    }
  }

  return (
    <Rows spacing="2u">
      <Title>LaTeX AI</Title>

      {!isTextSelected && (
        <Alert tone="info">
          Selectează textul matematic din design (poți selecta doar o
          porțiune dintr-un text box).
        </Alert>
      )}

      {isTextSelected && (
        <>
          <Text>Text selectat:</Text>
          <textarea
            value={text}
            readOnly
            style={{
              width: "100%",
              minHeight: "70px",
              padding: "10px",
              boxSizing: "border-box",
            }}
          />
        </>
      )}

      <Text>Stil formulă (aplicat la generarea inițială):</Text>
      <Columns spacing="1u">
        <Column>
          <Button
            variant={bold ? "primary" : "secondary"}
            onClick={() => setBold((v) => !v)}
            stretch
          >
            Bold
          </Button>
        </Column>
        <Column>
          <Button
            variant={italic ? "primary" : "secondary"}
            onClick={() => setItalic((v) => !v)}
            stretch
          >
            Italic
          </Button>
        </Column>
      </Columns>

      <Button
        variant={overline ? "primary" : "secondary"}
        onClick={() => setOverline((v) => !v)}
        stretch
      >
        Overline (bară deasupra)
      </Button>

      <Button
        variant="primary"
        onClick={generateFromText}
        loading={loading}
        disabled={!isTextSelected}
        stretch
      >
        1. Generează formula
      </Button>

      {error && <Alert tone="critical">{error}</Alert>}

      {preview && (
        <>
          <Text>Formula generată:</Text>
          <img
            src={preview}
            alt={latex}
            style={{
              maxWidth: "100%",
              background: "#ffffff",
              padding: "8px",
              borderRadius: "4px",
            }}
          />

          <Text>
            Cod LaTeX (poți edita manual dacă nu e conform cerințelor tale):
          </Text>
          <textarea
            value={latex}
            onChange={(event) => setLatex(event.target.value)}
            style={{
              width: "100%",
              minHeight: "70px",
              padding: "10px",
              boxSizing: "border-box",
              fontFamily: "monospace",
              fontSize: "12px",
            }}
          />

          <Button
            variant="secondary"
            onClick={rerenderFromLatex}
            loading={loading}
            stretch
          >
            2. Re-randează codul editat
          </Button>

          <Checkbox
            label="Șterge textul original după inserare"
            checked={removeOriginal}
            onChange={(_, checked) => setRemoveOriginal(checked)}
          />

          <Button
            variant="primary"
            onClick={insertIntoDesign}
            loading={inserting}
            stretch
          >
            3. Inserează în design
          </Button>
        </>
      )}
    </Rows>
  );
}