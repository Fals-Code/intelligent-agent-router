declare module "node:fs" {
  export function closeSync(fd: number): void;
  export function existsSync(path: string): boolean;
  export function fsyncSync(fd: number): void;
  export function mkdirSync(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ): string | undefined;
  export function openSync(path: string, flags: string, mode?: number): number;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function statSync(path: string): { readonly size: number };
  export function writeFileSync(fd: number, data: string, encoding: "utf8"): void;
}
