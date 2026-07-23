// Errors thrown back to API clients. Carries a stable machine-readable `code`
// alongside the human message so callers can branch on `code` without parsing.
// Lives in core so the query brain and any core consumer can throw it without
// depending on the server package.
export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ClientError";
  }
}
