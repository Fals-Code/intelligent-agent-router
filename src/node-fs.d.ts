declare module "node:fs" {
  export interface Stats {
    readonly size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export function closeSync(fd: number): void;
  export function existsSync(path: string): boolean;
  export function fsyncSync(fd: number): void;
  export function lstatSync(path: string): Stats;
  export function mkdirSync(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ): string | undefined;
  export function openSync(path: string, flags: string, mode?: number): number;
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function realpathSync(path: string): string;
  export function statSync(path: string): Stats;
  export function writeFileSync(fd: number, data: string, encoding: "utf8"): void;
}
