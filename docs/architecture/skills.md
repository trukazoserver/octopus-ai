# Skill Forge Engine

The Skill Forge is Octopus AI's system for automatically creating, improving, and managing skills.

## Skill Lifecycle

1. **Detection** — Task analyzer detects when a complex task could benefit from a skill
2. **Creation** — Skill Forge creates a skill with self-critique
3. **Validation** — Quality evaluator scores the skill (1-10)
4. **Storage** — Saved to Skill Registry with embeddings
5. **Loading** — Lazy loaded based on task relevance (progressive levels)
6. **Usage** — Tracked with success/failure metrics
7. **Improvement** — Auto-improved when successRate drops below threshold

## Progressive Loading Levels

| Level | Content | Token Budget |
|-------|---------|-------------|
| 1 | Name + description | ~50 |
| 2 | + Instructions | ~500 |
| 3 | + Examples | ~1500 |
| 4 | + Templates + anti-patterns | ~3000 |

## Auto-Improvement Criteria

- Success rate < 70%
- Average user rating < 3.5
- Every 10 uses
- Last improved > 30 days ago

## A/B Testing

Major changes undergo A/B testing with configurable sample size (default: 20 uses).
