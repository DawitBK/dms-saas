export class Server {
  constructor(_options?: unknown) {}
  handle(_req: unknown, _res: unknown) {}
  on(_event: string, _handler: unknown) { return this; }
}

export class Upload {
  id = '';
  offset = 0;
  size = 0;
  storage: Record<string, unknown> = {};
}
