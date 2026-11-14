import { join, resolve } from 'node:path';

type Source = Record<string, string | undefined>;

/** Where Click keeps its local state (SPEC §17.2). `CLICK_HOME` overrides the default `<root>/.click`. */
export function clickDir(root: string = process.cwd(), env: Source = process.env): string {
  const home = env.CLICK_HOME;
  return home ? resolve(home) : join(root, '.click');
}
