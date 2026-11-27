/** Formatação das respostas para a IA: projeção de campos, máscara de dados pessoais e limite de tamanho. */

const CHAVES_PESSOAIS = /^(cpf|cpfnumber|numberidentitycard|identitycard|rg|spousecpf)$/i;
const CHAVES_BANCARIAS = /(agency|agencia|account|conta|pix|key|chave)/i;

function mascararTexto(v: string): string {
  const digitos = v.replace(/\D/g, "");
  if (digitos.length < 4) return "***";
  return `***${digitos.slice(-2)}`;
}

/**
 * Mascara CPF/RG em qualquer resposta e, nas rotas de dados bancários/PIX,
 * os campos de agência, conta e chave.
 */
export function mascarar(valor: unknown, rotaBancaria = false): unknown {
  if (Array.isArray(valor)) return valor.map((v) => mascarar(v, rotaBancaria));
  if (!valor || typeof valor !== "object") return valor;
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
    if ((CHAVES_PESSOAIS.test(k) || (rotaBancaria && CHAVES_BANCARIAS.test(k))) && (typeof v === "string" || typeof v === "number")) {
      saida[k] = mascararTexto(String(v));
    } else {
      saida[k] = mascarar(v, rotaBancaria);
    }
  }
  return saida;
}

export function ehRotaBancaria(caminho: string): boolean {
  return /bank-informations|pix-informations|payment-information/.test(caminho);
}

/** Mantém só os campos pedidos (aceita caminho com ponto: "buildingsCosts.buildingName"). */
export function projetar(itens: unknown[], campos?: string[]): unknown[] {
  if (!campos?.length) return itens;
  return itens.map((item) => {
    if (!item || typeof item !== "object") return item;
    const saida: Record<string, unknown> = {};
    for (const campo of campos) {
      const [raiz, ...resto] = campo.split(".");
      const v = (item as Record<string, unknown>)[raiz!];
      if (v === undefined) continue;
      if (!resto.length) saida[raiz!] = v;
      else if (Array.isArray(v)) saida[raiz!] = projetar(v, [resto.join(".")]);
      else if (v && typeof v === "object") saida[raiz!] = projetar([v], [resto.join(".")])[0];
    }
    return saida;
  });
}

/** Remove campos nulos, vazios e "links" (HATEOAS) para economizar contexto. */
export function enxugar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(enxugar);
  if (!valor || typeof valor !== "object") return valor;
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
    if (v === null || v === undefined || v === "" || k === "links" || k === "tenantUrl") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    saida[k] = enxugar(v);
  }
  return saida;
}

/**
 * Serializa para texto respeitando o limite de caracteres. Se `itens` não couber,
 * corta a lista e informa quantos ficaram de fora.
 */
export function serializar(resposta: Record<string, unknown>, maxCaracteres: number): string {
  let texto = JSON.stringify(resposta);
  if (texto.length <= maxCaracteres) return texto;
  const itens = resposta.itens;
  if (Array.isArray(itens) && itens.length > 1) {
    let n = itens.length;
    while (n > 1) {
      n = Math.floor(n * 0.75);
      const tentativa = {
        ...resposta,
        itens: itens.slice(0, n),
        itens_omitidos_por_tamanho: itens.length - n,
        aviso_tamanho: "Resposta grande demais para o contexto. Use 'campos' para trazer menos colunas, filtre mais, ou exporte para CSV.",
      };
      texto = JSON.stringify(tentativa);
      if (texto.length <= maxCaracteres) return texto;
    }
  }
  return texto.slice(0, maxCaracteres) + '…"(resposta cortada por tamanho)"';
}
