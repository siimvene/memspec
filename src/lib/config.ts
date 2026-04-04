export function defaultConfigYaml(): string {
  return `# Memspec configuration
# Files are canonical. Derived indexes are disposable.

classification:
  llm: false
  fallback: rules

decay:
  fact: 90d
  decision: 180d
  procedure: 90d
  observation: 7d

profiles:
  default:
    max_tokens: 2000
    types: [fact, decision, procedure]
    min_confidence: 0.7
    ranking:
      relevance: 0.4
      confidence: 0.3
      recency: 0.3
`;
}
