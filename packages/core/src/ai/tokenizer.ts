import { encodingForModel } from "js-tiktoken";
import type { LLMMessage } from "./types.js";

const encoding = encodingForModel("gpt-4");

export class TokenCounter {
	countTokens(text: string): number {
		return encoding.encode(text).length;
	}

	countMessagesTokens(messages: LLMMessage[]): number {
		let total = 0;
		for (const message of messages) {
			total += 4;
			total += encoding.encode(message.content).length;
			total += encoding.encode(message.role).length;
			if (message.toolCalls) {
				total += encoding.encode(JSON.stringify(message.toolCalls)).length;
			}
			if (message.toolCallId) {
				total += encoding.encode(message.toolCallId).length;
			}
		}
		total += 2;
		return total;
	}

	estimateTokens(text: string): number {
		return Math.ceil(text.length / 3.5);
	}
}
