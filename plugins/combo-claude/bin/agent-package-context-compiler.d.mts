export interface ContextCompilation {
  protocol: 'combo.agent-context-compilation/1';
  status: 'compiled';
  draft: {
    content: { name: string; description: string; instructions: string; starterPrompts: string[]; outputDescription: string; coverageSummary: string };
    source: { kind: 'codex_available_context' | 'claude_available_context'; verification: 'not_verified'; completeness: 'partial_or_unknown' };
  };
  draftText: string;
  draftFingerprint: string;
  manifestText: string;
  packageDigest: string;
  files: { path: string; content: string; sha256: string; bytes: number }[];
  runtime: { status: 'not_run' };
}
export function compileCreatorAgentPackageFromContext(requestText: unknown): ContextCompilation;
