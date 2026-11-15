import { googleCallback } from '../../server/auth.js';

export const GET = (request: Request): Response | Promise<Response> => googleCallback(request);
