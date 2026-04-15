import { nanoid } from "nanoid";

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  dependencies: string[];
}

import type { LLMRouter } from "../ai/router.js";

export class TaskPlanner {
  private llmRouter: LLMRouter;

  constructor(llmRouter: LLMRouter) {
    this.llmRouter = llmRouter;
    void this.llmRouter;
  }

  async plan(description: string): Promise<{
    steps: PlanStep[];
    complexity: number;
    needsApproval: boolean;
  }> {
    const delimiters = [
      /\s+then\s+/gi,
      /\s+and\s+then\s+/gi,
      /\s+after\s+that\s*/gi,
      /\s+next[,]\s*/gi,
      /\s+next\s+/gi,
      /\n+/g,
      /;\s*/g,
    ];

    let parts: string[] = [description];
    for (const delimiter of delimiters) {
      const newParts: string[] = [];
      for (const part of parts) {
        const split = part.split(delimiter).map((s) => s.trim()).filter((s) => s.length > 0);
        newParts.push(...split);
      }
      parts = newParts;
    }

    const steps: PlanStep[] = parts.map((part, index) => ({
      id: nanoid(),
      description: part,
      status: "pending" as const,
      dependencies: index > 0 ? [parts.slice(0, index).length > 0 ? "" : ""] : [],
    }));

    for (let i = 1; i < steps.length; i++) {
      steps[i].dependencies = [steps[i - 1].id];
    }

    const stepComplexity = Math.min(steps.length / 5, 1);
    const lengthComplexity = Math.min(description.length / 500, 1);
    const complexity = Math.min((stepComplexity + lengthComplexity) / 2, 1);

    return {
      steps,
      complexity,
      needsApproval: complexity > 0.7,
    };
  }

  async refinePlan(steps: PlanStep[], feedback: string): Promise<PlanStep[]> {
    const feedbackLower = feedback.toLowerCase();
    const keywords = feedbackLower.split(/\s+/).filter((w) => w.length > 3);

    return steps.map((step) => {
      const stepLower = step.description.toLowerCase();
      const isRelevant = keywords.some((kw) => stepLower.includes(kw));

      if (isRelevant && step.status === "pending") {
        return {
          ...step,
          description: `${step.description} [modified: ${feedback.slice(0, 80)}]`,
        };
      }
      return step;
    });
  }
}
