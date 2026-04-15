# Memory System

Octopus AI implements a human-like memory system with Short-Term Memory (STM) and Long-Term Memory (LTM).

## Short-Term Memory (STM)

- Rolling window with configurable token budget (default: 8192)
- Scratch pad for reasoning (2048 tokens)
- Auto-eviction (FIFO) when budget exceeded

## Long-Term Memory (LTM)

- Vector store backend (SQLite-VSS)
- Supports episodic (events) and semantic (facts) memory
- Importance-based storage threshold
- Up to 100,000 items

## Consolidation (STM → LTM)

Automatic consolidation triggered by:
- Task completion
- Idle timeout (30 min)
- Manual trigger

Extracts: facts, events, procedures, and builds associations.

## Memory Decay

- Episodic: 0.3% per day without access
- Semantic: 0.01% per day (very slow)
- Compression: similar episodic memories merged after 30 days
- Max age: 365 days without access

## Knowledge Graph

Associations between memories with:
- Cascade depth: 2 levels
- Cascade threshold: 0.8 similarity
- Bidirectional edges

## Retrieval

Weighted scoring:
- Relevance: 50%
- Recency: 30%
- Frequency: 20%

Minimum relevance: 0.6, max results: 10
