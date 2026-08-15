declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function join(...paths: string[]): string;
  export function isAbsolute(path: string): boolean;
}
