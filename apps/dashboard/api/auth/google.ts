import { startGoogle } from '../../server/auth.js';

export const GET = (request: Request): Response | Promise<Response> => startGoogle(request);
