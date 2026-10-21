import { DatabaseManager } from './DatabaseManager.js';
process.once('message', ({ method, args }: { method: keyof DatabaseManager; args: unknown[] }) => {
  try {
    if (!['listTables', 'getSchema', 'executeQuery', 'prepareSnapshot'].includes(method)) throw new Error('Invalid database operation');
    const manager = new DatabaseManager();
    const value = (manager[method] as Function).apply(manager, args);
    process.send!({ value }, () => process.exit(0));
  } catch (error: any) { process.send!({ error: error.message }, () => process.exit(0)); }
});
