import { handleImg } from "./_relay.ts";

export function GET(req: Request): Promise<Response> {
  return handleImg(req);
}
