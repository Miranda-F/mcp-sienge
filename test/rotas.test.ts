import { describe, expect, it } from "vitest";
import { CatalogoRotas } from "../src/rotas.js";

const catalogo = CatalogoRotas.carregar();

describe("catálogo de rotas", () => {
  it("contém só GETs gerados do OpenAPI oficial", () => {
    const todas = catalogo.todas();
    expect(todas.length).toBeGreaterThan(200);
    expect(todas.filter((r) => !r.bloqueado).length).toBeGreaterThan(190);
  });

  it("aceita rota documentada com id concreto", () => {
    expect(catalogo.validar("v1", "/purchase-orders/123/items", {}).caminho).toBe("/purchase-orders/{purchaseOrderId}/items");
  });

  it("prefere rota fixa a rota com parâmetro", () => {
    expect(catalogo.encontrar("v1", "/bills/by-change-date")?.rota.caminho).toBe("/bills/by-change-date");
    expect(catalogo.encontrar("v1", "/bills/55")?.rota.caminho).toBe("/bills/{billId}");
  });

  it("recusa rota fora do catálogo", () => {
    expect(() => catalogo.validar("v1", "/products", {})).toThrow(/não está na lista/);
    expect(() => catalogo.validar("v1", "/outcome", {})).toThrow(/não está na lista/);
  });

  it("recusa GETs bloqueados (PDF, boleto, anexos)", () => {
    expect(() => catalogo.validar("v1", "/creditor-report/pdf", {})).toThrow(/desabilitada/);
    expect(() => catalogo.validar("v1", "/payment-slip-notification", {})).toThrow(/desabilitada/);
    expect(() => catalogo.validar("v1", "/bills/1/attachments/2", {})).toThrow(/desabilitada/);
  });

  it("recusa parâmetros desconhecidos e de webhook", () => {
    expect(() => catalogo.validar("v1", "/companies", { hack: 1 })).toThrow(/não aceitos/);
    const q = { startDate: "2025-01-01", endDate: "2025-01-31", selectionType: "D", correctionIndexerId: 1, correctionDate: "2025-01-31" };
    expect(() => catalogo.validar("bulk", "/outcome", { ...q, _asyncWebHookUrl: "https://x" })).toThrow(/não aceitos/);
    expect(() => catalogo.validar("bulk", "/outcome", { ...q, _async: true })).toThrow(/não aceitos/);
    expect(catalogo.validar("bulk", "/outcome", q).base).toBe("bulk");
  });

  it("exige parâmetros obrigatórios", () => {
    expect(() => catalogo.validar("v1", "/bills", { startDate: "2025-01-01" })).toThrow(/endDate/);
  });

  it("recusa caminhos com travessia ou query", () => {
    expect(() => catalogo.validar("v1", "/companies/../hooks", {})).toThrow(/inválido/);
    expect(() => catalogo.validar("v1", "/companies?limit=1", {})).toThrow(/inválido/);
  });

  it("pesquisa sem acento", () => {
    const r = catalogo.pesquisar({ texto: "titulos" });
    expect(r.some((x) => x.caminho === "/bills")).toBe(true);
  });
});
