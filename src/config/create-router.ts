import { IntelligentAgentRouter } from "../orchestrator/agent-router.js";
import { OpenAISemanticAnalyzer } from "../providers/openai-semantic-analyzer.js";

export function createRouter(): IntelligentAgentRouter {
  const enabled = process.env.ENABLE_SEMANTIC_ANALYZER !== "false";
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_ROUTER_MODEL_ID;

  if (enabled && apiKey && model) {
    return new IntelligentAgentRouter({ semanticAnalyzer: new OpenAISemanticAnalyzer(apiKey, model) });
  }

  return new IntelligentAgentRouter();
}
