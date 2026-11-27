import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TipoApi = "rest" | "bulk";

interface Estado {
  dia: string;
  rest: number;
  bulk: number;
}

function hoje(agora: Date): string {
  // Dia no fuso de Brasília, que é quando a cota do Sienge renova.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
}

/** Conta as chamadas feitas por este servidor no dia (persistido em disco). */
export class UsoDiario {
  private estado: Estado;
  private readonly arquivo: string | null;

  constructor(
    pastaEstado: string | null,
    subdominio = "padrao",
    private readonly agora: () => Date = () => new Date(),
  ) {
    this.arquivo = pastaEstado ? join(pastaEstado, `uso-diario-${subdominio}.json`) : null;
    this.estado = { dia: hoje(this.agora()), rest: 0, bulk: 0 };
    if (this.arquivo) {
      try {
        const lido = JSON.parse(readFileSync(this.arquivo, "utf8")) as Estado;
        if (lido.dia === this.estado.dia) this.estado = lido;
      } catch {
        /* primeiro uso */
      }
    }
  }

  private virarDia(): void {
    const dia = hoje(this.agora());
    if (dia !== this.estado.dia) this.estado = { dia, rest: 0, bulk: 0 };
  }

  usado(tipo: TipoApi): number {
    this.virarDia();
    return this.estado[tipo];
  }

  registrar(tipo: TipoApi): void {
    this.virarDia();
    this.estado[tipo] += 1;
    if (!this.arquivo) return;
    try {
      mkdirSync(join(this.arquivo, ".."), { recursive: true });
      writeFileSync(this.arquivo, JSON.stringify(this.estado));
    } catch {
      /* contagem só em memória se não der para gravar */
    }
  }

  resumo(): Estado {
    this.virarDia();
    return { ...this.estado };
  }
}
