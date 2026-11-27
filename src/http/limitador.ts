/** Limitador de janela deslizante de 60 s (uma instância por tipo de API). */
export class LimitadorPorMinuto {
  private chamadas: number[] = [];

  constructor(
    private readonly limite: number,
    private readonly agora: () => number = Date.now,
  ) {}

  /** Milissegundos que faltam até poder fazer a próxima chamada (0 = pode agora). */
  espera(): number {
    const t = this.agora();
    this.chamadas = this.chamadas.filter((c) => t - c < 60_000);
    if (this.chamadas.length < this.limite) return 0;
    return 60_000 - (t - this.chamadas[0]!) + 5;
  }

  registrar(): void {
    this.chamadas.push(this.agora());
  }
}
