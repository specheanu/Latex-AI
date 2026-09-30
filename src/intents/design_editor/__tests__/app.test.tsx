import { screen } from "@testing-library/react";
import { App } from "src/intents/design_editor/app";
import { renderInTestProvider } from "src/utils/test_render";

// Testul starter-kit-ului referea un buton care nu mai există. Verificăm doar
// că aplicația se randează și cere selecția unui text.
describe("LaTeX AI — pornire", () => {
  it("afișează titlul și mesajul de selecție", () => {
    renderInTestProvider(<App />);
    expect(screen.getByText("LaTeX AI")).toBeTruthy();
    expect(
      screen.getByText(/Selectează textul matematic din design/),
    ).toBeTruthy();
  });
});
