import { isBuiltinSandboxSupported } from './sandbox-seatbelt';
import { isContainerRuntimeAvailable, type ContainerRuntime } from './sandbox-docker';

/**
 * The `--sandbox` flag is an *intent with per-platform backends*, not a single
 * mechanism, so the flag is coherent everywhere and only the default backend is
 * platform-specific:
 *   - bare `--sandbox`      → the built-in minimal jail for this OS (macOS: seatbelt)
 *   - `--sandbox=docker`    → run the agent in a container, egress via the proxy
 *   - `--sandbox=podman`    → same, podman
 */
export type SandboxKind = 'builtin' | ContainerRuntime;

export type SandboxSpec = { kind: SandboxKind };

const CONTAINER_RUNTIMES: ReadonlyArray<ContainerRuntime> = ['docker', 'podman'];

/**
 * Normalize the raw `--sandbox` flag value into a kind. The gunshi arg parser
 * maps bare `--sandbox` to `'builtin'`; `auto`/`builtin` are accepted spellings.
 * Returns undefined when the flag is absent. Throws on an unknown value.
 */
export function parseSandboxSpec(raw: string | undefined): SandboxSpec | undefined {
  if (raw == null) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'builtin' || value === 'auto') return { kind: 'builtin' };
  if ((CONTAINER_RUNTIMES as ReadonlyArray<string>).includes(value)) {
    return { kind: value as ContainerRuntime };
  }
  throw new Error(
    `Unknown --sandbox value "${raw}". Use bare \`--sandbox\` (built-in) or \`--sandbox=docker\` / \`--sandbox=podman\`.`,
  );
}

export function isContainerKind(kind: SandboxKind): kind is ContainerRuntime {
  return kind === 'docker' || kind === 'podman';
}

/**
 * Check that the selected backend can actually run here, returning a clear
 * reason string when it can't (so the caller can surface a good error).
 */
export function checkSandboxAvailable(spec: SandboxSpec): { ok: true } | { ok: false; reason: string } {
  if (spec.kind === 'builtin') {
    if (isBuiltinSandboxSupported()) return { ok: true };
    return {
      ok: false,
      reason: 'The built-in `--sandbox` is only available on macOS. Use `--sandbox=docker` (or run inside a '
        + 'container/VM) on this platform.',
    };
  }
  if (isContainerRuntimeAvailable(spec.kind)) return { ok: true };
  return {
    ok: false,
    reason: `\`--sandbox=${spec.kind}\` needs the \`${spec.kind}\` CLI on your PATH and its daemon running.`,
  };
}
