import { me } from '../../server/auth.js';

export const GET = (request: Request): Response | Promise<Response> => me(request);
