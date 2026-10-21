export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`InvalidParams: ${name} must be a non-empty string`);
  return value.trim();
}

export function appId(value: unknown): string {
  const result = text(value, 'appId');
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(result)) throw new Error('InvalidParams: invalid Android package name');
  return result;
}

export function dbName(value: unknown): string {
  const result = text(value, 'dbName');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(result) || result.endsWith('.') || result.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(result)) {
    throw new Error('InvalidParams: dbName must be a safe file name, not a path');
  }
  return result;
}

export function normalizeArguments(name: string, input: unknown): Record<string, any> {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) throw new Error('InvalidParams: arguments must be an object');
  const args = { ...(input as Record<string, unknown> ?? {}) };
  if (name !== 'list_packages' && name !== 'get_cache_status') {
    if (args.appId !== undefined && args.package_name !== undefined && args.appId !== args.package_name) throw new Error('InvalidParams: appId and package_name conflict');
    args.appId = appId(args.appId ?? args.package_name);
    if (name !== 'list_databases') args.dbName = dbName(args.dbName);
  }
  if (name === 'get_schema') args.tableName = text(args.tableName, 'tableName');
  if (name === 'execute_query') {
    text(args.query, 'query');
    if (args.params !== undefined && (!Array.isArray(args.params) || args.params.some(v => v !== null && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))))) throw new Error('InvalidParams: params must be an array of strings, finite numbers or null');
  }
  if (name === 'list_packages' && args.query !== undefined && typeof args.query !== 'string') throw new Error('InvalidParams: query must be a string');
  return args;
}
