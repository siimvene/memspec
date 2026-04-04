import { MemspecStore } from '../lib/store.js';

export interface InitOptions {
  cwd?: string;
}

export function runInit(options: InitOptions): string {
  const store = new MemspecStore(options.cwd);
  store.init();
  return `Initialized Memspec store at ${store.root}`;
}
