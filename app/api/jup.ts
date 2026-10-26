import { handleJup } from "./_relay.ts";

export function GET(req: Request): Promise<Response> {
  return handleJup(req, process.env);
}

export function POST(req: Request): Promise<Response> {
  return handleJup(req, process.env);
}
