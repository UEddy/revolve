import { handleRpc } from "./_relay.ts";

export function POST(req: Request): Promise<Response> {
  return handleRpc(req, process.env);
}
