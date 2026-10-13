import { codexCall, type Credential, type RelayedRequest } from "../src/codex.ts";
import { errorMessage } from "../src/json.ts";
import type { ModelAnswer } from "../src/protocol.ts";

/** Make a model call the Master relayed, with this machine's own subscription login. */
export async function answerModelRequest(
  id: string,
  request: RelayedRequest,
  credentials: () => Promise<Credential>,
  call: typeof codexCall = codexCall,
): Promise<ModelAnswer> {
  try {
    const result = await call(await credentials(), {
      ...request,
      signal: AbortSignal.timeout(170_000),
    });
    return { type: "model_result", id, result };
  } catch (error) {
    return { type: "model_result", id, error: errorMessage(error) };
  }
}
