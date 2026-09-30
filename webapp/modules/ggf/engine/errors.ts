export class GgfError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: string[] = []
  ) {
    super(`${code}: ${details.join(" / ")}`);
  }
}
