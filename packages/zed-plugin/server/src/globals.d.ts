declare const process: {
  argv: string[];
  cwd(): string;
  on(event: 'uncaughtException' | 'unhandledRejection', handler: (error: unknown) => void): void;
  stderr: {
    write(message: string): void;
  };
  stdin: any;
  stdout: any;
};

declare module 'node:net' {
  export function isIP(input: string): 0 | 4 | 6;
}
